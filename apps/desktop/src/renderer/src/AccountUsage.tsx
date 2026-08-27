import { useCallback, useEffect, useState } from 'react';
import { toast } from './toast';
import type {
  AccountUsageVM,
  ContributionWindowVM,
  GuardrailsVM,
  LimitWindowVM,
  ModelInfoVM,
} from '../../shared/viewModels';
import type { AgentStatusVM } from './AgentSettings';

/**
 * 「账号与用量」页(M11-A)。对齐 Claude Code `/usage` 对话框。
 *
 * 三件事在这里是刻意的,都对应一个具体的误导风险:
 *
 * 1. **订阅额度**(上面的进度条)与**本应用花费**(下面的美元数)分成两块,并明说
 *    "这两个数是两回事"。订阅用户不会为本应用的美元估值付钱 —— 混在一起显示,
 *    用户会以为自己在烧钱,或以为调高预算就能突破配额。
 * 2. **「什么在消耗额度」是全机器口径**。这份统计来自扫本机所有 Claude Code 会话记录,
 *    包含用户自己在终端里的用量。不写清楚,用户会以为是这个 GTD 应用烧的
 *    (实测本机 99% 来自 subagent 密集会话 —— 而本应用根本不给 subagent 工具)。
 * 3. **颜色不是唯一信息载体**:百分比数字始终可见,≥90% 另加文字标签。
 */

const pctColor = (u: number): { bar: string; text: string } =>
  u >= 90
    ? { bar: 'bg-danger', text: 'text-danger-ink' }
    : u >= 60
      ? { bar: 'bg-warn-ink', text: 'text-warn-ink' }
      : { bar: 'bg-acc', text: 'text-mut' };

/**
 * "还有多久重置"。**一律向上取整** —— ceil 让用户以为恢复更晚,是保守方向;
 * floor 会在 3 小时 59 分时显示"3 小时后",用户按 3 小时规划就会扑空。
 */
function resetsIn(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const ms = t - nowMs;
  if (ms <= 0) return '即将重置';
  if (ms > 8 * 86_400_000) return null; // 脏数据/时钟漂移:不显示,别误导
  if (ms < 3_600_000) return `${String(Math.max(1, Math.ceil(ms / 60_000)))} 分钟后重置`;
  if (ms < 86_400_000) return `${String(Math.ceil(ms / 3_600_000))} 小时后重置`;
  return `${String(Math.ceil(ms / 86_400_000))} 天后重置`;
}

function Meter({
  w,
  nowMs,
  dim,
}: {
  w: LimitWindowVM;
  nowMs: number;
  dim: boolean;
}): React.JSX.Element {
  const c = pctColor(w.utilization);
  const reset = resetsIn(w.resetsAt, nowMs);
  return (
    <div className={dim ? 'mb-2.5 opacity-50' : 'mb-2.5'}>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-mut">{w.label}</span>
        <span className={`font-mono ${c.text}`}>{w.utilization}%</span>
      </div>
      {/* 轨道用专用 track token:surface 在浅色主题里与弹窗底同色,量程会消失(审查实测 1.00:1) */}
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-track">
        <div
          className={`h-full rounded-full ${c.bar}`}
          style={{ width: `${String(w.utilization)}%` }}
        />
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-fnt">
        <span title={w.resetsAt ?? undefined}>{reset ?? ''}</span>
        {w.utilization >= 90 && <span className="text-danger-ink">接近上限</span>}
      </div>
    </div>
  );
}

