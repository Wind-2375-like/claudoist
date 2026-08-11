import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Agent 面板(M8 只读版)。取代 M1 的 SpikeChat。
 *
 * 流式状态机(DESIGN §7):`stream_event` 里的 `text_delta` 逐字追加到当前助手气泡;
 * `tool_use` 立刻起一个 chip 并随 `input_json_delta` 实时长出入参;`tool_result` 折叠
 * 附着回对应 chip。工具 chip **必须可见** —— 用户要能看出 agent 是查了数据还是编的。
 */

interface ChatImage {
  data: string;
  mediaType: string;
}

type Item =
  | { kind: 'user'; text: string; imageCount: number }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; input: string; result: string | null; ok: boolean }
  | { kind: 'meta'; text: string }
  | { kind: 'error'; text: string };

interface StreamEvent {
  type: 'message' | 'error' | 'ended';
  message?: string;
  payload?: Record<string, unknown>;
}

interface AgentStatus {
  loggedIn: boolean;
  email: string | null;
  apiKeyInEnv: boolean;
  cwd: string;
  alive: boolean;
  maxTurns: number;
  maxBudgetUsd: number;
  lastSessionId: string | null;
}

/** D-28:composer 下方的建议按钮 —— 只是预置提示,不是状态机,用户随时可以改口。 */
const SUGGESTIONS: { label: string; prompt: string; needsWrite?: boolean }[] = [
  { label: '帮我挑一件事做', prompt: '帮我挑一件现在能做的事。' },
  { label: '今天什么最紧', prompt: '今天有什么要做的?哪些已经过了截止日?' },
  { label: '该排期了', prompt: '有哪些任务一周内到期但还没决定哪天做?' },
  { label: '理清收件箱', prompt: '帮我过一遍收件箱,逐条建议怎么处理。', needsWrite: true },
  { label: '开始周回顾', prompt: '带我做一次每周回顾。', needsWrite: true },
];

const shortName = (n: string): string => n.replace(/^mcp__gtd__/, '');

