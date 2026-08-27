import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ErrorBoundary } from './ErrorBoundary';
import { toast } from './toast';
import { AccountUsage } from './AccountUsage';
import type { AuditRowVM, ToolManualEntryVM } from '../../shared/viewModels';

/**
 * Agent 的账号/用量/模型/偏好/Skills —— 全部在应用内完成,不跳外部编辑器。
 *
 * 用量从 footer 挪到这里(2026-08-11 用户反馈):聊天框下面挂一串
 * "4→431 tok · 缓存写入 6992 · ≈$0.0877" 既看不懂也没人一直盯着;它属于"账号与用量",
 * 需要时点开看。
 */

export interface AgentStatusVM {
  loggedIn: boolean;
  email: string | null;
  apiKeyInEnv: boolean;
  cwd: string;
  alive: boolean;
  busy: boolean;
  maxTurns: number;
  maxBudgetUsd: number;
  lastConversationId: string | null;
  conversationId: string | null;
  memoryPath: string;
  model: string | null;
  effort: string | null;
  thinking: 'off' | 'hidden' | 'shown';
  permissionMode: string;
  alwaysAllow: string[];
  /** 本会话累计 */
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** 全部历史累计 */
  totals: { conversations: number; costUsd: number; inputTokens: number; outputTokens: number };
}

type Tab = 'account' | 'permissions' | 'memory' | 'skills' | 'tools';