export function AccountUsage({
  status,
  onChanged,
}: {
  status: AgentStatusVM;
  onChanged: () => void;
}): React.JSX.Element {
  const [vm, setVm] = useState<AccountUsageVM | null>(null);
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<ModelInfoVM[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback((force = false) => {
    setLoading(true);
    void window.agent.usageSnapshot(force).then((r) => {
      setVm(r);
      setLoading(false);
    });
    // 与上面共用主进程那份 60s 缓存,不会多起一个子进程
    void window.agent.models().then(setModels);
  }, []);
  useEffect(() => load(), [load]);

  // 只重算"还有多久重置"的文案,**不重新取数**(每次取数可能起一个 CLI 子进程)
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const row = (k: string, v: string): React.JSX.Element => (
    <div className="flex justify-between gap-4 border-b border-line-soft py-1.5 text-xs">
      <span className="shrink-0 text-mut">{k}</span>
      <span className="truncate font-mono">{v}</span>
    </div>
  );

  const fresh = vm?.freshness;
  const cacheMin = fresh?.cacheAgeMs != null ? Math.round(fresh.cacheAgeMs / 60_000) : null;

  return (
    <div className="space-y-4">
      {/* 数据新鲜度 —— 断网时 SDK 会静默返回磁盘缓存且响应体无任何标记,所以这一条必须有 */}
      <div className="flex items-center gap-2 text-[11px]">
        {loading ? (
          <span className="text-fnt">读取中…</span>
        ) : fresh?.source === 'local-cache' ? (
          <span className="rounded bg-warn-soft px-1.5 py-0.5 text-warn-ink">
            本机缓存{cacheMin !== null ? ` · 约 ${String(cacheMin)} 分钟前` : ''}
          </span>
        ) : fresh?.source === 'none' ? (
          <span className="rounded bg-danger-soft px-1.5 py-0.5 text-danger-ink">
            取不到用量数据
          </span>
        ) : (
          <span className="text-fnt">
            实时 · 更新于{' '}
            {fresh?.fetchedAtMs != null
              ? new Date(fresh.fetchedAtMs).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '—'}
          </span>
        )}
        <button
          type="button"
          disabled={loading}
          className="ml-auto rounded border border-line px-2 py-0.5 hover:bg-hov disabled:opacity-40"
          onClick={() => load(true)}
        >
          刷新
        </button>
      </div>

      {vm !== null && (
        <>
          <section>
            <h3 className="mb-1 text-xs font-semibold text-mut">账号</h3>
            {row('登录方式', vm.account.methodLabel)}
            {row('账号', vm.account.email ?? '—')}
            {row('组织', vm.account.organization ?? '—')}
            {row('订阅', vm.account.planLabel ?? '—')}
            {vm.account.apiKeyInEnv && (
              <p className="mt-1 rounded bg-warn-soft px-2 py-1 text-[11px] text-warn-ink">
                环境里存在 ANTHROPIC_API_KEY —— SDK 会优先用它,可能产生 API 计费。
              </p>
            )}
            {vm.account.method === 'logged-out' && (
              <p className="mt-1 rounded bg-warn-soft px-2 py-1 text-[11px] text-warn-ink">
                在终端执行 <code>claude</code> 登录后回来点刷新,不用重启应用。
              </p>
            )}
          </section>

          <section>
            <h3 className="mb-1 text-xs font-semibold text-mut">订阅额度</h3>
            {!vm.usage.available ? (
              <p className="text-[11px] text-fnt">
                {vm.usage.unavailableReason ?? '暂时拿不到额度数据。'}
              </p>
            ) : (
              vm.usage.windows.map((w) => (
                <Meter key={w.id} w={w} nowMs={nowMs} dim={fresh?.source === 'local-cache'} />
              ))
            )}
            <button
              type="button"
              className="text-[11px] text-fnt underline hover:text-mut"
              onClick={() => void window.agent.openBilling()}
            >
              在 claude.ai 上管理用量
            </button>
          </section>

          <Contribution vm={vm} />

          <section>
            <h3 className="mb-1 text-xs font-semibold text-mut">本应用的花费(估值)</h3>
            {row('当前会话', `≈$${vm.appLedger.session.costUsd.toFixed(4)}`)}
            {row(
              '全部历史',
              `${String(vm.appLedger.totals.conversations)} 个会话 · ≈$${vm.appLedger.totals.costUsd.toFixed(4)}`,
            )}
            <p className="mt-1 text-[11px] text-fnt">
              走的是本机 Claude Code 登录,<strong>不是</strong>本应用的 API key。金额是按 API
              单价折算的估值,用来判断哪一轮吃了多少上下文。
              <strong>这里的美元和上面的订阅额度是两回事 —— 订阅用户不会被扣这笔钱。</strong>
            </p>
          </section>
        </>
      )}

      <ModelSection status={status} models={models} onChanged={onChanged} />
      <Guardrails status={status} />
    </div>
  );
}

// ------------------------------------------------------------------ 贡献分析

function Contribution({ vm }: { vm: AccountUsageVM }): React.JSX.Element | null {
  const [tab, setTab] = useState<'day' | 'week'>('day');
  if (vm.contribution === null) {
    return (
      <section>
        <h3 className="mb-1 text-xs font-semibold text-mut">什么在消耗你的额度?</h3>
        <p className="text-[11px] text-fnt">需要连上 Claude 才能统计(当前是离线数据)。</p>
      </section>
    );
  }
  const w: ContributionWindowVM | null = vm.contribution[tab];
  const KIND_LABEL: Record<string, string> = {
    agent: '子代理',
    skill: 'Skills',
    mcp: 'MCP 服务器',
    plugin: '插件',
  };
  const groups = (['agent', 'skill', 'mcp', 'plugin'] as const)
    .map((k) => [k, (w?.attributions ?? []).filter((a) => a.kind === k)] as const)
    .filter(([, rows]) => rows.length > 0);

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-xs font-semibold text-mut">什么在消耗你的额度?</h3>
        <div className="ml-auto flex overflow-hidden rounded border border-line text-[10px]">
          {(['day', 'week'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`px-2 py-0.5 ${tab === k ? 'bg-sel text-ink' : 'text-mut'}`}
              onClick={() => setTab(k)}
            >
              {k === 'day' ? '近 24 小时' : '近 7 天'}
            </button>
          ))}
        </div>
      </div>

      {/* 口径声明必须置顶且不可折叠 —— 否则用户会把终端里自己的用量算到这个应用头上 */}
      <p className="mb-2 rounded bg-warn-soft px-2 py-1.5 text-[11px] leading-relaxed text-warn-ink/90">
        以下统计来自<strong>这台机器上全部</strong> Claude Code 会话的本地记录 ——
        包含你自己在终端里用的 Claude Code,<strong>不只是本应用</strong>。近似值,不含其它设备与
        claude.ai。下列特征彼此独立、可以重叠,<strong>不是占比拆分</strong>(加起来可以超过 100%)。
      </p>

      {w === null ? (
        <p className="text-[11px] text-fnt">这个时间窗里没有记录。</p>
      ) : (
        <>
          <p className="mb-1.5 text-[11px] text-fnt">
            {tab === 'day' ? '近 24 小时' : '近 7 天'} · {w.requestCount} 次请求 · {w.sessionCount}{' '}
            个会话
          </p>
          {w.behaviors.length === 0 && (
            <p className="text-[11px] text-fnt">没有超过 10% 的显著特征。</p>
          )}
          {w.behaviors.map((b) => (
            <BehaviorRow
              key={b.key}
              pct={b.pct}
              headline={b.headline}
              detail={b.detail}
              count={b.count}
            />
          ))}
          {groups.map(([kind, rows]) => (
            <div key={kind} className="mt-2">
              <div className="flex justify-between text-[10px] text-fnt">
                <span>{KIND_LABEL[kind]}</span>
                <span>占用量</span>
              </div>
              {rows.map((a) => (
                <div key={a.name} className="flex justify-between py-0.5 text-[11px]">
                  <span className="truncate text-mut">
                    {a.kind === 'skill' ? `/${a.name}` : a.name}
                  </span>
                  <span className="font-mono text-mut">{a.pct}%</span>
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function BehaviorRow({
  pct,
  headline,
  detail,
  count,
}: {
  pct: number;
  headline: string;
  detail: string;
  count: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-line-soft py-1.5">
      <button
        type="button"
        className="w-full text-left text-[11px] text-ink"
        // count 的单位在不同特征下不一致(请求数 / 会话数),所以只在 title 里中性地说"命中 N 次"
        title={`命中 ${String(count)} 次`}
        onClick={() => setOpen(!open)}
      >
        <span className={`mr-1.5 font-mono ${pct >= 60 ? 'text-warn-ink' : 'text-mut'}`}>
          {pct}%
        </span>
        {headline.replace(/^\d+% /, '')}
      </button>
      {open && detail !== '' && (
        <p className="mt-1 text-[11px] leading-relaxed text-fnt">{detail}</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 模型

function ModelSection({
  status,
  models,
  onChanged,
}: {
  status: AgentStatusVM;
  models: ModelInfoVM[];
  onChanged: () => void;
}): React.JSX.Element {
  // 没选过模型时,高亮 SDK 的默认那一行(而不是谁都不亮)
  const selected = status.model ?? models.find((m) => m.value === 'default')?.value ?? null;
  const current = models.find((m) => m.value === selected) ?? models[0];
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold text-mut">模型</h3>
      {models.length === 0 ? (
        <p className="text-[11px] text-fnt">读取模型列表失败,点上面的「刷新」重试。</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {models.map((m) => (
            <button
              key={m.value}
              type="button"
              title={m.description}
              className={`rounded-md border px-2 py-1 text-xs ${
                selected === m.value
                  ? 'border-acc bg-acc-soft text-acc'
                  : 'border-line text-mut hover:bg-hov'
              }`}
              onClick={() => {
                void window.agent.setModel(m.value).then((r) => {
                  // 先落盘再热切:落盘保证下次起会话用它,热切保证当前会话立刻变
                  if (r.error !== undefined) toast(`已保存,但当前会话切换失败:${r.error}`);
                  else if (!r.applied) toast('已保存 —— 下次开会话时生效');
                  onChanged();
                });
              }}
            >
              {m.displayName}
            </button>
          ))}
        </div>
      )}

      <h4 className="mt-3 mb-1 text-[11px] font-semibold text-mut">思考深度</h4>
      <div className="flex flex-wrap gap-1.5">
        {(['low', 'medium', 'high', 'xhigh', 'max'] as const).map((e) => {
          // 可用档位由**当前模型**决定;不支持的直接禁用,而不是让用户点了没反应
          const supported =
            current?.supportsEffort !== false &&
            (current?.supportedEffortLevels === undefined ||
              current.supportedEffortLevels.includes(e));
          return (
            <button
              key={e}
              type="button"
              disabled={!supported || status.thinking === 'off'}
              title={
                status.thinking === 'off'
                  ? '思考已关闭,effort 不生效'
                  : supported
                    ? undefined
                    : `${current?.displayName ?? '当前模型'}不支持 ${e}`
              }
              className={`rounded-md border px-2 py-1 text-xs disabled:opacity-30 ${
                status.effort === e
                  ? 'border-acc bg-acc-soft text-acc'
                  : 'border-line text-mut hover:bg-hov'
              }`}
              onClick={() => {
                void window.agent.setEffort(e).then((r) => {
                  if (r.error !== undefined) toast(r.error);
                  onChanged();
                });
              }}
            >
              {e}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(
          [
            ['off', '关闭思考'],
            ['hidden', '思考但不显示'],
            ['shown', '显示思考过程'],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            className={`rounded-md border px-2 py-1 text-xs ${
              status.thinking === m
                ? 'border-acc bg-acc-soft text-acc'
                : 'border-line text-mut hover:bg-hov'
            }`}
            onClick={() => {
              void window.agent.setThinking(m).then((r) => {
                if (r.error !== undefined) toast(r.error);
                onChanged();
              });
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-fnt">
        思考 token 计入输出计费 —— 开着更准,但更贵也更慢。「不显示」只是不渲染给你看,
        <strong>照样计费</strong>。
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ 护栏

/**
 * 护栏。这两个值是 `query()` **起进程时**的命令行参数,控制通道里没有对应方法 ——
 * 所以改完只能靠重起会话生效。(⚠ `applyFlagSettings({maxTurns})` 会返回成功但什么都不做,
 * 是个静默陷阱,别拿它当热改手段。)
 *
 * 刻意**不自动重起**:设置页是模态弹层,用户可能只是随手拖了一下滑杆,
 * 静默销毁会话是不可逆的副作用;正在回复时重起还会把那一轮丢掉。所以给一个显式按钮,
 * 并用琥珀提示条让"该点它"这件事无法被忽略。
 */
function Guardrails({ status }: { status: AgentStatusVM }): React.JSX.Element {
  const [g, setG] = useState<GuardrailsVM | null>(null);
  const [dirty, setDirty] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    void window.agent.guardrails().then(setG);
  }, []);

  const save = (turns: number | null, budget: number | null): void => {
    setG((p) => (p === null ? p : { ...p, maxTurns: turns, maxBudgetUsd: budget }));
    void window.agent.setGuardrails(turns, budget).then((r) => {
      if (r.error !== undefined) return toast(r.error);
      setDirty(true);
    });
  };

  if (g === null) return <p className="text-xs text-fnt">读取中…</p>;

  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold text-mut">护栏</h3>

      <div className="border-b border-line-soft py-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-mut">单条消息内最多工具往返</span>
          <span className="font-mono text-mut">{g.maxTurns ?? '不限'}</span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="range"
            min={10}
            max={200}
            step={5}
            disabled={g.maxTurns === null}
            value={g.maxTurns ?? 40}
            className="flex-1 accent-acc disabled:opacity-30"
            onChange={(e) => save(Number(e.target.value), g.maxBudgetUsd)}
          />
          <label className="flex shrink-0 items-center gap-1 text-[11px] text-mut">
            <input
              type="checkbox"
              checked={g.maxTurns === null}
              onChange={(e) => save(e.target.checked ? null : 40, g.maxBudgetUsd)}
            />
            不限
          </label>
        </div>
        <p className="mt-0.5 text-[11px] text-fnt">
          到了上限它会停下来,你发一句「继续」就能接着跑。
        </p>
      </div>

      <div className="border-b border-line-soft py-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-mut">单次会话工作量刹车</span>
          <span className="font-mono text-mut">
            {g.maxBudgetUsd === null ? '不限' : `$${String(g.maxBudgetUsd)}`}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="number"
            min={0.5}
            max={1000}
            step={0.5}
            disabled={g.maxBudgetUsd === null}
            value={g.maxBudgetUsd ?? 5}
            className="w-24 rounded border border-line bg-inset px-2 py-0.5 text-xs disabled:opacity-30"
            onChange={(e) => {
              const v = Number(e.target.value);
              // 下限必须 > 0:判定是「累计成本 >= 上限」,0 会让会话一开口就熄火
              if (Number.isFinite(v) && v >= 0.5) save(g.maxTurns, v);
            }}
          />
          <label className="flex items-center gap-1 text-[11px] text-mut">
            <input
              type="checkbox"
              checked={g.maxBudgetUsd === null}
              onChange={(e) => save(g.maxTurns, e.target.checked ? null : 5)}
            />
            不限
          </label>
        </div>
        <p className="mt-0.5 text-[11px] text-fnt">
          达到约这个数额的<strong>等效</strong> API 用量就停下,防止跑飞。
          <strong>你是订阅用户,这笔钱不会被扣</strong>;真正的配额是上面那几条进度条。重起会话后从 0
          重新计。
        </p>
      </div>

      {dirty &&
        (status.alive ? (
          <div className="mt-2 flex items-center gap-2 rounded bg-warn-soft px-2 py-1.5 text-[11px] text-warn-ink">
            <span>已保存,但当前会话仍在用旧设置。</span>
            <button
              type="button"
              disabled={restarting || status.busy === true}
              className="ml-auto shrink-0 rounded border border-warn-line px-2 py-0.5 hover:bg-warn-soft disabled:opacity-40"
              onClick={() => {
                setRestarting(true);
                void window.agent.restartSession().then((r) => {
                  setRestarting(false);
                  if (r.error !== undefined) return toast(r.error);
                  setDirty(false);
                  toast('已重起 —— 上下文已恢复,工作量计数从 0 重新开始');
                });
              }}
            >
              {status.busy === true ? '正在回复中…' : '立即应用(重起会话,保留上下文)'}
            </button>
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-fnt">已保存 —— 下次开会话时生效。</p>
        ))}

      <div className="mt-2 flex justify-between gap-4 py-1 text-xs">
        <span className="shrink-0 text-mut">会话工作目录</span>
        <span className="truncate font-mono text-fnt">{status.cwd}</span>
      </div>
    </section>
  );
}
