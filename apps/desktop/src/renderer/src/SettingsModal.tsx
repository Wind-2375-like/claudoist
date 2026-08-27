import { useState } from 'react';
import { useGoogleCalendars, useGoogleStatus } from './hooks';
import { toast } from './toast';

/**
 * 设置弹窗(M6c-1)。目前只有 Calendars 一节:连接 Google 账号、查看日历列表、断开。
 * 凭据与 token 全程只在主进程流转,这里只触发动作、读状态。
 */
export function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const status = useGoogleStatus();
  const calendars = useGoogleCalendars(status.data?.connected === true);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (
    label: string,
    fn: () => Promise<{ error: string } | unknown>,
  ): Promise<void> => {
    setBusy(label);
    try {
      const r = (await fn()) as { error?: string };
      if (r && typeof r === 'object' && 'error' in r && r.error) toast(r.error);
    } finally {
      setBusy(null);
      await status.refetch();
      await calendars.refetch();
    }
  };

  const s = status.data;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-16">
      <div className="flex max-h-[80vh] w-[640px] max-w-[95vw] flex-col rounded-xl border border-neutral-200 bg-white shadow-2xl">
        <div className="flex items-center border-b border-neutral-100 px-5 py-3">
          <h2 className="text-base font-semibold">Settings · Calendars</h2>
          <button
            type="button"
            className="ml-auto text-lg leading-none text-neutral-400 hover:text-neutral-700"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {s === undefined && <p className="text-sm text-neutral-400">加载中…</p>}

          {s !== undefined && !s.encryptionAvailable && (
            <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              系统密钥库不可用,无法安全保存凭据 —— 暂不能连接 Google。
            </p>
          )}

          {/* 1) 尚未导入 client 凭据 */}
          {s !== undefined && !s.hasCredentials && (
            <div className="space-y-3">
              <p className="text-sm text-neutral-700">
                连接 Google 日历需要一个你自己的 OAuth client(私人应用不能内置开发者凭据)。
              </p>
              <ol className="list-decimal space-y-1 pl-5 text-xs text-neutral-500">
                <li>Google Cloud Console → 新建项目 → 启用 Google Calendar API</li>
                <li>Google Auth platform → Clients → Create client → 类型选 Desktop app</li>
                <li>下载凭据 JSON,然后点下面的按钮导入</li>
              </ol>
              <button
                type="button"
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                disabled={busy !== null || !s.encryptionAvailable}
                onClick={() => void run('import', () => window.google.importCredentials())}
              >
                {busy === 'import' ? '导入中…' : '导入 credentials.json'}
              </button>
            </div>
          )}

          {/* 2) 已有凭据但未连接 */}
          {s !== undefined && s.hasCredentials && !s.connected && (
            <div className="space-y-3">
              <p className="text-sm text-neutral-700">
                凭据已就绪。点下面按钮会打开系统浏览器授权。
              </p>
              <p className="text-xs text-neutral-500">
                未验证的私人应用会出现「Google hasn&apos;t verified this app」提示页 —— 点
                <strong> Advanced → Go to Claudoist</strong> 继续即可。
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void run('connect', () => window.google.connect())}
                >
                  {busy === 'connect' ? '等待浏览器授权…' : '连接 Google'}
                </button>
                <button
                  type="button"
                  className="text-xs text-neutral-400 hover:text-neutral-700"
                  disabled={busy !== null}
                  onClick={() => void run('import', () => window.google.importCredentials())}
                >
                  重新导入凭据
                </button>
              </div>
            </div>
          )}

          {/* 3) 已连接(可多账号) */}
          {s !== undefined && s.connected && (
            <div className="space-y-4">
              <div className="space-y-2 border-b border-neutral-100 pb-3">
                {s.accounts.map((a) => (
                  <div key={a.email} className="flex items-center gap-3">
                    <span className="text-xl">📅</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{a.email}</p>
                      <p className="text-xs text-green-600">● 已连接</p>
                    </div>
                    <button
                      type="button"
                      className="rounded-md border border-red-300 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
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
                    className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() => void run('connect', () => window.google.connect())}
                    title="学校账号禁止对外共享日历时,直接把它也连上"
                  >
                    {busy === 'connect' ? '等待浏览器授权…' : '＋ 添加账号'}
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50"
                    disabled={busy !== null}
                    onClick={() => void run('resync', async () => calendars.refetch())}
                  >
                    {busy === 'resync' ? '刷新中…' : 'Resync'}
                  </button>
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium text-neutral-500">
                  日历(👁 = 在 Claudoist 中显示其事件,只读)
                </p>
                {calendars.isLoading && <p className="text-sm text-neutral-400">读取中…</p>}
                {s.accounts.map((a) => {
                  const mine = (calendars.data ?? []).filter((c) => c.accountEmail === a.email);
                  if (mine.length === 0) return null;
                  return (
                    <div key={a.email} className="mb-3">
                      <p className="mb-1 truncate text-[11px] text-neutral-400">{a.email}</p>
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
                              className={`min-w-0 flex-1 truncate text-sm ${c.shown ? '' : 'text-neutral-400'}`}
                            >
                              {c.summary}
                            </span>
                            {c.primary && (
                              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">
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
                <p className="mt-2 text-[11px] text-neutral-400">
                  显示的日历,其事件以只读形式出现在 Calendar 与 Today(不可拖动/编辑)。
                </p>
              </div>

              {/* 写入开关:默认关闭,往 Google 账号里写东西必须显式选择 */}
              <div className="border-t border-neutral-100 pt-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">把任务同步到日历</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">
                      已排期的任务会写进一个**由本应用创建**的日历「{s.pushCalendarName}」;
                      在那里拖动/删除 block 会同步回任务。你原有的日历我们**没有写权限**。
                      关闭时可一并撤下已推送的事件。
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`shrink-0 rounded-md px-2.5 py-1 text-xs ${
                      s.pushEnabled
                        ? 'bg-blue-600 text-white hover:bg-blue-700'
                        : 'border border-neutral-300 hover:bg-neutral-50'
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
                  <div className="mt-2 flex items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5">
                    <span className="flex-1 text-[11px] text-amber-800">
                      Google 上还留着 {s.pushedCount} 个此前推送的事件(不会再更新)。
                    </span>
                    <button
                      type="button"
                      className="shrink-0 rounded-md border border-amber-400 px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-100"
                      disabled={busy !== null}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `从「${s.pushCalendarName}」日历删除这 ${s.pushedCount} 个事件?`,
                          )
                        )
                          return;
                        void run('purge', () => window.google.purgePushed());
                      }}
                    >
                      {busy === 'purge' ? '清理中…' : '清理'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
