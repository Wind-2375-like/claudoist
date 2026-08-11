import { dialog, ipcMain } from 'electron';
import { readFileSync } from 'node:fs';
import type { GoogleCalendarVM, GoogleStatusVM, WriteResultVM } from '../../shared/viewModels';
import {
  applyPulledEvents,
  externalKey,
  isUsecaseError,
  planPush,
  recordPushed,
  syncExternalTasks,
} from '@gtd/domain';
import type { Command, FlowDeps, GtdStore } from '@gtd/domain';
import { settingsStore } from '../db';
import {
  deleteEvent,
  ensureAppCalendar,
  getEvent,
  insertEvent,
  listCalendars,
  listEvents,
  patchEvent,
  primaryEmailWithToken,
} from '../google/api';
import { authorize, revokeToken } from '../google/oauth';
import {
  clearVault,
  encryptionAvailable,
  loadVault,
  removeAccount,
  saveVault,
  upsertAccount,
  type GoogleCredentials,
} from '../google/secrets';

/**
 * Google 连接通道(M6c-1 / M6c-2b 多账号)。渲染进程只能触发动作与读状态,
 * **永远拿不到** client_secret 与 token(它们只在主进程与加密文件之间流动)。
 *
 * 多账号的由来:学校 Workspace 常同时禁掉"对外共享日历"与"密钥 iCal 地址",
 * 于是把工作账号也直接连上是唯一不依赖管理员的办法(2026-08-10 用户定案)。
 */

const failed = (e: unknown): WriteResultVM => ({
  error: e instanceof Error ? e.message : String(e),
});

/**
 * 本地显示态:**逐项覆盖表** `{ "邮箱::日历id": true|false }`,只记录用户手动改过的项,
 * 未记录的回落到 Google 侧订阅态(`selected`)。
 *
 * 这里曾用"白名单数组 + null 表示未设置":第一次点任一眼睛时会从空集开始增删,
 * 于是存下一个空白名单 —— **所有日历一次性全灭**(2026-08-10 用户复现)。覆盖表没有
 * 这个陷阱:一次点击只写一个键,也不会影响后续新连账号里的日历。
 * 键必须带账号:不同账号下同一个节日日历的 id 相同,否则两边会被一起开关。
 */
const VIS_KEY = 'google.calendarVisibility';
const shownKey = (email: string, calendarId: string): string => `${email}::${calendarId}`;
const visibility = (): Record<string, boolean> =>
  settingsStore().get<Record<string, boolean>>(VIS_KEY) ?? {};

/** 从下载的 credentials JSON 里取 client_id/secret(desktop client 是 `installed` 键)。 */
function parseCredentialsFile(path: string): GoogleCredentials {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    installed?: { client_id?: string; client_secret?: string };
    web?: { client_id?: string; client_secret?: string };
  };
  const node = raw.installed ?? raw.web;
  const clientId = node?.client_id;
  const clientSecret = node?.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error('这个 JSON 里没有 client_id/client_secret —— 请选 Google 控制台下载的凭据文件');
  }
  if (!raw.installed) {
    throw new Error('这是 Web 类型的 client;桌面端需要 “Desktop app” 类型(回环回调)');
  }
  return { clientId, clientSecret };
}

/** 合并所有账号的日历列表(带账号归属与本地显示态)。单账号失败不影响其它账号。 */
async function mergedCalendars(): Promise<{ list: GoogleCalendarVM[]; failedAccounts: number }> {
  const vault = await loadVault();
  const vis = visibility();
  const appCalId = settingsStore().get<string>(APP_CAL_KEY);
  const out: GoogleCalendarVM[] = [];
  let failedAccounts = 0;
  for (const account of vault.accounts) {
    try {
      const list = await listCalendars(account.email);
      for (const c of list) {
        // 专用 Claudoist 日历是本应用的**写入面**,不能同时当镜像源 ——
        // 否则我们推上去的事件会被再镜像成一个重复的只读任务(评审 HIGH)
        if (appCalId !== null && c.id === appCalId) continue;
        const key = shownKey(account.email, c.id);
        out.push({
          ...c,
          accountEmail: account.email,
          // 没手动改过 → 沿用 Google 侧的订阅勾选
          shown: vis[key] ?? c.selected,
        });
      }
    } catch (e) {
      console.error(`[google] 读取 ${account.email} 的日历列表失败:`, e);
      failedAccounts += 1;
    }
  }
  return { list: out, failedAccounts };
}

