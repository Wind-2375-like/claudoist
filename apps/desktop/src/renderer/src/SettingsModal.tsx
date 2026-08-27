import { useState } from 'react';
import { useGoogleCalendars, useGoogleStatus } from './hooks';
import { AppearanceSettings } from './AppearanceSettings';
import { toast } from './toast';

/**
 * 设置弹窗(M6c-1)。目前只有 Calendars 一节:连接 Google 账号、查看日历列表、断开。
 * 凭据与 token 全程只在主进程流转,这里只触发动作、读状态。
 */
export function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<'calendars' | 'appearance'>('calendars');
  const status = useGoogleStatus();
  const calendars = useGoogleCalendars(status.data?.connected === true);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * `ok` 用于**成功也要回执**的动作(清理/复查):这类操作的效果在别人的账号里,
   * 界面上看不见 —— 没有回执就无从判断它到底做了什么(2026-08-11:清理按下后
   * 无任何提示,横幅又只按本地指针消失,导致"删没删掉"不可知)。
   */
  const run = async (
    label: string,
    fn: () => Promise<{ error: string } | unknown>,
    ok?: (consequences: Record<string, unknown>) => string,
  ): Promise<void> => {
    setBusy(label);
    try {
      const r = (await fn()) as { error?: string; consequences?: Record<string, unknown> };
      if (r && typeof r === 'object' && 'error' in r && r.error) toast(r.error);
      else if (ok) toast(ok(r?.consequences ?? {}));
    } finally {
      setBusy(null);
      await status.refetch();
      await calendars.refetch();
    }
  };

  const s = status.data;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-16">
      <div className="flex max-h-[80vh] w-[640px] max-w-[95vw] flex-col rounded-xl border border-line bg-raised shadow-2xl">
        <div className="flex items-center gap-1 border-b border-line-soft px-5 py-3">
          <h2 className="mr-3 text-base font-semibold">Settings</h2>
          {(
            [
              ['calendars', 'Calendars'],
              ['appearance', '外观'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`rounded-md px-2.5 py-1 text-sm ${
                tab === k ? 'bg-sel text-ink' : 'text-mut hover:bg-hov'
              }`}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="ml-auto text-lg leading-none text-fnt hover:text-ink"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {tab === 'appearance' && <AppearanceSettings />}
          {tab === 'calendars' && s === undefined && <p className="text-sm text-fnt">加载中…</p>}

          {tab === 'calendars' && s !== undefined && !s.encryptionAvailable && (
            <p className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-xs text-warn-ink">
              系统密钥库不可用,无法安全保存凭据 —— 暂不能连接 Google。
            </p>
          )}

          {/* 1) 尚未导入 client 凭据 */}
          {tab === 'calendars' && s !== undefined && !s.hasCredentials && (
            <div className="space-y-3">
              <p className="text-sm text-ink">
                连接 Google 日历需要一个你自己的 OAuth client(私人应用不能内置开发者凭据)。
              </p>
              <ol className="list-decimal space-y-1 pl-5 text-xs text-mut">
                <li>Google Cloud Console → 新建项目 → 启用 Google Calendar API</li>
                <li>Google Auth platform → Clients → Create client → 类型选 Desktop app</li>
                <li>下载凭据 JSON,然后点下面的按钮导入</li>
              </ol>
              <button
                type="button"
                className="rounded-md bg-acc px-3 py-1.5 text-sm text-on-acc hover:bg-acc-strong disabled:opacity-50"
                disabled={busy !== null || !s.encryptionAvailable}
                onClick={() => void run('import', () => window.google.importCredentials())}
              >
                {busy === 'import' ? '导入中…' : '导入 credentials.json'}
              </button>
            </div>
          )}

          {/* 2) 已有凭据但未连接 */}
          {tab === 'calendars' && s !== undefined && s.hasCredentials && !s.connected && (
            <div className="space-y-3">
              <p className="text-sm text-ink">凭据已就绪。点下面按钮会打开系统浏览器授权。</p>
              <p className="text-xs text-mut">
                未验证的私人应用会出现「Google hasn&apos;t verified this app」提示页 —— 点
                <strong> Advanced → Go to Claudoist</strong> 继续即可。
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-md bg-acc px-3 py-1.5 text-sm text-on-acc hover:bg-acc-strong disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void run('connect', () => window.google.connect())}
                >
                  {busy === 'connect' ? '等待浏览器授权…' : '连接 Google'}
                </button>
                <button
                  type="button"
                  className="text-xs text-fnt hover:text-ink"
                  disabled={busy !== null}
                  onClick={() => void run('import', () => window.google.importCredentials())}
                >
                  重新导入凭据
                </button>
              </div>
            </div>
          )}

          {/* 3) 已连接(可多账号) */}
          {tab === 'calendars' && s !== undefined && s.connected && (
            <div className="space-y-4">
              <div className="space-y-2 border-b border-line-soft pb-3">
                {s.accounts.map((a) => (
                  <div key={a.email} className="flex items-center gap-3">
                    <span className="text-xl">📅</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{a.email}</p>
                      <p className="text-xs text-ok">● 已连接</p>
                    </div>
                    <button
                      type="button"
                      className="rounded-md border border-danger px-2.5 py-1 text-xs text-danger-ink hover:bg-danger-soft"
                      disabled={busy !== null}
                      onClick={() => {
                        if (!window.confirm(`断开 ${a.email}?(将撤销该账号的授权)`)) return;
                        void run('disconnect', () => window.google.disconnect(a.email));
                      }}
                    >
                      Disconnect
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    className="rounded-md bg-acc px-2.5 py-1 text-xs text-on-acc hover:bg-acc-strong disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() => void run('connect', () => window.google.connect())}
                    title="学校账号禁止对外共享日历时,直接把它也连上"
                  >
                    {busy === 'connect' ? '等待浏览器授权…' : '＋ 添加账号'}
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-line px-2.5 py-1 text-xs hover:bg-hov"
                    disabled={busy !== null}
                    onClick={() => void run('resync', async () => calendars.refetch())}
                  >
                    {busy === 'resync' ? '刷新中…' : 'Resync'}
                  </button>
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium text-mut">
                  日历(👁 = 在 Claudoist 中显示其事件,只读)
                </p>
                {calendars.isLoading && <p className="text-sm text-fnt">读取中…</p>}
                {s.accounts.map((a) => {
                  const mine = (calendars.data ?? []).filter((c) => c.accountEmail === a.email);
                  if (mine.length === 0) return null;
                  return (
                    <div key={a.email} className="mb-3">
                      <p className="mb-1 truncate text-[11px] text-fnt">{a.email}</p>
                      <ul className="space-y-1">
                        {mine.map((c) => (
                          <li
                            key={`${c.accountEmail}:${c.id}`}
                            className="flex items-center gap-2 py-1"
                          >
                            <span
                              className="h-3 w-1.5 shrink-0 rounded-sm"
                              style={{ background: c.backgroundColor ?? '#9ca3af' }}
                            />
                            <span
                              className={`min-w-0 flex-1 truncate text-sm ${c.shown ? '' : 'text-fnt'}`}
                            >
                              {c.summary}
                            </span>
                            {c.primary && (
                              <span className="rounded bg-inset px-1.5 py-0.5 text-[11px] text-mut">
                                主日历
                              </span>
                            )}
                            <button
                              type="button"
                              className="shrink-0 px-1 text-base leading-none"
                              title={c.shown ? '显示中 — 点击隐藏' : '已隐藏 — 点击显示'}
                              disabled={busy !== null}
                              onClick={() =>
                                void run('shown', () =>
                                  window.google.setCalendarShown(c.accountEmail, c.id, !c.shown),
                                )
                              }
                            >
                              {c.shown ? '👁' : '🚫'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
                <p className="mt-2 text-[11px] text-fnt">
                  显示的日历,其事件以只读形式出现在 Calendar 与 Today(不可拖动/编辑)。
                </p>
              </div>

              {/* 写入开关:默认关闭,往 Google 账号里写东西必须显式选择 */}
              <div className="border-t border-line-soft pt-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">把任务同步到日历</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-mut">
                      已排期的任务会写进一个**由本应用创建**的日历「{s.pushCalendarName}」;
                      在那里拖动/删除 block 会同步回任务。你原有的日历我们**没有写权限**。
                      关闭时可一并撤下已推送的事件。
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`shrink-0 rounded-md px-2.5 py-1 text-xs ${
                      s.pushEnabled
                        ? 'bg-acc text-on-acc hover:bg-acc-strong'
                        : 'border border-line hover:bg-hov'
                    }`}
                    disabled={busy !== null}
                    onClick={() => {
                      if (s.pushEnabled) {
                        const purge = window.confirm(
                          `关闭同步。是否同时从「${s.pushCalendarName}」日历撤下已推送的事件?\n\n确定 = 撤下(推荐,否则会留下不再更新的僵尸事件)\n取消 = 只关开关,事件留在日历上`,
                        );
                        void run('push', () => window.google.setPushEnabled(false, purge));
                      } else {
                        void run('push', () => window.google.setPushEnabled(true, false));
                      }
                    }}
                  >
                    {busy === 'push' ? '处理中…' : s.pushEnabled ? '已开启' : '已关闭'}
                  </button>
                </div>
                {!s.pushEnabled && s.pushedCount > 0 && (
                  <div className="mt-2 flex items-center gap-2 rounded-md bg-warn-soft px-2 py-1.5">
                    <span className="flex-1 text-[11px] text-warn-ink">
                      Google 上还留着 {s.pushedCount} 个此前推送的事件(不会再更新)。
                    </span>
                    <button
                      type="button"
                      className="shrink-0 rounded-md border border-warn-line px-2 py-0.5 text-[11px] text-warn-ink hover:bg-hov"
                      disabled={busy !== null}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `从「${s.pushCalendarName}」日历删除这 ${s.pushedCount} 个事件?`,
                          )
                        )
                          return;
                        void run(
                          'purge',
                          () => window.google.purgePushed(),
                          (c) =>
                            Number(c.remaining ?? 0) > 0
                              ? `已删除 ${String(c.removed ?? 0)} 个,还剩 ${String(c.remaining)} 个没删掉 —— 请再试一次`
                              : `已从「${s.pushCalendarName}」删除 ${String(c.removed ?? 0)} 个事件,日历已清空`,
                        );
                      }}
                    >
                      {busy === 'purge' ? '清理中…' : '清理'}
                    </button>
                  </div>
                )}
                {/* 本地指针清零 ≠ Google 侧干净,所以复查始终可用,不随横幅消失 */}
                <button
                  type="button"
                  className="mt-2 text-[11px] text-mut underline hover:text-ink"
                  disabled={busy !== null}
                  onClick={() => {
                    void run(
                      'inspect',
                      () => window.google.inspectPushed(),
                      (c) =>
                        c.connected === false
                          ? '尚未创建专用日历(没有可清理的事件)'
                          : `「${s.pushCalendarName}」(${String(c.account ?? '')})中现有 ${String(c.count ?? 0)} 个事件`,
                    );
                  }}
                >
                  {busy === 'inspect' ? '检查中…' : '检查专用日历里实际还有多少事件'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
