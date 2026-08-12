import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentSettings } from './AgentSettings';
import type { AgentStatusVM } from './AgentSettings';
import { ConversationList } from './ConversationList';
import { PermissionPrompt } from './PermissionPrompt';
import { ErrorBoundary } from './ErrorBoundary';
import { toast } from './toast';
import type { PermissionRequestVM } from '../../shared/viewModels';
import { isSubmitEnter } from './keys';

/**
 * Agent 面板。M8 只读版 → M9 加审批与权限模式 → M10 加历史会话、附件、effort/thinking。
 *
 * 流式状态机(DESIGN §7):`stream_event` 里的 `text_delta` 逐字追加到当前助手气泡;
 * `tool_use` 立刻起一个 chip 并随 `input_json_delta` 实时长出入参;`tool_result` 折叠
 * 附着回对应 chip。工具 chip **必须可见** —— 用户要能看出 agent 是查了数据还是编的。
 */

interface ChatImage {
  data: string;
  mediaType: string;
}

interface Attachment {
  path: string;
  name: string;
}

type Item =
  | { kind: 'user'; text: string; imageCount: number; attachments: string[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: string;
      result: string | null;
      ok: boolean;
      /** 正卡在审批弹窗上 */
      awaiting?: boolean;
    }
  | { kind: 'meta'; text: string }
  /** 停下来了但不是故障(跑满往返上限);可以直接接着聊 */
  | { kind: 'halt'; text: string }
  /** 会话被工作量刹车卡死 —— **粘住的**,不重起就永远发不出去 */
  | { kind: 'stuck'; text: string }
  | { kind: 'error'; text: string };

interface StreamEvent {
  type: 'message' | 'error' | 'ended';
  message?: string;
  payload?: Record<string, unknown>;
}

/**
 * D-28:composer 下方的建议按钮 —— 只是预置提示,不是状态机,用户随时可以改口。
 *
 * 五条都对应一个 skill,而 skill 一律是**启发式**的:agent 提问、给选项与代价,
 * 让用户自己判断,而不是替他决定。这不是文风偏好 —— GTD 的价值就在"用户亲手做出
 * 那些判断",一个直接给答案的助手会把这个过程整个抽掉。
 */
const SUGGESTIONS: { label: string; prompt: string; needsWrite?: boolean }[] = [
  { label: '挑一件事做', prompt: '帮我挑一件现在能做的事。' },
  { label: '今天什么最紧', prompt: '今天什么最紧?带我判断一下轻重。' },
  { label: '规划今日行程', prompt: '帮我规划今天的行程。' },
  { label: '理清收件箱', prompt: '带我理清收件箱。', needsWrite: true },
  { label: '开始周回顾', prompt: '带我做一次每周回顾。', needsWrite: true },
];

const shortName = (n: string): string => n.replace(/^mcp__gtd__/, '');

/**
 * 给审批中的工具 chip 打「等待你批准…」。
 *
 * 优先按 `toolUseId` 对上;对不上就退而求其次 —— 找**最后一枚同名且还没有结果**的 chip。
 * 兜底是必要的:chip 的 id 来自流式 `content_block_start`,而审批请求的 id 来自 SDK 的
 * 控制通道,两者在 MCP 工具上不保证是同一个标识。对不上就不提示,用户会以为界面卡住了。
 */
function markAwaiting(items: Item[], req: PermissionRequestVM, on: boolean): Item[] {
  if (items.some((it) => it.kind === 'tool' && it.id === req.toolUseId)) {
    return items.map((it) =>
      it.kind === 'tool' && it.id === req.toolUseId ? { ...it, awaiting: on } : it,
    );
  }
  const idx = items.findLastIndex(
    (it) => it.kind === 'tool' && it.result === null && shortName(it.name) === req.tool,
  );
  if (idx < 0) return items;
  return items.map((it, i) => (i === idx && it.kind === 'tool' ? { ...it, awaiting: on } : it));
}

export function AgentPanel(): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState<AgentStatusVM | null>(null);
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<ChatImage[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** 审批请求队列 —— 一轮里可能连来两个,不能后来的把前一个挤掉 */
  const [permQueue, setPermQueue] = useState<PermissionRequestVM[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textBuf = useRef('');
  const thinkBuf = useRef('');
  /** content_block index → tool chip id(input_json_delta 靠 index 找回 chip) */
  const blockTool = useRef<Map<number, string>>(new Map());

  const refreshStatus = useCallback(async () => {
    setStatus((await window.agent.status()) as AgentStatusVM);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  /** 审批请求:入队即可,渲染只显示队首;同时给聊天流里那枚 chip 打上"等待批准" */
  useEffect(
    () =>
      window.agent.onPermissionRequest((req) => {
        setPermQueue((p) => [...p, req]);
        setItems((p) => markAwaiting(p, req, true));
      }),
    [],
  );

  const appendText = useCallback((kind: 'assistant' | 'thinking', text: string) => {
    setItems((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.kind === kind) next[next.length - 1] = { kind, text } as Item;
      else if (text !== '') next.push({ kind, text } as Item);
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
        setPermQueue([]);
        void refreshStatus();
        return;
      }
      const m = ev.payload as Record<string, unknown> | undefined;
      if (!m) return;
      const type = m['type'] as string;

      if (type === 'system' && m['subtype'] === 'init') {
        const tools = (m['tools'] as string[] | undefined) ?? [];
        // ⚠ init.skills 是**发现**到的,含用户自己 ~/.claude/skills 里的私人 skill;
        // 真正启用的只有本应用目录里那些(options.skills 是启用过滤器)。把发现列表
        // 展示给用户会让他以为 deep-research 之类在这里也能用。
        void window.agent.listSkills().then((mine) => {
          setItems((p) => [
            ...p,
            {
              kind: 'meta',
              text: `会话就绪 · ${String(m['model'] ?? '')} · 工具 ${tools.length} 个 · skill ${mine.length} 个`,
            },
          ]);
        });
        return;
      }

      if (type === 'stream_event') {
        const e = m['event'] as
          | {
              type?: string;
              index?: number;
              delta?: { type?: string; text?: string; partial_json?: string; thinking?: string };
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
          appendText('assistant', textBuf.current);
          return;
        }
        // thinking 展示态(M10):折叠成灰块,与正文分开
        if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') {
          thinkBuf.current += e.delta.thinking ?? '';
          appendText('thinking', thinkBuf.current);
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
        thinkBuf.current = '';
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
        thinkBuf.current = '';
        void refreshStatus();
        if (m['is_error'] === true) {
          const subtype = String(m['subtype'] ?? '');
          // 这两种"错误"其实是护栏在起作用,不该渲染成红色故障 ——
          // 尤其 error_max_budget_usd 是**粘住的**:判定是「进程累计成本 >= 上限」,
          // 一旦触发,之后每条消息都会立刻返回同样的错、一个 token 都不跑。
          // 不专门识别它,用户只会对着一条看不懂的红字反复发消息。
          if (subtype === 'error_max_turns') {
            setItems((p) => [
              ...p,
              {
                kind: 'halt',
                text: '这一轮跑满了工具往返上限,先停下了。发一句「继续」就能接着跑。',
              },
            ]);
          } else if (subtype === 'error_max_budget_usd') {
            setItems((p) => [
              ...p,
              {
                kind: 'stuck',
                text: '本次会话达到了工作量刹车上限。**这个状态不会自己恢复** —— 现在发任何消息都会立刻返回同样的结果。重起会话即可继续(上下文保留,计数从 0 重新开始)。',
              },
            ]);
          } else {
            setItems((p) => [...p, { kind: 'error', text: `本轮结束于错误(${subtype})` }]);
          }
        }
      }
    });
  }, [appendText, refreshStatus]);

  const ensureSession = useCallback(async (): Promise<void> => {
    const s = (await window.agent.status()) as AgentStatusVM;
    if (!s.alive) await window.agent.startSession({ resume: s.lastConversationId !== null });
  }, []);

  const submit = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (t === '' || busy) return;
      await ensureSession();
      setItems((p) => [
        ...p,
        {
          kind: 'user',
          text: t,
          imageCount: images.length,
          attachments: attachments.map((a) => a.name),
        },
      ]);
      setDraft('');
      textBuf.current = '';
      setBusy(true);
      const r = (await window.agent.send(
        t,
        images,
        attachments.map((a) => a.path),
      )) as { error?: string };
      setImages([]);
      setAttachments([]);
      if (r.error !== undefined) {
        setBusy(false);
        setItems((p) => [...p, { kind: 'error', text: r.error! }]);
      }
    },
    [busy, ensureSession, images, attachments],
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

  /**
   * 拖入文件 → 主进程复制进 userData/attachments 后返回绝对路径。
   * sandbox 渲染层里 `File.path` 是空串(Electron 32 移除),真实路径只能经 preload 的
   * `webUtils.getPathForFile` 取(见 preload/index.ts)。
   */
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.agent.pathForFile(f))
      .filter((p) => p !== '');
    if (paths.length === 0) {
      toast('拖拽没拿到文件路径,请用回形针按钮选择文件');
      return;
    }
    void window.agent.addAttachments(paths).then((r) => setAttachments((p) => [...p, ...r.files]));
  };

  const pickFiles = (): void => {
    void window.agent.pickAttachments().then((r) => {
      if (r.paths.length === 0) return;
      void window.agent
        .addAttachments(r.paths)
        .then((a) => setAttachments((p) => [...p, ...a.files]));
    });
  };

  const openConversation = (id: string, fork: boolean): void => {
    setHistoryOpen(false);
    setItems([]);
    void (async () => {
      const t = await window.agent.transcript(id);
      setItems(
        t.items.map((x) =>
          x.role === 'user'
            ? { kind: 'user' as const, text: x.text, imageCount: 0, attachments: [] }
            : {
                kind: 'assistant' as const,
                text:
                  x.text === '' && x.tools.length > 0
                    ? `(调用了 ${x.tools.map(shortName).join('、')})`
                    : x.text,
              },
        ),
      );
      await window.agent.startSession({ conversationId: id, fork });
      await refreshStatus();
    })();
  };

  const canWrite = status !== null && status.permissionMode !== 'plan';

  return (
    <div
      className="relative flex h-full flex-col bg-neutral-900 text-neutral-100"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between border-b border-neutral-700 px-4 py-3">
        <span className="text-sm font-semibold">Agent</span>
        <div className="flex items-center gap-2 text-neutral-400">
          <button
            type="button"
            title="账号与用量 · 模型 · 我的偏好 · Skills · 权限"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 leading-none hover:bg-neutral-800 hover:text-neutral-100"
            onClick={() => setSettingsOpen(true)}
          >
            <span className={status?.loggedIn === true ? 'text-emerald-500' : 'text-amber-400'}>
              ●
            </span>
            <span className="max-w-24 truncate text-[11px]">
              {status?.email?.split('@')[0] ?? '未登录'}
            </span>
          </button>
          <button
            type="button"
            title="历史会话"
            className="leading-none hover:text-neutral-100"
            onClick={() => setHistoryOpen(true)}
          >
            🕘
          </button>
          <button
            type="button"
            title="新建会话"
            className="leading-none hover:text-neutral-100"
            onClick={() => {
              void window.agent.newSession().then(() => {
                setItems([]);
                void refreshStatus();
              });
            }}
          >
            ＋
          </button>
        </div>
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
            {canWrite
              ? '我能查你的任务并按你的确认帮你改。每次写入都会先问你(可在设置里调权限模式)。'
              : '只读模式:我能查你的任务、项目、日历、标签与过滤器,但改不了数据。'}
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
                  {it.attachments.length > 0 && (
                    <span className="ml-1 text-[11px] opacity-80">
                      📎 {it.attachments.join('、')}
                    </span>
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
          if (it.kind === 'thinking') {
            return <ThinkingBlock key={i} text={it.text} />;
          }
          if (it.kind === 'tool') {
            return <ToolChip key={it.id} item={it} />;
          }
          if (it.kind === 'halt') {
            return (
              <p
                key={i}
                className="rounded-lg border border-neutral-700 bg-neutral-850/40 px-2.5 py-1.5 text-[11px] text-neutral-400"
              >
                {it.text}
              </p>
            );
          }
          if (it.kind === 'stuck') {
            return (
              <div
                key={i}
                className="rounded-lg border border-red-800 bg-red-950/50 px-2.5 py-2 text-[11px] text-red-200"
              >
                <p className="whitespace-pre-wrap">{it.text.replace(/\*\*/g, '')}</p>
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button"
                    className="rounded border border-red-700 px-2 py-0.5 hover:bg-red-900"
                    onClick={() => {
                      void window.agent.restartSession().then((r) => {
                        if (r.error !== undefined) return toast(r.error);
                        toast('已重起 —— 上下文已恢复,工作量计数从 0 重新开始');
                        void refreshStatus();
                      });
                    }}
                  >
                    重起会话
                  </button>
                  <button
                    type="button"
                    className="rounded border border-red-800 px-2 py-0.5 hover:bg-red-900"
                    onClick={() => setSettingsOpen(true)}
                  >
                    去调高上限
                  </button>
                </div>
              </div>
            );
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
        {busy && <p className="text-center text-xs text-neutral-500">思考中…</p>}
      </div>

      {/* 建议按钮(D-28):点击 = 发预置提示;只读期明确降级 */}
      <div className="flex flex-wrap gap-1.5 border-t border-neutral-800 px-3 pt-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            disabled={busy}
            title={
              s.needsWrite === true && !canWrite
                ? '需要写入能力:当前是只读模式,agent 会说明能做到哪一步'
                : undefined
            }
            className="rounded-full border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
            onClick={() => void submit(s.prompt)}
          >
            {s.label}
            {s.needsWrite === true && !canWrite && (
              <span className="ml-1 text-neutral-500">·只读</span>
            )}
          </button>
        ))}
      </div>

      <div className="px-3 pt-2 pb-3">
        {(images.length > 0 || attachments.length > 0) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            {images.map((img, i) => (
              <div key={i} className="relative">
                <img
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt=""
                  className="h-12 w-12 rounded border border-neutral-600 object-cover"
                />
                <button
                  type="button"
                  className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-neutral-700 text-[10px] leading-none text-white"
                  onClick={() => setImages((p) => p.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
            {attachments.map((a, i) => (
              <span
                key={a.path}
                className="flex items-center gap-1 rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-300"
                title={a.path}
              >
                📎 {a.name}
                <button
                  type="button"
                  className="text-neutral-500 hover:text-neutral-200"
                  onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (isSubmitEnter(e) && !e.shiftKey) {
              e.preventDefault();
              void submit(draft);
            }
          }}
          rows={3}
          placeholder="给 Claude 发消息…(Enter 发送,可粘贴图片、拖入文件)"
          className="w-full resize-none rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none placeholder:text-neutral-500 focus:border-neutral-500"
        />
        <div className="mt-1 flex min-h-[18px] items-center gap-2 text-[11px] text-neutral-500">
          <button
            type="button"
            title="添加附件(复制进应用附件目录后 agent 才能读)"
            className="hover:text-neutral-200"
            onClick={pickFiles}
          >
            📎
          </button>
          {status !== null && (
            <ModePill mode={status.permissionMode} onClick={() => setSettingsOpen(true)} />
          )}
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

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-blue-500 bg-blue-950/30 text-sm text-blue-200">
          松手添加附件
        </div>
      )}

      {permQueue[0] !== undefined && (
        <ErrorBoundary label="审批弹窗">
          <PermissionPrompt
            key={permQueue[0].id}
            req={permQueue[0]}
            onDone={() => {
              const done = permQueue[0];
              setPermQueue((p) => p.slice(1));
              if (done) setItems((p) => markAwaiting(p, done, false));
            }}
          />
        </ErrorBoundary>
      )}

      {historyOpen && (
        <ErrorBoundary label="历史会话">
          <ConversationList onOpen={openConversation} onClose={() => setHistoryOpen(false)} />
        </ErrorBoundary>
      )}

      {settingsOpen && status !== null && (
        <AgentSettings
          status={status}
          onClose={() => setSettingsOpen(false)}
          onChanged={() => void refreshStatus()}
        />
      )}
    </div>
  );
}

const MODE_PILL: Record<string, { text: string; cls: string }> = {
  plan: { text: '只读', cls: 'text-neutral-400 border-neutral-700' },
  manual: { text: '逐条确认', cls: 'text-emerald-400 border-emerald-800' },
  acceptEdits: { text: '自动改已有', cls: 'text-amber-400 border-amber-800' },
  auto: { text: '自动', cls: 'text-amber-400 border-amber-800' },
  bypass: { text: '全部放行', cls: 'text-red-400 border-red-800' },
};

/** 权限模式常驻在 composer 下方 —— 用户任何时候都该知道 agent 现在能做到什么程度。 */
function ModePill({ mode, onClick }: { mode: string; onClick: () => void }): React.JSX.Element {
  const p = MODE_PILL[mode] ?? MODE_PILL['manual']!;
  return (
    <button
      type="button"
      onClick={onClick}
      title="点击修改权限模式"
      className={`rounded-full border px-2 py-0.5 text-[10px] ${p.cls}`}
    >
      {p.text}
    </button>
  );
}

/** thinking 折叠灰块(M10 三态里的 shown)。 */
function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 text-[11px] text-neutral-500">
      <button type="button" className="w-full text-left" onClick={() => setOpen(!open)}>
        💭 思考{open ? '' : `(${String(text.length)} 字)`}
      </button>
      {open && <pre className="mt-1 whitespace-pre-wrap text-neutral-500">{text}</pre>}
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
          {item.awaiting === true ? (
            <span className="text-amber-400">等待你批准…</span>
          ) : item.result === null ? (
            '…'
          ) : item.ok ? (
            '✓'
          ) : (
            '✗'
          )}
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