export function AgentSettings({
  status,
  onClose,
  onChanged,
}: {
  status: AgentStatusVM;
  onClose: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('account');
  // 全窗弹层:portal 到 body,脱离 .theme-panel 作用域,吃主题主色(而不是面板色)。
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-scrim pt-16">
      <div className="flex max-h-[78vh] w-[680px] max-w-[94vw] flex-col rounded-xl border border-line bg-raised text-ink shadow-2xl">
        <div className="flex items-center gap-1 border-b border-line-soft px-3 py-2">
          {(
            [
              ['account', '账号与用量'],
              ['permissions', '权限与审计'],
              ['memory', '我的偏好'],
              ['skills', 'Skills'],
              ['tools', '工具参考'],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              data-testid={`agent-tab-${k}`}
              className={`rounded px-2.5 py-1 text-xs ${
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
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <ErrorBoundary label="这一页">
            {tab === 'account' && <AccountUsage status={status} onChanged={onChanged} />}
            {tab === 'permissions' && <PermissionsTab status={status} onChanged={onChanged} />}
            {tab === 'memory' && <MemoryTab />}
            {tab === 'skills' && <SkillsTab />}
            {tab === 'tools' && <ToolsTab />}
          </ErrorBoundary>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ 权限与审计

const DECISION_LABEL: Record<string, { text: string; cls: string }> = {
  'allowed-auto': { text: '自动放行', cls: 'text-mut' },
  'allowed-user': { text: '你批准了', cls: 'text-ok' },
  denied: { text: '被拒绝', cls: 'text-danger-ink' },
};

/**
 * 权限模式 + 「始终允许」清单 + 审计流水。
 *
 * 审计放在这里而不是单开一页,是因为它和权限是同一个问题的两面:改了模式之后,
 * 用户第一件想确认的事就是"那它到底做了什么"。
 */
function PermissionsTab({
  status,
  onChanged,
}: {
  status: AgentStatusVM;
  onChanged: () => void;
}): React.JSX.Element {
  const [modes, setModes] = useState<{ id: string; label: string; hint: string }[]>([]);
  const [alwaysAllow, setAlwaysAllow] = useState<string[]>(status.alwaysAllow);
  const [audit, setAudit] = useState<AuditRowVM[]>([]);
  const [scopeAll, setScopeAll] = useState(false);

  const reload = (): void => {
    void window.agent.permissionModes().then((r) => {
      setModes(r.modes);
      setAlwaysAllow(r.alwaysAllow);
    });
    void window.agent.auditList(scopeAll ? null : status.conversationId).then(setAudit);
  };
  useEffect(reload, [scopeAll, status.conversationId]);

  return (
    <div className="space-y-4">
      <section>
        <h3 className="mb-1 text-xs font-semibold text-mut">权限模式</h3>
        <div className="space-y-1">
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left ${
                status.permissionMode === m.id
                  ? 'border-acc bg-acc-soft'
                  : 'border-line-soft hover:bg-hov'
              }`}
              onClick={() => {
                void window.agent.setPermissionMode(m.id).then((r) => {
                  if (r.error !== undefined) return toast(r.error);
                  // 只读 ↔ 可写会改变工具面,必须重起会话才生效
                  if (r.needsRestart === true) {
                    toast('已切换 —— 新建会话后完全生效(当前会话的工具面不会变)');
                  }
                  onChanged();
                  reload();
                });
              }}
            >
              <span className="mt-0.5 text-xs">{status.permissionMode === m.id ? '●' : '○'}</span>
              <span className="min-w-0">
                <span className="block text-xs text-ink">{m.label}</span>
                <span className="block text-[11px] text-fnt">{m.hint}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-fnt">
          删除、完成项目、以及会级联完成子任务的完成操作,在「自动」模式下<strong>仍会</strong>
          弹窗。只读模式下写工具根本不注册。
        </p>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold text-mut">始终允许</h3>
        {alwaysAllow.length === 0 ? (
          <p className="text-[11px] text-fnt">还没有。在审批弹窗里按「始终允许」会加到这里。</p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {alwaysAllow.map((t) => (
              <span
                key={t}
                className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-mut"
              >
                {t}
              </span>
            ))}
            <button
              type="button"
              className="text-[11px] text-mut underline hover:text-ink"
              onClick={() => {
                void window.agent.clearAlwaysAllow().then(() => {
                  onChanged();
                  reload();
                });
              }}
            >
              全部清除
            </button>
          </div>
        )}
      </section>

      <section>
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-xs font-semibold text-mut">审计</h3>
          <button
            type="button"
            className="ml-auto text-[11px] text-mut underline hover:text-ink"
            onClick={() => setScopeAll(!scopeAll)}
          >
            {scopeAll ? '只看本会话' : '看全部会话'}
          </button>
        </div>
        {audit.length === 0 ? (
          <p className="text-[11px] text-fnt">还没有记录。</p>
        ) : (
          <ul className="space-y-1">
            {audit.map((a) => (
              <AuditRow key={a.id} row={a} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AuditRow({ row }: { row: AuditRowVM }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const d = DECISION_LABEL[row.decision] ?? { text: row.decision, cls: 'text-mut' };
  return (
    <li className="border-b border-line-soft pb-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-[11px]"
        onClick={() => setOpen(!open)}
      >
        <span className="text-fnt">{row.createdAt.slice(11, 19)}</span>
        <span className="font-mono text-mut">{row.toolName}</span>
        <span className={`ml-auto shrink-0 ${d.cls}`}>{d.text}</span>
      </button>
      {open && (
        <pre className="mt-1 max-h-40 overflow-auto rounded bg-inset p-1.5 text-[10px] whitespace-pre-wrap text-fnt">
          入参 {row.inputJson}
          {row.resultSummary !== null ? `\n结果 ${row.resultSummary}` : ''}
        </pre>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ 我的偏好

function MemoryTab(): React.JSX.Element {
  const [body, setBody] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    void window.agent.readMemory().then((r) => {
      setBody(r.body);
      setPath(r.path);
    });
  }, []);
  if (body === null) return <p className="text-xs text-fnt">读取中…</p>;
  return (
    <div className="flex h-[52vh] flex-col">
      <p className="mb-1 text-[11px] text-fnt">
        这是 <code>CLAUDE.md</code> —— agent 每次开会话都会读它。规则类约束(优先级方向、
        日期语义等)写在这里无效,那些是程序里的正确性约束。
      </p>
      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setDirty(true);
        }}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none rounded border border-line bg-surface p-2 font-mono text-xs outline-none focus:border-acc"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={!dirty}
          className="rounded-md bg-acc px-3 py-1 text-xs text-on-acc disabled:opacity-40"
          onClick={() => {
            void window.agent.writeMemory(body).then(() => {
              setDirty(false);
              toast('已保存 —— 下次开会话生效');
            });
          }}
        >
          保存
        </button>
        <span className="truncate text-[11px] text-fnt">{path}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Skills

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: 一句话说明什么时候该用它(agent 靠这句判断要不要加载)。
---

# 我的流程

## 步骤

1. …

## 注意

- …
`;

function SkillsTab(): React.JSX.Element {
  const [list, setList] = useState<
    { name: string; builtin: boolean; modified: boolean; path: string }[]
  >([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [showTools, setShowTools] = useState(false);

  const reload = (): void => {
    void window.agent.listSkills().then(setList);
  };
  useEffect(reload, []);

  const open = (name: string): void => {
    void window.agent.readSkill(name).then((r) => {
      setBody(r.body);
      setEditing(name);
      setCreating(false);
    });
  };

  if (editing !== null || creating) {
    const name = creating ? newName : editing!;
    return (
      <div className="flex h-[52vh] flex-col">
        {creating && (
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="skill 名(小写字母、数字、连字符)"
            className="mb-2 rounded border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-acc"
          />
        )}
        <div className="flex min-h-0 flex-1 gap-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none rounded border border-line bg-surface p-2 font-mono text-xs outline-none focus:border-acc"
          />
          {showTools && (
            <div className="w-1/2 overflow-y-auto rounded border border-line-soft bg-inset p-2">
              <ToolsTab compact />
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className="rounded-md bg-acc px-3 py-1 text-xs text-on-acc"
            onClick={() => {
              void window.agent.writeSkill(name, body).then((r) => {
                if (r.error !== undefined) return toast(r.error);
                toast('已保存 —— 下次开会话生效');
                setEditing(null);
                setCreating(false);
                reload();
              });
            }}
          >
            保存
          </button>
          <button
            type="button"
            className="text-xs text-mut hover:text-ink"
            onClick={() => {
              setEditing(null);
              setCreating(false);
            }}
          >
            返回
          </button>
          <button
            type="button"
            className="text-xs text-mut underline hover:text-ink"
            onClick={() => setShowTools(!showTools)}
          >
            {showTools ? '收起工具参考' : '工具参考'}
          </button>
          <span className="ml-auto text-[11px] text-fnt">
            改动内置 skill 后,应用升级不会再覆盖它
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <p className="text-[11px] text-fnt">
          skill = 一段流程说明书。agent 按 description 判断何时加载;能调的工具见「工具参考」。
        </p>
        <button
          type="button"
          className="ml-auto rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hov"
          onClick={() => {
            setBody(NEW_SKILL_TEMPLATE);
            setNewName('');
            setCreating(true);
          }}
        >
          ＋ 新建
        </button>
      </div>
      <ul>
        {list.map((s) => (
          <li key={s.name} className="flex items-center gap-2 border-b border-line-soft py-2">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => open(s.name)}>
              <span className="block truncate text-sm">{s.name}</span>
              <span className="text-[11px] text-fnt">
                {s.builtin ? (s.modified ? '内置 · 已被你修改' : '内置') : '自定义'}
              </span>
            </button>
            {s.modified && (
              <button
                type="button"
                className="text-[11px] text-mut hover:text-ink"
                onClick={() => {
                  if (!window.confirm(`把 ${s.name} 恢复成随应用发布的版本?你的修改会丢失。`))
                    return;
                  void window.agent.resetSkill(s.name).then(reload);
                }}
              >
                恢复默认
              </button>
            )}
            {!s.builtin && (
              <button
                type="button"
                className="text-[11px] text-mut hover:text-danger-ink"
                onClick={() => {
                  if (!window.confirm(`删除 skill「${s.name}」?`)) return;
                  void window.agent.deleteSkill(s.name).then(reload);
                }}
              >
                删除
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ 工具参考

/**
 * 用户写自己的 skill 时,得知道有哪些工具、全名叫什么、参数是什么。
 * 内容由 `toolManual()` 从**工具定义本身**生成 —— 另抄一份迟早对不上,而那种错
 * 只在 agent 调用失败时才暴露。
 */
function ToolsTab({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const [tools, setTools] = useState<ToolManualEntryVM[]>([]);
  useEffect(() => {
    void window.agent.toolManual().then(setTools);
  }, []);
  return (
    <div>
      {!compact && (
        <p className="mb-2 text-[11px] text-fnt">
          在 skill 里按<strong>全名</strong>调用,例如 <code>mcp__gtd__run_filter</code>
          (点名字可复制)。标「写」的会改数据、要经权限审批;标「危险」的即使在自动模式也弹窗。
        </p>
      )}
      <ul className="space-y-2">
        {tools.map((t) => (
          <li key={t.name} className="border-b border-line-soft pb-2">
            <button
              type="button"
              className={`font-mono text-xs hover:underline ${
                t.kind === 'write' ? 'text-warn-ink' : 'text-ok'
              }`}
              title="点击复制"
              onClick={() => void navigator.clipboard.writeText(t.qualified)}
            >
              {t.qualified}
            </button>
            {t.kind === 'write' && (
              <span className="ml-1.5 rounded bg-warn-soft px-1 py-0.5 text-[10px] text-warn-ink">
                写
              </span>
            )}
            {t.destructive && (
              <span className="ml-1 rounded bg-danger-soft px-1 py-0.5 text-[10px] text-danger-ink">
                危险
              </span>
            )}
            <p className="mt-0.5 text-[11px] leading-relaxed text-mut">{t.description}</p>
            {t.params.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {t.params.map((p) => (
                  <li key={p.name} className="text-[11px] text-fnt">
                    <span className="font-mono text-mut">{p.name}</span>
                    <span className="ml-1 font-mono text-fnt">{p.type}</span>
                    {!p.required && <span className="ml-1 text-fnt">(可选)</span>}
                    {p.description !== '' && <span className="ml-1">— {p.description}</span>}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