export function registerGoogleIpc(store: GtdStore, deps: FlowDeps, onChanged: () => void): void {
  ipcMain.handle('google:status', async (): Promise<GoogleStatusVM> => {
    const vault = await loadVault();
    return {
      hasCredentials: vault.credentials !== null,
      connected: vault.accounts.length > 0,
      accounts: vault.accounts.map((a) => ({ email: a.email })),
      encryptionAvailable: await encryptionAvailable(),
      pushEnabled: settingsStore().get<boolean>(PUSH_KEY) === true,
      pushCalendarName: APP_CALENDAR_NAME,
      pushedCount: store.snapshot().tasks.filter((t) => t.pushedEventId !== null).length,
    };
  });

  ipcMain.handle('google:credentials.import', async (): Promise<WriteResultVM> => {
    try {
      const picked = await dialog.showOpenDialog({
        title: '选择 Google OAuth 凭据 JSON(Desktop app)',
        properties: ['openFile'],
        filters: [{ name: 'Credentials JSON', extensions: ['json'] }],
      });
      const path = picked.filePaths[0];
      if (picked.canceled || path === undefined) return { consequences: { imported: false } };
      const credentials = parseCredentialsFile(path);
      // 换 client 视同换应用:所有旧授权都不再适用
      await saveVault({ credentials, accounts: [] });
      return { consequences: { imported: true } };
    } catch (e) {
      return failed(e);
    }
  });

  /** 连接(可重复调用以添加多个账号;同一账号再连 = 刷新其凭据)。 */
  ipcMain.handle('google:connect', async (): Promise<WriteResultVM> => {
    try {
      const vault = await loadVault();
      if (!vault.credentials) throw new Error('请先导入 credentials JSON');
      const tokens = await authorize(vault.credentials);
      // 账号身份取 primary 日历 id(即邮箱),不必多要 userinfo scope
      const email =
        tokens.accessToken !== null
          ? await primaryEmailWithToken(tokens.accessToken).catch(() => null)
          : null;
      if (email === null) {
        throw new Error('已授权但读不到账号信息(可能未授予日历权限)—— 请重试并同意全部权限');
      }
      await upsertAccount({ ...tokens, email });
      return { consequences: { email } };
    } catch (e) {
      return failed(e);
    }
  });

  ipcMain.handle(
    'google:disconnect',
    async (_e, payload: { email?: string }): Promise<WriteResultVM> => {
      try {
        const vault = await loadVault();
        if (payload.email === undefined) {
          // 全部断开:逐个撤销后清空保险箱(含 client 凭据)
          for (const a of vault.accounts) await revokeToken(a.refreshToken);
          clearVault();
          return { consequences: { disconnected: 'all' } };
        }
        const account = vault.accounts.find((a) => a.email === payload.email);
        if (account) await revokeToken(account.refreshToken);
        await removeAccount(payload.email);
        return { consequences: { disconnected: payload.email } };
      } catch (e) {
        return failed(e);
      }
    },
  );

  ipcMain.handle(
    'google:calendars',
    async (): Promise<GoogleCalendarVM[]> => (await mergedCalendars()).list,
  );

  /**
   * 开/关"把任务推送到专用 Claudoist 日历"。关闭时可一并撤下已推送的事件 ——
   * 留着不管会变成永不更新的僵尸事件。
   */
  ipcMain.handle(
    'google:push.setEnabled',
    async (_e, payload: { enabled: boolean; purge: boolean }): Promise<WriteResultVM> => {
      try {
        const settings = settingsStore();
        settings.set(PUSH_KEY, payload.enabled);
        if (payload.enabled || !payload.purge)
          return { consequences: { enabled: payload.enabled } };

        const r = await purgeAppCalendar(store, onChanged);
        return { consequences: { enabled: false, ...r } };
      } catch (e) {
        return failed(e);
      }
    },
  );

  ipcMain.handle(
    'google:calendars.setShown',
    (_e, payload: { accountEmail: string; id: string; shown: boolean }): WriteResultVM => {
      // 只写这一个键,其余日历不受影响
      const next = { ...visibility(), [shownKey(payload.accountEmail, payload.id)]: payload.shown };
      settingsStore().set(VIS_KEY, next);
      return { consequences: { shown: payload.shown } };
    },
  );

  /**
   * 拉取窗口内事件并**镜像成本地任务**(D-25/INV-29)。外部事件不再是"只读展示层",
   * 而是真正的任务:可完成、可加标签/子任务/评论;只有标题与时间归 Google 拥有。
   * 本地的任何改动都不回写 Google。
   */
  /** 单独清空专用日历(**不必开启推送**即可清理历史残留)。 */
  ipcMain.handle('google:push.purge', async (): Promise<WriteResultVM> => {
    try {
      return { consequences: await purgeAppCalendar(store, onChanged) };
    } catch (e) {
      return failed(e);
    }
  });

  /**
   * 只读复查:专用日历里**当前实际**还有多少事件。
   *
   * 必须与 status.pushedCount 区分开 —— 后者只数本地指针,清理一执行必然归零,
   * 因此它从来不能证明 Google 那边真的干净了。
   */
  ipcMain.handle('google:push.inspect', async (): Promise<WriteResultVM> => {
    try {
      const r = await inspectAppCalendar();
      return {
        consequences: { connected: r.connected, count: r.events.length, account: r.account },
      };
    } catch (e) {
      return failed(e);
    }
  });

  ipcMain.handle(
    'google:sync',
    async (_e, payload: { from: string; to: string }): Promise<WriteResultVM> => {
      // 串行化:Today 与 Calendar 视图会各挂一个轮询,并发跑同一批推送会重复建事件
      if (syncing !== null) return syncing;
      syncing = (async (): Promise<WriteResultVM> => {
        try {
          const merged = await mergedCalendars();
          const calendars = merged.list.filter((c) => c.shown);
          const snap = store.snapshot();
          const contextId = [...snap.contexts]
            .filter((c) => !c.archived)
            .sort((a, b) => a.sortOrder - b.sortOrder)[0]?.id;
          if (contextId === undefined) return { error: '没有可用 context' };

          const events: Parameters<typeof syncExternalTasks>[2]['events'] = [];
          // 只有**成功拉取**的日历才参与"退休"判定;任何失败都不得被当成"日历空了"
          const fetchedCalendarIds: string[] = [];
          const byAccount = new Map<string, typeof calendars>();
          for (const c of calendars) {
            byAccount.set(c.accountEmail, [...(byAccount.get(c.accountEmail) ?? []), c]);
          }
          for (const [email, cals] of byAccount) {
            try {
              const got = await listEvents(
                email,
                cals.map((c) => c.id),
                payload.from,
                payload.to,
              );
              fetchedCalendarIds.push(...cals.map((c) => c.id));
              for (const ev of got) {
                events.push({
                  externalId: externalKey('google', email, ev.calendarId, ev.id),
                  externalCalendarId: ev.calendarId,
                  title: ev.summary,
                  scheduledDate: ev.date,
                  startTime: ev.startTime,
                  durationMinutes:
                    ev.startTime !== null && ev.endTime !== null
                      ? Math.max(1, minutesBetween(ev.startTime, ev.endTime))
                      : null,
                });
              }
            } catch (err) {
              console.error(`[google] 读取 ${email} 的事件失败:`, err);
            }
          }

          const r = syncExternalTasks(snap, deps, {
            fromDate: payload.from,
            toDate: payload.to,
            events,
            // 账号级失败也算"有日历没拉到" → 整轮跳过退休
            fetchedCalendarIds: merged.failedAccounts > 0 ? [] : fetchedCalendarIds,
            contextId,
          });
          if (isUsecaseError(r)) return { error: r.error };
          if (r.commands.length > 0) {
            store.apply(r.commands as Command[], 'agent');
            onChanged();
          }

          // ---- 任务 → 专用 Claudoist 日历(D-26/INV-30)----
          const pushStats = await pushToAppCalendar(store, deps, onChanged, payload);
          return { consequences: { ...r.consequences, ...pushStats } };
        } catch (e) {
          return failed(e);
        } finally {
          syncing = null;
        }
      })();
      return syncing;
    },
  );
}