export function AgentPanel(): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<ChatImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [footer, setFooter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textBuf = useRef('');
  /** content_block index → tool chip id(input_json_delta 靠 index 找回 chip) */
  const blockTool = useRef<Map<number, string>>(new Map());

  const refreshStatus = useCallback(async () => {
    setStatus((await window.agent.status()) as AgentStatus);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  const appendAssistant = useCallback((text: string) => {
    setItems((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.kind === 'assistant') next[next.length - 1] = { kind: 'assistant', text };
      else if (text !== '') next.push({ kind: 'assistant', text });
      return next;
    });
  }, []);

  useEffect(() => {
    return window.agent.onStream((raw) => {
      const ev = raw as StreamEvent;
      if (ev.type === 'error') {
        setBusy(false);
        setItems((p) => [...p, { kind: 'error', text: ev.message ?? '未知错误' }]);
        return;
      }
      if (ev.type === 'ended') {
        setBusy(false);
        void refreshStatus();
        return;
      }
      const m = ev.payload as Record<string, unknown> | undefined;
      if (!m) return;
      const type = m['type'] as string;

      if (type === 'system' && m['subtype'] === 'init') {
        const tools = (m['tools'] as string[] | undefined) ?? [];
        const skills = (m['skills'] as string[] | undefined) ?? [];
        setItems((p) => [
          ...p,
          {
            kind: 'meta',
            text: `会话就绪 · ${String(m['model'] ?? '')} · 工具 ${tools.length} 个${
              skills.length > 0 ? ` · skill ${skills.join('/')}` : ''
            }`,
          },
        ]);
        return;
      }

      if (type === 'stream_event') {
        const e = m['event'] as
          | {
              type?: string;
              index?: number;
              delta?: { type?: string; text?: string; partial_json?: string };
              content_block?: { type?: string; id?: string; name?: string };
            }
          | undefined;
        if (!e) return;
        if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          const id = e.content_block.id ?? `t${String(e.index)}`;
          blockTool.current.set(e.index ?? -1, id);
          setItems((p) => [
            ...p,
            {
              kind: 'tool',
              id,
              name: e.content_block?.name ?? '?',
              input: '',
              result: null,
              ok: true,
            },
          ]);
          return;
        }
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          textBuf.current += e.delta.text ?? '';
          appendAssistant(textBuf.current);
          return;
        }
        // 工具入参是逐块拼出来的 —— 实时显示,用户能看出它在查什么
        if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') {
          const id = blockTool.current.get(e.index ?? -1);
          if (id === undefined) return;
          const chunk = e.delta.partial_json ?? '';
          setItems((p) =>
            p.map((it) =>
              it.kind === 'tool' && it.id === id ? { ...it, input: it.input + chunk } : it,
            ),
          );
        }
        return;
      }

      if (type === 'assistant') {
        // 一条完整的 assistant 消息落定 → 结束当前文本气泡,下一段重新开
        textBuf.current = '';
        return;
      }

      if (type === 'user') {
        // 工具结果以 user 消息回灌;附到对应 chip 上
        const msg = m['message'] as { content?: unknown[] } | undefined;
        for (const block of msg?.content ?? []) {
          const b = block as {
            type?: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          };
          if (b.type !== 'tool_result' || b.tool_use_id === undefined) continue;
          const text =
            typeof b.content === 'string'
              ? b.content
              : JSON.stringify(b.content ?? '').slice(0, 4000);
          setItems((p) =>
            p.map((it) =>
              it.kind === 'tool' && it.id === b.tool_use_id
                ? { ...it, result: text, ok: b.is_error !== true }
                : it,
            ),
          );
        }
        return;
      }

      if (type === 'result') {
        setBusy(false);
        textBuf.current = '';
        const u = m['usage'] as Record<string, number> | undefined;
        const cw = u?.['cache_creation_input_tokens'] ?? 0;
        const cr = u?.['cache_read_input_tokens'] ?? 0;
        const bits = [
          `${String(u?.['input_tokens'] ?? 0)}→${String(u?.['output_tokens'] ?? 0)} tok`,
          cw > 0 ? `缓存写入 ${String(cw)}` : '',
          cr > 0 ? `缓存命中 ${String(cr)}` : '',
          `≈$${Number(m['total_cost_usd'] ?? 0).toFixed(4)}`,
        ].filter(Boolean);
        setFooter(bits.join(' · '));
        if (m['is_error'] === true) {
          setItems((p) => [
            ...p,
            { kind: 'error', text: `本轮结束于错误(${String(m['subtype'] ?? '')})` },
          ]);
        }
      }
    });
  }, [appendAssistant, refreshStatus]);

  const ensureSession = useCallback(async (): Promise<void> => {
    const s = (await window.agent.status()) as AgentStatus;
    if (!s.alive) await window.agent.startSession(s.lastSessionId !== null);
  }, []);

  const submit = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (t === '' || busy) return;
      await ensureSession();
      setItems((p) => [...p, { kind: 'user', text: t, imageCount: images.length }]);
      setDraft('');
      textBuf.current = '';
      setBusy(true);
      const r = (await window.agent.send(t, images)) as { error?: string };
      setImages([]);
      if (r.error !== undefined) {
        setBusy(false);
        setItems((p) => [...p, { kind: 'error', text: r.error! }]);
      }
    },
    [busy, ensureSession, images],
  );

  const onPaste = (e: React.ClipboardEvent): void => {
    for (const item of e.clipboardData.items) {
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      void file.arrayBuffer().then((buf) => {
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        setImages((p) => [...p, { data: b64, mediaType: file.type }]);
      });
    }
  };

  return (
    <div className="flex h-full flex-col bg-neutral-900 text-neutral-100">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2.5">
        <span className="text-sm font-semibold">Agent</span>
        <span className="text-[11px] text-neutral-500">
          {status?.loggedIn === true ? (status.email ?? '已登录') : '未登录'}
          {status?.apiKeyInEnv === true ? ' · ⚠ 环境里有 API key' : ''}
        </span>
        <button
          type="button"
          className="ml-auto rounded px-1.5 text-xs text-neutral-400 hover:bg-neutral-800"
          title="新开会话"
          onClick={() => {
            void window.agent.newSession().then(() => {
              setItems([]);
              setFooter('');
              void refreshStatus();
            });
          }}
        >
          ＋ 新会话
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {status !== null && !status.loggedIn && (
          <div className="rounded-lg bg-amber-950/60 px-3 py-2 text-xs text-amber-200">
            没检测到本机 Claude Code 登录。请在终端执行 <code>claude</code> 完成登录,然后点下面的
            重试 —— 不用重启应用。
            <button type="button" className="ml-2 underline" onClick={() => void refreshStatus()}>
              重试
            </button>
          </div>
        )}
        {items.length === 0 && (
          <p className="px-1 py-6 text-center text-xs text-neutral-500">
            只读模式:我能查你的任务、项目、日历、标签与过滤器,但改不了数据。
          </p>
        )}
        {items.map((it, i) => {
          if (it.kind === 'user') {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-blue-600 px-3 py-1.5 text-sm whitespace-pre-wrap">
                  {it.text}
                  {it.imageCount > 0 && (
                    <span className="ml-1 text-[11px] opacity-80">+{it.imageCount} 图</span>
                  )}
                </div>
              </div>
            );
          }
          if (it.kind === 'assistant') {
            return (
              <div
                key={i}
                className="max-w-[92%] rounded-2xl bg-neutral-800 px-3 py-1.5 text-sm whitespace-pre-wrap"
              >
                {it.text}
              </div>
            );
          }
          if (it.kind === 'tool') {
            return <ToolChip key={it.id} item={it} />;
          }
          if (it.kind === 'error') {
            return (
              <p key={i} className="px-1 text-xs text-red-400">
                {it.text}
              </p>
            );
          }
          return (
            <p key={i} className="px-1 text-center text-[11px] text-neutral-500">
              {it.text}
            </p>
          );
        })}
      </div>

      {/* 建议按钮(D-28):点击 = 发预置提示;需要写权限的只读期明确降级 */}
      <div className="flex flex-wrap gap-1.5 border-t border-neutral-800 px-3 pt-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            disabled={busy}
            title={
              s.needsWrite === true
                ? '需要写入能力(M9),当前只读:agent 会说明能做到哪一步'
                : undefined
            }
            className="rounded-full border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
            onClick={() => void submit(s.prompt)}
          >
            {s.label}
            {s.needsWrite === true && <span className="ml-1 text-neutral-500">·只读</span>}
          </button>
        ))}
      </div>

      <div className="px-3 pt-2 pb-3">
        {images.length > 0 && (
          <p className="mb-1 text-[11px] text-neutral-500">已附 {images.length} 张图片</p>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit(draft);
            }
          }}
          rows={3}
          placeholder="给 Claude 发消息…(Enter 发送,可粘贴图片)"
          className="w-full resize-none rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none placeholder:text-neutral-500 focus:border-neutral-500"
        />
        <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
          <span className="truncate">{footer}</span>
          {busy && (
            <button
              type="button"
              className="ml-auto shrink-0 rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
              onClick={() => void window.agent.interrupt()}
              title="只停当前这轮,会话继续"
            >
              中断
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 工具调用 chip:入参实时长出,结果折叠。 */
function ToolChip({ item }: { item: Extract<Item, { kind: 'tool' }> }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-850/40 px-2.5 py-1.5 text-[11px]">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setOpen(!open)}
      >
        <span className={item.result === null ? 'animate-pulse' : ''}>🔧</span>
        <span className="font-mono text-neutral-300">{shortName(item.name)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-neutral-500">{item.input}</span>
        <span className="shrink-0 text-neutral-600">
          {item.result === null ? '…' : item.ok ? '✓' : '✗'}
        </span>
      </button>
      {open && item.result !== null && (
        <pre className="mt-1 max-h-56 overflow-auto rounded bg-neutral-900 p-2 text-[10px] whitespace-pre-wrap text-neutral-400">
          {item.result}
        </pre>
      )}
    </div>
  );
}
