import { refreshAccessToken } from './oauth';
import { loadVault, upsertAccount } from './secrets';

/**
 * Google Calendar API 薄客户端(M6c-1)。只在主进程使用;access_token 自动刷新,
 * 401 自动重试一次。不引入 googleapis SDK —— REST 面很小,手写 fetch 与本仓
 * "手写 SQL" 的取向一致,也少一个几十 MB 的依赖。
 */

const BASE = 'https://www.googleapis.com/calendar/v3';
/** access_token 提前 60s 视为过期,避免边界上刚好失效 */
const SKEW_MS = 60_000;

export class GoogleNotConnectedError extends Error {
  constructor(message = '尚未连接 Google 账号') {
    super(message);
    this.name = 'GoogleNotConnectedError';
  }
}

/** 低层调用:显式带 access_token(授权刚完成、还不知道账号邮箱时也能用)。 */
async function rawGet<T>(
  token: string,
  path: string,
  params: Record<string, string> = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; body: string }> {
  const qs = Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
  const res = await fetch(`${BASE}${path}${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { ok: false, status: res.status, body: (await res.text()).slice(0, 300) };
  return { ok: true, data: (await res.json()) as T };
}

/** 取指定账号的可用 access_token;必要时刷新并回写保险箱。 */
async function accessTokenFor(
  email: string,
): Promise<{ token: string; refresh: () => Promise<string> }> {
  const vault = await loadVault();
  const { credentials } = vault;
  const account = vault.accounts.find((a) => a.email === email);
  if (!credentials || !account) throw new GoogleNotConnectedError(`账号未连接: ${email}`);

  const refresh = async (): Promise<string> => {
    const fresh = await refreshAccessToken(credentials, account.refreshToken);
    await upsertAccount({ ...account, accessToken: fresh.accessToken, expiresAt: fresh.expiresAt });
    return fresh.accessToken;
  };
  const usable =
    account.accessToken !== null &&
    account.expiresAt !== null &&
    account.expiresAt - SKEW_MS > Date.now();
  return { token: usable ? account.accessToken! : await refresh(), refresh };
}

/** 带鉴权的 GET;401 时刷新一次再试(服务端可能提前作废 token)。 */
async function apiGet<T>(
  email: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const { token, refresh } = await accessTokenFor(email);
  let r = await rawGet<T>(token, path, params);
  if (!r.ok && r.status === 401) r = await rawGet<T>(await refresh(), path, params);
  if (!r.ok) throw new Error(`Google API ${path} 失败(${r.status})— ${r.body}`);
  return r.data;
}

export interface GoogleCalendarEntry {
  id: string;
  summary: string;
  primary: boolean;
  backgroundColor: string | null;
  accessRole: string;
  selected: boolean;
}

interface CalendarListResponse {
  items?: {
    id: string;
    summary?: string;
    summaryOverride?: string;
    primary?: boolean;
    backgroundColor?: string;
    accessRole?: string;
    selected?: boolean;
  }[];
}

/**
 * 用户订阅的日历列表。注意是 `/users/me/calendarList`(`/calendars` 集合没有 list 方法,
 * 只能对单个日历 get/insert/patch)。
 */
export async function listCalendars(email: string): Promise<GoogleCalendarEntry[]> {
  const data = await apiGet<CalendarListResponse>(email, '/users/me/calendarList', {
    minAccessRole: 'reader',
    showHidden: 'true',
  });
  return (data.items ?? []).map((c) => ({
    id: c.id,
    summary: c.summaryOverride ?? c.summary ?? c.id,
    primary: c.primary === true,
    backgroundColor: c.backgroundColor ?? null,
    accessRole: c.accessRole ?? 'reader',
    selected: c.selected === true,
  }));
}

/**
 * 已连接账号的邮箱 = primary 日历的 id。这样就不必多要 `userinfo.email` scope
 * (授权页少一项、也少一类个人数据)。
 */
/** 刚授权完还不知道账号是谁:用拿到的 access_token 直接问 primary 日历(它的 id 即邮箱)。 */
export async function primaryEmailWithToken(token: string): Promise<string | null> {
  const r = await rawGet<CalendarListResponse>(token, '/users/me/calendarList', {
    minAccessRole: 'owner',
    maxResults: '250',
  });
  if (!r.ok) return null;
  return r.data.items?.find((c) => c.primary === true)?.id ?? null;
}

export interface GoogleEvent {
  /** 实例 id:全天事件逐日展开后带日期后缀,保证每天一条镜像 */
  id: string;
  /** **Google 的原始事件 id**:与 pushedEventId 对账必须用这个(展开后的 id 对不上) */
  sourceEventId: string;
  calendarId: string;
  summary: string;
  /** 全天事件为 null */
  startTime: string | null;
  endTime: string | null;
  /** 本地日期(全天事件按逐日展开后的那一天) */
  date: string;
  htmlLink: string | null;
}

interface EventsResponse {
  items?: {
    id: string;
    summary?: string;
    status?: string;
    htmlLink?: string;
    start?: { date?: string; dateTime?: string };
    end?: { date?: string; dateTime?: string };
  }[];
  nextPageToken?: string;
}

/**
 * RFC3339 → 日期与 HH:MM(D-27/INV-31)。
 * - `zone` 为空(**浮动时间**)→ 直接取字符串里的**字面墙上时间**,不做任何换算:
 *   浮动的含义就是"墙上几点就是几点",换算反而会在旅行时把它挪走;
 * - `zone` 指定 → 把该绝对时刻换算到那个时区的墙上时间。
 */
function localParts(dateTime: string, zone: string | null): { date: string; time: string } {
  if (zone === null) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(dateTime);
    if (m) return { date: m[1]!, time: m[2]! };
  }
  const d = new Date(dateTime);
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...(zone !== null ? { timeZone: zone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`,
  };
}
const addDays = (iso: string, n: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

/**
 * 取某日期区间内的事件(只读展示用,M6c-2)。
 * - `singleEvents=true`:把重复事件展开成实例,否则拿到的是未展开的母体;
 * - 全天事件的 `end.date` 是**独占**的,逐日展开时要减一天;
 * - 已取消(status=cancelled)的实例跳过。
 */
export async function listEvents(
  email: string,
  calendarIds: string[],
  fromDate: string,
  toDate: string,
): Promise<GoogleEvent[]> {
  const timeMin = new Date(`${fromDate}T00:00:00`).toISOString();
  const timeMax = new Date(`${addDays(toDate, 1)}T00:00:00`).toISOString();
  const out: GoogleEvent[] = [];
  for (const calendarId of calendarIds) {
    let pageToken: string | undefined;
    do {
      const data: EventsResponse = await apiGet<EventsResponse>(
        email,
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          timeMin,
          timeMax,
          singleEvents: 'true',
          maxResults: '250',
          ...(pageToken !== undefined ? { pageToken } : {}),
        },
      );
      for (const ev of data.items ?? []) {
        if (ev.status === 'cancelled') continue;
        const summary = ev.summary ?? '(无标题)';
        if (ev.start?.dateTime !== undefined && ev.end?.dateTime !== undefined) {
          const s = localParts(ev.start.dateTime, null);
          const e = localParts(ev.end.dateTime, null);
          out.push({
            id: ev.id,
            sourceEventId: ev.id,
            calendarId,
            summary,
            startTime: s.time,
            // 跨日事件在起始日按到 24:00 呈现(网格不跨午夜,INV-28)
            endTime: e.date === s.date ? e.time : '24:00',
            date: s.date,
            htmlLink: ev.htmlLink ?? null,
          });
        } else if (ev.start?.date !== undefined && ev.end?.date !== undefined) {
          // end.date 独占 → 逐日展开到 end-1
          for (let d = ev.start.date; d < ev.end.date; d = addDays(d, 1)) {
            if (d < fromDate || d > toDate) continue;
            out.push({
              id: `${ev.id}:${d}`,
              sourceEventId: ev.id,
              calendarId,
              summary,
              startTime: null,
              endTime: null,
              date: d,
              htmlLink: ev.htmlLink ?? null,
            });
          }
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken !== undefined);
  }
  return out;
}

// ---------------------------------------------------------------- 写(专用日历)

/** 带鉴权的写请求(POST/PATCH/DELETE);401 自动刷新重试一次。 */
async function apiWrite<T>(
  email: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T | null> {
  const { token, refresh } = await accessTokenFor(email);
  const call = async (t: string): Promise<Response> =>
    fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  let res = await call(token);
  if (res.status === 401) res = await call(await refresh());
  // 删除已不存在的事件:410/404 视为成功(幂等)
  if (method === 'DELETE' && (res.status === 410 || res.status === 404)) return null;
  if (!res.ok) {
    throw new Error(
      `Google API ${method} ${path} 失败(${res.status})— ${(await res.text()).slice(0, 300)}`,
    );
  }
  return res.status === 204 ? null : ((await res.json()) as T);
}

/**
 * 找到(或创建)本应用的专用日历。用 `calendar.app.created` scope 创建的次级日历,
 * 创建后自动出现在用户的日历列表里,无需再调 calendarList.insert。
 */
export async function ensureAppCalendar(email: string, summary: string): Promise<string> {
  const list = await listCalendars(email);
  const hit = list.find((c) => c.summary === summary);
  if (hit) return hit.id;
  const created = await apiWrite<{ id: string }>(email, 'POST', '/calendars', {
    summary,
    description: 'Claudoist 任务(在此日历里拖动/删除会同步回任务)',
  });
  if (!created?.id) throw new Error('创建专用日历失败');
  return created.id;
}

export interface PushEventInput {
  taskId: string;
  title: string;
  date: string;
  startTime: string | null;
  durationMinutes: number | null;
  /** null = 浮动时间:不带时区字段,由该日历的默认时区解释(最接近"墙上时间不变") */
  timeZone: string | null;
  done: boolean;
}

const addDaysLocal = (iso: string, n: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

/** 任务 → 事件体。全天用 date(end 独占 +1 天);定时用 dateTime + 本地时区。 */
function eventBody(input: PushEventInput): Record<string, unknown> {
  const summary = `${input.done ? '✓ ' : ''}${input.title}`;
  // taskId 存 private 扩展属性:Google 侧改动回同步时据此找回本地任务
  const extendedProperties = { private: { claudoistTaskId: input.taskId } };
  if (input.startTime === null) {
    return {
      summary,
      start: { date: input.date },
      end: { date: addDaysLocal(input.date, 1) },
      extendedProperties,
    };
  }
  const mins = input.durationMinutes ?? 30;
  const [h, m] = input.startTime.split(':').map(Number);
  const startMin = (h ?? 0) * 60 + (m ?? 0);
  const endTotal = startMin + mins;
  // 跨午夜滚到次日,而不是钳到 23:59 —— 钳了之后回拉会把时长静默改小
  const endDate = endTotal >= 1440 ? addDaysLocal(input.date, 1) : input.date;
  const endMin = endTotal % 1440;
  const hhmm = (x: number): string =>
    `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
  // 浮动时间不带 timeZone:Google 会用该日历的默认时区解释,墙上时间即用户所见
  const tz = input.timeZone !== null ? { timeZone: input.timeZone } : {};
  return {
    summary,
    start: { dateTime: `${input.date}T${input.startTime}:00`, ...tz },
    end: { dateTime: `${endDate}T${hhmm(endMin)}:00`, ...tz },
    extendedProperties,
  };
}

export async function insertEvent(
  email: string,
  calendarId: string,
  input: PushEventInput,
): Promise<string> {
  const ev = await apiWrite<{ id: string }>(
    email,
    'POST',
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    eventBody(input),
  );
  if (!ev?.id) throw new Error('创建事件失败');
  return ev.id;
}

export async function patchEvent(
  email: string,
  calendarId: string,
  eventId: string,
  input: PushEventInput,
): Promise<void> {
  await apiWrite(
    email,
    'PATCH',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    eventBody(input),
  );
}

export async function deleteEvent(
  email: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  await apiWrite(
    email,
    'DELETE',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  );
}

/**
 * 读单个事件:回同步判断"是不是真被删了"用。
 * 返回 null = 404/410(确已删除);`cancelled` = Google 侧的软删标记。
 */
export async function getEvent(
  email: string,
  calendarId: string,
  eventId: string,
  /** 任务的时区(null = 浮动:读字面墙上时间) */
  zone: string | null = null,
): Promise<{
  cancelled: boolean;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
} | null> {
  const { token, refresh } = await accessTokenFor(email);
  const path = `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  let r = await rawGet<{
    status?: string;
    start?: { date?: string; dateTime?: string };
    end?: { date?: string; dateTime?: string };
  }>(token, path);
  if (!r.ok && r.status === 401) r = await rawGet(await refresh(), path);
  if (!r.ok) {
    if (r.status === 404 || r.status === 410) return null;
    throw new Error(`Google API GET ${path} 失败(${r.status})— ${r.body}`);
  }
  const ev = r.data;
  if (ev.status === 'cancelled')
    return { cancelled: true, date: null, startTime: null, endTime: null };
  if (ev.start?.dateTime !== undefined && ev.end?.dateTime !== undefined) {
    const a = localParts(ev.start.dateTime, zone);
    const b = localParts(ev.end.dateTime, zone);
    return {
      cancelled: false,
      date: a.date,
      startTime: a.time,
      endTime: b.date === a.date ? b.time : '24:00',
    };
  }
  return { cancelled: false, date: ev.start?.date ?? null, startTime: null, endTime: null };
}