/** 同一时刻只允许一轮同步(Today 与 Calendar 各挂一个轮询,并发会重复建事件)。 */
let syncing: Promise<WriteResultVM> | null = null;

/** `HH:MM` 差值(分钟);`24:00` 视为 1440。 */
function minutesBetween(start: string, end: string): number {
  const toMin = (t: string): number => {
    if (t === '24:00') return 1440;
    const [h, m] = t.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return toMin(end) - toMin(start);
}

/** 专用日历名(用户在 Google 里看到的名字);其 id 缓存在 settings。 */
const APP_CALENDAR_NAME = 'Claudoist';
const APP_CAL_KEY = 'google.appCalendarId';
/** 专用日历归属的账号邮箱 —— 多账号下 accounts[0] 会变,不能用它推断 */
const APP_CAL_ACCOUNT_KEY = 'google.appCalendarAccount';
/**
 * 是否把任务推送到专用日历。**默认关闭** —— 往用户的 Google 账号里写东西必须是
 * 显式选择(2026-08-10:此前常开,用户发现账号里凭空多了一个日历)。
 */
const PUSH_KEY = 'google.pushEnabled';

/**
 * 任务 → 专用日历的推送 + 该日历上改动的回同步(D-26/INV-30)。
 * 推送只发生在**第一个已连接账号**上(专用日历属于"我的任务",不需要每个账号一份)。
 */
async function pushToAppCalendar(
  store: GtdStore,
  deps: FlowDeps,
  onChanged: () => void,
  window: { from: string; to: string },
): Promise<Record<string, number>> {
  const settings = settingsStore();
  if (settings.get<boolean>(PUSH_KEY) !== true) return {}; // 未开启 → 一个字节都不往 Google 写
  const vault = await loadVault();
  const account = vault.accounts[0];
  if (!account) return {};

  let calendarId = settings.get<string>(APP_CAL_KEY);
  // 归属账号与日历 id 一起记:日后清理/复查要按创建者账号去调,accounts[0] 会变
  const remember = (id: string): void => {
    settings.set(APP_CAL_KEY, id);
    settings.set(APP_CAL_ACCOUNT_KEY, account.email);
  };
  if (calendarId === null) {
    calendarId = await ensureAppCalendar(account.email, APP_CALENDAR_NAME);
    remember(calendarId);
  } else {
    // 缓存的日历可能已被用户在 Google 里删掉 → 重新确保一次,否则整个同步永久静默停摆
    try {
      await listEvents(account.email, [calendarId], window.from, window.from);
      if (settings.get<string>(APP_CAL_ACCOUNT_KEY) === null) remember(calendarId);
    } catch {
      calendarId = await ensureAppCalendar(account.email, APP_CALENDAR_NAME);
      remember(calendarId);
    }
  }

  // 1) 先把 Google 侧对这些 block 的改动拉回来(用户在那边拖过/删过)
  let pulled = 0;
  let removed = 0;
  try {
    const evs = await listEvents(account.email, [calendarId], window.from, window.to);
    const snap = store.snapshot();
    // **用 Google 原始事件 id 对账**:全天事件在 listEvents 里被展开成 `id:日期`,
    // 拿它跟 pushedEventId 比必然对不上 —— 每个全天任务推上去后会被自己判成"已删除"
    const seen = new Set(evs.map((e) => e.sourceEventId));
    const pulledEvents: Parameters<typeof applyPulledEvents>[2] = evs.map((e) => ({
      eventId: e.sourceEventId,
      taskId: null,
      cancelled: false,
      date: e.date,
      startTime: e.startTime,
      durationMinutes:
        e.startTime !== null && e.endTime !== null
          ? Math.max(1, minutesBetween(e.startTime, e.endTime))
          : null,
    }));

    // 推过、但本轮窗口里没看见的:**不能据此断定被删** —— 用户可能只是把 block 拖出了
    // 当前窗口(Today 视图窗口只有一天)。逐个 GET 实证:404/410/cancelled 才算删除,
    // 否则按它的新位置改期。查不动就什么都不做,绝不猜"被删了"。
    for (const t of snap.tasks) {
      if (t.pushedEventId === null || seen.has(t.pushedEventId)) continue;
      if (t.status === 'deleted') continue;
      try {
        const got = await getEvent(account.email, calendarId, t.pushedEventId, t.timeZone);
        pulledEvents.push(
          got === null || got.cancelled
            ? {
                eventId: t.pushedEventId,
                taskId: null,
                cancelled: true,
                date: null,
                startTime: null,
                durationMinutes: null,
              }
            : {
                eventId: t.pushedEventId,
                taskId: null,
                cancelled: false,
                date: got.date,
                startTime: got.startTime,
                durationMinutes:
                  got.startTime !== null && got.endTime !== null
                    ? Math.max(1, minutesBetween(got.startTime, got.endTime))
                    : null,
              },
        );
      } catch (err) {
        console.error(`[google] 核查事件 ${t.pushedEventId} 失败:`, err);
      }
    }

    const applied = applyPulledEvents(snap, deps, pulledEvents);
    if (!isUsecaseError(applied) && applied.commands.length > 0) {
      store.apply(applied.commands as Command[], 'agent');
      onChanged();
      pulled = applied.consequences.rescheduled;
      removed = applied.consequences.deleted;
    }
  } catch (e) {
    console.error('[google] 专用日历回同步失败:', e);
  }

  // 2) 再把本地变化推上去
  const plan = planPush(store.snapshot());
  const results: { taskId: string; eventId: string | null; fingerprint: string | null }[] = [];
  for (const item of plan.upsert) {
    try {
      const payload = {
        taskId: item.taskId,
        title: item.title,
        date: item.date,
        startTime: item.startTime,
        durationMinutes: item.durationMinutes,
        timeZone: item.timeZone,
        done: item.done,
      };
      if (item.eventId === null) {
        const id = await insertEvent(account.email, calendarId, payload);
        results.push({ taskId: item.taskId, eventId: id, fingerprint: item.fingerprint });
      } else {
        await patchEvent(account.email, calendarId, item.eventId, payload);
        results.push({ taskId: item.taskId, eventId: item.eventId, fingerprint: item.fingerprint });
      }
    } catch (e) {
      console.error(`[google] 推送任务 ${item.taskId} 失败:`, e);
    }
  }
  for (const item of plan.remove) {
    try {
      await deleteEvent(account.email, calendarId, item.eventId);
      results.push({ taskId: item.taskId, eventId: null, fingerprint: null });
    } catch (e) {
      console.error(`[google] 撤下事件 ${item.eventId} 失败:`, e);
    }
  }
  if (results.length > 0) {
    store.apply(recordPushed(results), 'agent');
    onChanged();
  }
  return { pushed: plan.upsert.length, unpushed: plan.remove.length, pulled, removed };
}

/**
 * 解析专用日历的目标账号 + 日历 id。
 *
 * 账号必须显式存下来:多账号下 `accounts[0]` 未必是当初创建该日历的那个账号
 * (顺序会随连接/断开变化),拿错账号会让每次删除都 404 —— 而旧实现照样把本地
 * 指针清掉,事件就此失联。老装机没有这个键,回落到首个账号。
 */
async function appCalendarTarget(): Promise<{ email: string; calendarId: string } | null> {
  const settings = settingsStore();
  const calendarId = settings.get<string>(APP_CAL_KEY);
  if (calendarId === null) return null;
  const vault = await loadVault();
  if (vault.accounts.length === 0) return null;
  const owner = settings.get<string>(APP_CAL_ACCOUNT_KEY);
  const hit = owner !== null ? vault.accounts.find((a) => a.email === owner) : undefined;
  const account = hit ?? vault.accounts[0];
  return account ? { email: account.email, calendarId } : null;
}

/** 专用日历里现存事件的**原始** id(全天事件在 listEvents 里被展开成 `id:日期`,须去重)。 */
async function appCalendarEventIds(target: {
  email: string;
  calendarId: string;
}): Promise<string[]> {
  // 该日历只有我们写,窗口开到最大即可枚举全部;去重后即真实事件数
  const evs = await listEvents(target.email, [target.calendarId], '2000-01-01', '2100-01-01');
  return [...new Set(evs.map((e) => e.sourceEventId))];
}

/**
 * 只读复查专用日历的真实内容(设置页"检查"按钮与 `--dump=google` 共用)。
 * 与 `status.pushedCount` 的区别见 `google:push.inspect` 的注释。
 */
export async function inspectAppCalendar(): Promise<{
  connected: boolean;
  account: string | null;
  calendarId: string | null;
  events: { id: string; summary: string; date: string; startTime: string | null }[];
}> {
  const target = await appCalendarTarget();
  if (target === null) {
    return { connected: false, account: null, calendarId: null, events: [] };
  }
  const evs = await listEvents(target.email, [target.calendarId], '2000-01-01', '2100-01-01');
  const seen = new Set<string>();
  const events = evs
    .filter((e) => !seen.has(e.sourceEventId) && seen.add(e.sourceEventId))
    .map((e) => ({
      id: e.sourceEventId,
      summary: e.summary,
      date: e.date,
      startTime: e.startTime,
    }));
  return { connected: true, account: target.email, calendarId: target.calendarId, events };
}

/**
 * 清空专用日历:**以日历里实际存在的事件为准**枚举后删除,再复查一遍。
 *
 * 旧实现按本地 `pushedEventId` 逐条删,且无论删成没删成都把指针清空 —— 于是
 * (a) 任何一次删除失败都会留下再也定位不到的僵尸事件;(b) 账号/日历解析不到时
 * 一个都没删,却同样清空指针、横幅消失,看起来"干净了"。现在:枚举 → 删除 →
 * 复查,只对**复查后确认已不存在**的事件清指针;解析不到目标直接报错,不动本地。
 */
async function purgeAppCalendar(
  store: GtdStore,
  onChanged: () => void,
): Promise<{ removed: number; remaining: number }> {
  const target = await appCalendarTarget();
  if (target === null) {
    throw new Error('找不到专用日历(未连接账号,或日历尚未创建)—— 未改动任何本地记录');
  }
  const before = await appCalendarEventIds(target);
  for (const id of before) {
    try {
      await deleteEvent(target.email, target.calendarId, id); // 410/404 幂等成功
    } catch (err) {
      console.error(`[google] 撤下事件失败 ${id}:`, err);
    }
  }
  // 复查:删除结果以 Google 的实际状态为准,不以调用是否抛错为准
  const after = new Set(await appCalendarEventIds(target));
  const cleared = store
    .snapshot()
    .tasks.filter((t) => t.pushedEventId !== null && !after.has(t.pushedEventId));
  if (cleared.length > 0) {
    store.apply(
      recordPushed(cleared.map((t) => ({ taskId: t.id, eventId: null, fingerprint: null }))),
      'agent',
    );
    onChanged();
  }
  return { removed: before.length - after.size, remaining: after.size };
}
