import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentSettings } from './AgentSettings';
import type { AgentSettingsTab, AgentStatusVM } from './AgentSettings';
import { ConversationList } from './ConversationList';
import { BookmarkList } from './BookmarkList';
import {
  CacheBadge,
  EFFORT_LABEL,
  filterSlash,
  MODE_SHORT,
  MODE_TONE,
  ModeMenu,
  ModelMenu,
  modelLabel,
  SendButton,
  SlashMenu,
  type SlashItem,
} from './ComposerBar';
import {
  IconBookmark,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconHistory,
  IconMode,
  IconPlus,
  IconPlusCircle,
  IconSlash,
} from './icons';
import { IconButton, Popover } from './Popover';
import { recordFromUsage, type CacheRecord } from './promptCache';
import { PermissionPrompt } from './PermissionPrompt';
import { ErrorBoundary } from './ErrorBoundary';
import { toast } from './toast';
import type {
  BookmarkVM,
  ModelInfoVM,
  PermissionRequestVM,
  RewindAnchorVM,
} from '../../shared/viewModels';
import { isSubmitEnter } from './keys';
import { renderMarkdown, selectionToMarkdown } from './markdown';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { RewindDialog } from './RewindDialog';

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
  | {
      kind: 'user';
      text: string;
      imageCount: number;
      /** 图片缩略(data URI;live 发送与历史恢复都填,2026-08-27 用户反馈历史丢图) */
      images?: string[];
      /** 上一轮还在跑时排队发出的(UI 上标「排队中」,轮到它时标记消失) */
      queued?: boolean;
      attachments: string[];
      /** INV-35 回滚锚点(本地生成,一回合一个) */
      turnId?: string;
      /** forkSession 的 upToMessageId(我们自己塞给 SDK 的那个 uuid) */
      messageUuid?: string;
      /** 本地临时键:锚点要等主进程返回才回填,靠它找回这一条 */
      localKey?: string;
    }
  | {
      kind: 'assistant';
      text: string;
      anchorUuid?: string;
      /** SDK 消息 uuid(书签用;与 transcript 里存的同一个)。流式中途还没有 */
      uuid?: string;
    }
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
const SUGGESTIONS: { id: string; label: string; prompt: string; needsWrite?: boolean }[] = [
  { id: 'engage', label: '挑一件事做', prompt: '帮我挑一件现在能做的事。' },
  { id: 'today', label: '今天什么最紧', prompt: '今天什么最紧?带我判断一下轻重。' },
  { id: 'plan', label: '规划今日行程', prompt: '帮我规划今天的行程。' },
  { id: 'clarify', label: '理清收件箱', prompt: '带我理清收件箱。', needsWrite: true },
  { id: 'review', label: '开始周回顾', prompt: '带我做一次每周回顾。', needsWrite: true },
];

/** 底栏 / 顶栏同一时刻只开一个弹层 */
type Menu = 'slash' | 'model' | 'mode' | 'history' | 'bookmarks';

const shortName = (n: string): string => n.replace(/^mcp__gtd__/, '');

/**
 * 单条助手回复:渲染 Markdown;下方悬停出现「复制原文 / 书签」(VSCode 式)。
 * 已收藏的书签图标常亮 —— 否则用户看不出哪条收过。
 */
function AssistantBubble({
  text,
  register,
  bookmarked,
  flash = false,
  onToggleBookmark,
}: {
  text: string;
  register?: (el: Element | null, src: string) => void;
  bookmarked: boolean;
  /** 从书签跳过来时闪一下,告诉用户「就是这条」 */
  flash?: boolean;
  /** 没有 uuid(还在流式)时不给 —— 那时还收藏不了 */
  onToggleBookmark?: () => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group max-w-[92%]">
      <div
        className={`rounded-2xl bg-surface px-3 py-2 text-sm transition-shadow duration-300 ${
          flash ? 'ring-2 ring-acc' : ''
        }`}
      >
        <div
          data-md-bubble=""
          ref={(el) => {
            register?.(el, text);
          }}
        >
          {renderMarkdown(text)}
        </div>
      </div>
      <div className="mt-0.5 flex h-5 items-center gap-0.5 px-1 text-fnt">
        <button
          type="button"
          title="复制 Markdown 原文"
          aria-label="复制"
          className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:text-ink"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        </button>
        {onToggleBookmark !== undefined && (
          <button
            type="button"
            title={bookmarked ? '取消书签' : '加书签'}
            aria-label={bookmarked ? '取消书签' : '加书签'}
            className={`rounded p-0.5 hover:text-ink ${
              bookmarked ? 'text-acc' : 'opacity-0 group-hover:opacity-100'
            }`}
            onClick={onToggleBookmark}
          >
            <IconBookmark size={13} filled={bookmarked} />
          </button>
        )}
      </div>
    </div>
  );
}

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
  /** 设置弹窗开在哪一页;null = 关 */
  const [settingsTab, setSettingsTab] = useState<AgentSettingsTab | null>(null);
  const [openMenu, setOpenMenu] = useState<Menu | null>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);
  const toggleMenu = (m: Menu): void => setOpenMenu((cur) => (cur === m ? null : m));
  const [models, setModels] = useState<ModelInfoVM[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkVM[]>([]);
  /** Prompt 缓存记录(底栏 ⏱);nowMs 每 30s 走一格,只为重算剩余分钟 */
  const [cacheRec, setCacheRec] = useState<CacheRecord | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [slashActive, setSlashActive] = useState(0);
  /** 书签跳转后闪一下的那条 */
  const [flashUuid, setFlashUuid] = useState<string | null>(null);
  const pendingJump = useRef<string | null>(null);
  /** 只有停在底部时才跟随新消息滚动 —— 用户往上翻看(或刚跳到书签)时不能被拽回底部 */
  const stickBottom = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [dragOver, setDragOver] = useState(false);
  /** 审批请求队列 —— 一轮里可能连来两个,不能后来的把前一个挤掉 */
  const [permQueue, setPermQueue] = useState<PermissionRequestVM[]>([]);
  /** 某条用户消息上的「分叉 / 回滚」菜单 */
  const [turnMenu, setTurnMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [rewind, setRewind] = useState<{
    anchor: RewindAnchorVM;
    alsoFork: boolean;
    index: number;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textBuf = useRef('');
  const thinkBuf = useRef('');
  /** content_block index → tool chip id(input_json_delta 靠 index 找回 chip) */
  const blockTool = useRef<Map<number, string>>(new Map());
  /** 气泡 DOM → 它的 Markdown 原文(复制时按选区切片) */
  const mdSources = useRef<WeakMap<Element, string>>(new WeakMap());

  const refreshStatus = useCallback(async () => {
    setStatus((await window.agent.status()) as AgentStatusVM);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (stickBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  const jumpToUuid = useCallback((uuid: string): boolean => {
    const el = scrollRef.current?.querySelector(`[data-uuid="${CSS.escape(uuid)}"]`);
    if (!el) return false;
    stickBottom.current = false;
    el.scrollIntoView({ block: 'center' });
    setFlashUuid(uuid);
    setTimeout(() => setFlashUuid((u) => (u === uuid ? null : u)), 1600);
    return true;
  }, []);

  // 书签跳到别的会话:等那条会话的正文渲染出来再滚
  useEffect(() => {
    if (pendingJump.current !== null && jumpToUuid(pendingJump.current)) {
      pendingJump.current = null;
    }
  }, [items, jumpToUuid]);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const loadBookmarks = useCallback(() => {
    void window.agent.bookmarks().then(setBookmarks);
  }, []);
  useEffect(loadBookmarks, [loadBookmarks]);

  const loadModels = useCallback(() => {
    void window.agent.models().then(setModels);
  }, []);
  useEffect(loadModels, [loadModels]);

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

      if (type === 'system' && m['subtype'] === 'compact_boundary') {
        setCacheRec({ compactedAt: Date.now() });
        return;
      }

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
        const msg = m['message'] as { content?: { type?: string }[]; usage?: unknown } | undefined;
        const now = Date.now();
        setCacheRec((prev) => recordFromUsage(prev, msg?.usage, now));
        setNowMs(now);
        // 这条是正文 → 它的 uuid 记到刚流完的那个气泡上(书签靠它定位)
        const uuid = m['uuid'];
        if (typeof uuid === 'string' && msg?.content?.some((b) => b.type === 'text') === true) {
          setItems((p) => {
            const last = p[p.length - 1];
            if (last?.kind !== 'assistant' || last.uuid !== undefined) return p;
            return [...p.slice(0, -1), { ...last, uuid }];
          });
        }
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
        // 有排队消息时主进程的 busy 不落(下一轮马上开始)—— 以主进程为准,别在这盲设 false
        void window.agent.status().then((st) => {
          setBusy((st as { busy?: boolean }).busy === true);
        });
        // 最早那条「排队中」现在接棒开跑,把标记摘掉
        setItems((prev) => {
          const qi = prev.findIndex((x) => x.kind === 'user' && x.queued === true);
          if (qi < 0) return prev;
          return prev.map((x, k) => (k === qi ? ({ ...x, queued: false } as Item) : x));
        });
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
    // 面板是空白的(用户看到的是"新对话")就必须真开新对话 —— 2026-08-29 用户实测:
    // 这里曾经 resume 上一条,消息静默落进历史会话,而界面上什么都看不出来。
    // 想续聊旧会话的路径是历史列表点进去(那会加载出正文,所见即所得)。
    if (!s.alive) await window.agent.startSession({});
  }, []);

  const submit = useCallback(
    async (text: string) => {
      const t = text.trim();
      // busy 不再拦截:忙时照发,主进程排进 streaming 队列(对齐 Claude Code 的缓冲)
      // 只发图片 / 附件、不带文字也是一条完整的消息(2026-10-18 用户:「没办法单独发送图片」)
      if (t === '' && images.length === 0 && attachments.length === 0) return;
      stickBottom.current = true; // 自己发的消息一定要看得见
      setOpenMenu(null);
      const wasBusy = busy;
      await ensureSession();
      const localKey = crypto.randomUUID();
      setItems((p) => [
        ...p,
        {
          kind: 'user',
          text: t,
          imageCount: images.length,
          images: images.map((im) => `data:${im.mediaType};base64,${im.data}`),
          ...(wasBusy ? { queued: true } : {}),
          attachments: attachments.map((a) => a.name),
          localKey,
        } as Item,
      ]);
      setDraft('');
      textBuf.current = '';
      setBusy(true);
      const r = await window.agent.send(
        t,
        images,
        attachments.map((a) => a.path),
      );
      // 锚点要等主进程回来才知道 —— 回填到刚插入的那条
      if (r.turnId !== undefined || r.messageUuid !== undefined) {
        setItems((p) =>
          p.map((it) =>
            it.kind === 'user' && (it as { localKey?: string }).localKey === localKey
              ? ({
                  ...it,
                  ...(r.turnId !== undefined ? { turnId: r.turnId } : {}),
                  ...(r.messageUuid !== undefined ? { messageUuid: r.messageUuid } : {}),
                  queued: (r as { queued?: boolean }).queued === true,
                } as Item)
              : it,
          ),
        );
      }
      setImages([]);
      setAttachments([]);
      if (r.error !== undefined) {
        setBusy(false);
        setItems((p) => [...p, { kind: 'error', text: r.error! }]);
      }
    },
    [busy, ensureSession, images, attachments],
  );

  /**
   * 粘贴图片。
   *
   * 两个坑,都在 2026-08-13 用户反馈后实测确认:
   *
   * 1. **原来的 `btoa(String.fromCharCode(...new Uint8Array(buf)))` 会爆栈**。展开一个
   *    1MB 的 Uint8Array 等于给函数传一百万个参数 —— 实测 200KB 就 `RangeError:
   *    Maximum call stack size exceeded`,而截图基本都超这个量级。更糟的是它在 `.then`
   *    里抛,没人接,**静默失败**:用户按了 Cmd+V,什么都没发生,也没有任何提示。
   *    改用原生 `FileReader.readAsDataURL`,没有大小限制,base64 由浏览器做。
   * 2. **原来只挂在 textarea 上**,焦点不在输入框时粘贴无效。改挂到整个面板 ——
   *    用户的心智是"随时都能粘",不该要求他先点一下输入框。
   */
  const readImage = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      if (comma < 0) return void toast('这张图片读不出来');
      setImages((p) => [...p, { data: url.slice(comma + 1), mediaType: file.type }]);
    };
    reader.onerror = () => toast(`图片读取失败:${reader.error?.message ?? '未知错误'}`);
    reader.readAsDataURL(file);
  };

  const onPaste = (e: React.ClipboardEvent): void => {
    const files = [...e.clipboardData.items]
      .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    // 有图就别让浏览器再把剪贴板里的文本塞进输入框
    e.preventDefault();
    for (const f of files) readImage(f);
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

  const newSession = (): void => {
    setOpenMenu(null);
    void window.agent.newSession().then(() => {
      setItems([]);
      setCacheRec(null);
      void refreshStatus();
    });
  };

  const openSettings = (tab: AgentSettingsTab): void => {
    setOpenMenu(null);
    setSettingsTab(tab);
  };

  const toggleBookmark = (uuid: string, text: string): void => {
    const conversationId = status?.conversationId;
    if (conversationId == null) return toast('还没有会话,收藏不了');
    void window.agent.toggleBookmark({ conversationId, uuid, preview: text }).then(loadBookmarks);
  };

  const openConversation = (id: string, fork: boolean): void => {
    setOpenMenu(null);
    setItems([]);
    setCacheRec(null);
    stickBottom.current = true;
    void (async () => {
      const t = await window.agent.transcript(id);
      setItems(
        t.items.map((x) =>
          x.role === 'user'
            ? {
                kind: 'user' as const,
                text: x.text,
                imageCount: x.images.length,
                images: x.images,
                attachments: [],
                ...(x.uuid !== null ? { messageUuid: x.uuid } : {}),
              }
            : {
                kind: 'assistant' as const,
                text:
                  x.text === '' && x.tools.length > 0
                    ? `(调用了 ${x.tools.map(shortName).join('、')})`
                    : x.text,
                ...(x.uuid !== null && x.text !== '' ? { uuid: x.uuid } : {}),
              },
        ),
      );
      await window.agent.startSession({ conversationId: id, fork });
      await refreshStatus();
    })();
  };

  const canWrite = status !== null && status.permissionMode !== 'plan';

  // ------------------------------------------------------------ 「/」命令

  const slashItems: SlashItem[] = [
    ...SUGGESTIONS.map((sg) => ({
      id: sg.id,
      group: '开场',
      label: sg.label,
      hint: sg.prompt,
      ...(busy ? { disabledReason: '正在回复中' } : {}),
      run: () => void submit(sg.prompt),
    })),
    { id: 'new', group: '会话', label: '新会话', run: newSession },
    {
      id: 'history',
      group: '会话',
      label: '历史会话',
      hint: '改名 · 分叉 · 归档 · 删除',
      run: () => setOpenMenu('history'),
    },
    {
      id: 'bookmarks',
      group: '会话',
      label: '书签',
      run: () => {
        loadBookmarks();
        setOpenMenu('bookmarks');
      },
    },
    {
      id: 'model',
      group: '设置',
      label: '切换模型 / 思考深度',
      run: () => {
        loadModels();
        setOpenMenu('model');
      },
    },
    { id: 'mode', group: '设置', label: '切换权限模式', run: () => setOpenMenu('mode') },
    {
      id: 'settings',
      group: '设置',
      label: '设置…',
      hint: '账号与用量 · 我的偏好 · Skills · 权限 · 工具',
      run: () => openSettings('account'),
    },
  ];
  /** 行首键入的「/xxx」就是过滤词;按钮打开时不过滤 */
  const SLASH_TYPED = /^\/\S*$/;
  const slashShown = filterSlash(slashItems, SLASH_TYPED.test(draft) ? draft.slice(1) : '');

  const runSlash = (it: SlashItem): void => {
    if (it.disabledReason !== undefined) return;
    if (SLASH_TYPED.test(draft)) setDraft('');
    setOpenMenu(null);
    it.run(); // 它自己可能再开一个弹层(历史 / 模型…),在同一批更新里覆盖上面的 null
  };

  const onDraftChange = (v: string): void => {
    setDraft(v);
    // 行首键入「/」= 打开命令菜单并按后面的字过滤;删掉「/」或打了空格(在写正文)就收起。
    // 不论菜单是怎么打开的,一开始写正文就收 —— 否则回车会执行命令而不是发出去
    if (SLASH_TYPED.test(v)) {
      setSlashActive(0);
      setOpenMenu('slash');
    } else if (openMenu === 'slash') {
      setOpenMenu(null);
    }
  };

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (openMenu === 'slash' && slashShown.length > 0) {
      const n = slashShown.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : n - 1;
        setSlashActive((i) => (Math.min(i, n - 1) + step) % n);
        return;
      }
      if (isSubmitEnter(e) && !e.shiftKey) {
        e.preventDefault();
        const it = slashShown[Math.min(slashActive, n - 1)];
        if (it !== undefined) runSlash(it);
        return;
      }
    }
    // 没有匹配的命令时回车照常发送 —— 「/compact」这类 Claude Code 自带命令按原文发过去
    if (isSubmitEnter(e) && !e.shiftKey) {
      e.preventDefault();
      void submit(draft);
    }
  };

  return (
    <div
      className="theme-panel relative flex h-full flex-col bg-app text-ink"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      {/* 顶栏(VSCode 式):左边会话标题,右边 书签 / 历史 / 新会话 */}
      <div className="relative flex items-center gap-1 border-b border-line py-1.5 pr-2 pl-4">
        <span
          className="min-w-0 flex-1 truncate text-sm font-semibold"
          title={status?.email != null ? `Claude 账号:${status.email}` : undefined}
        >
          {items.length === 0 ? '新会话' : (status?.conversationTitle ?? '新会话')}
        </span>
        {status !== null && !status.loggedIn && (
          <button
            type="button"
            title="没检测到 Claude Code 登录 —— 打开账号设置"
            className="rounded px-1.5 py-0.5 text-[11px] text-warn-ink hover:bg-hov"
            onClick={() => openSettings('account')}
          >
            ● 未登录
          </button>
        )}
        <IconButton
          title="书签"
          toggle
          active={openMenu === 'bookmarks'}
          onClick={() => {
            loadBookmarks();
            toggleMenu('bookmarks');
          }}
        >
          <IconBookmark />
        </IconButton>
        <IconButton
          title="历史会话"
          toggle
          active={openMenu === 'history'}
          onClick={() => toggleMenu('history')}
        >
          <IconHistory />
        </IconButton>
        <IconButton title="新会话" onClick={newSession}>
          <IconPlusCircle />
        </IconButton>

        <Popover
          open={openMenu === 'history'}
          onClose={closeMenu}
          className="top-full right-2 left-2 mt-1"
        >
          <ErrorBoundary label="历史会话">
            <ConversationList onOpen={openConversation} onChanged={() => void refreshStatus()} />
          </ErrorBoundary>
        </Popover>
        <Popover
          open={openMenu === 'bookmarks'}
          onClose={closeMenu}
          className="top-full right-2 left-2 mt-1"
        >
          <BookmarkList
            marks={bookmarks}
            onJump={(b) => {
              setOpenMenu(null);
              if (jumpToUuid(b.uuid)) return;
              pendingJump.current = b.uuid;
              openConversation(b.conversationId, false);
            }}
            onRemove={(b) =>
              void window.agent
                .toggleBookmark({ conversationId: b.conversationId, uuid: b.uuid, preview: '' })
                .then(loadBookmarks)
            }
          />
        </Popover>
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3 select-text"
        onCopy={(e) => {
          // 渲染成 HTML 之后,浏览器默认复制的是**看得见的文字**(`**粗体**` 变成 `粗体`)。
          // 用户要的是能粘回去仍然成立的 Markdown 原文,所以自己接管 copy。
          const sel = window.getSelection();
          if (sel === null) return;
          const md = selectionToMarkdown(sel, (el) => mdSources.current.get(el) ?? null);
          if (md === null) return; // 选区不在气泡里 → 交回浏览器默认行为
          e.clipboardData.setData('text/plain', md);
          e.preventDefault();
        }}
      >
        {status !== null && !status.loggedIn && (
          <div className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">
            没检测到本机 Claude Code 登录。请在终端执行 <code>claude</code> 完成登录,然后点下面的
            重试 —— 不用重启应用。
            <button type="button" className="ml-2 underline" onClick={() => void refreshStatus()}>
              重试
            </button>
          </div>
        )}
        {items.length === 0 && (
          <div className="px-1 py-6 text-center">
            <p className="text-xs text-fnt">
              {canWrite
                ? '我能查你的任务并按你的确认帮你改。每次写入都会先问你(可在底栏切换权限模式)。'
                : '只读模式:我能查你的任务、项目、日历、标签与过滤器,但改不了数据。'}
            </p>
            {/* 建议按钮(D-28):点击 = 发预置提示;只读期明确降级。
                VSCode 式 composer 下没有常驻按钮了 —— 空会话在这里给,随时在「/」菜单里也有 */}
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={busy}
                  title={
                    s.needsWrite === true && !canWrite
                      ? '需要写入能力:当前是只读模式,agent 会说明能做到哪一步'
                      : s.prompt
                  }
                  className="rounded-full border border-line px-2.5 py-1 text-[11px] text-mut hover:bg-hov disabled:opacity-40"
                  onClick={() => void submit(s.prompt)}
                >
                  {s.label}
                  {s.needsWrite === true && !canWrite && (
                    <span className="ml-1 text-fnt">·只读</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((it, i) => {
          if (it.kind === 'user') {
            return (
              <div
                key={i}
                className="group flex justify-end"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTurnMenu({ x: e.clientX, y: e.clientY, index: i });
                }}
              >
                <div className="max-w-[85%] rounded-2xl bg-acc px-3 py-1.5 text-sm whitespace-pre-wrap text-on-acc select-text">
                  {(it.images?.length ?? 0) > 0 && (
                    <div className={`flex flex-wrap gap-1 ${it.text !== '' ? 'mb-1' : ''}`}>
                      {it.images!.map((src, k) => (
                        <img
                          key={k}
                          src={src}
                          alt=""
                          className="max-h-40 max-w-full rounded-lg border border-line-soft/40"
                        />
                      ))}
                    </div>
                  )}
                  {it.text}
                  {it.queued === true && (
                    <span className="ml-1 text-[11px] opacity-80">⏳ 排队中</span>
                  )}
                  {it.imageCount > 0 && (it.images?.length ?? 0) === 0 && (
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
                {...(it.uuid !== undefined ? { 'data-uuid': it.uuid } : {})}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTurnMenu({ x: e.clientX, y: e.clientY, index: i });
                }}
              >
                <AssistantBubble
                  text={it.text}
                  register={(el, src) => {
                    if (el !== null) mdSources.current.set(el, src);
                  }}
                  flash={it.uuid !== undefined && it.uuid === flashUuid}
                  bookmarked={
                    it.uuid !== undefined &&
                    bookmarks.some(
                      (b) => b.uuid === it.uuid && b.conversationId === status?.conversationId,
                    )
                  }
                  {...(it.uuid !== undefined
                    ? { onToggleBookmark: () => toggleBookmark(it.uuid!, it.text) }
                    : {})}
                />
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
                className="rounded-lg border border-line bg-surface/40 px-2.5 py-1.5 text-[11px] text-mut"
              >
                {it.text}
              </p>
            );
          }
          if (it.kind === 'stuck') {
            return (
              <div
                key={i}
                className="rounded-lg border border-danger bg-danger-soft px-2.5 py-2 text-[11px] text-danger-ink"
              >
                <p className="whitespace-pre-wrap">{it.text.replace(/\*\*/g, '')}</p>
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button"
                    className="rounded border border-danger px-2 py-0.5 hover:bg-danger-soft"
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
                    className="rounded border border-danger px-2 py-0.5 hover:bg-danger-soft"
                    onClick={() => openSettings('account')}
                  >
                    去调高上限
                  </button>
                </div>
              </div>
            );
          }
          if (it.kind === 'error') {
            return (
              <p key={i} className="px-1 text-xs text-danger-ink">
                {it.text}
              </p>
            );
          }
          return (
            <p key={i} className="px-1 text-center text-[11px] text-fnt">
              {it.text}
            </p>
          );
        })}
        {busy && <p className="text-center text-xs text-fnt">思考中…</p>}
      </div>

      {/* Composer(VSCode 式):圆角输入框,底栏 + / ⏱ 模型 ‖ 权限 发送 */}
      <div className="relative px-3 pt-2 pb-3">
        <Popover
          open={openMenu === 'slash'}
          onClose={closeMenu}
          className="right-3 bottom-full left-3 mb-1"
        >
          <SlashMenu
            items={slashShown}
            active={Math.min(slashActive, Math.max(0, slashShown.length - 1))}
            onHover={setSlashActive}
            onPick={runSlash}
          />
        </Popover>
        <Popover
          open={openMenu === 'model'}
          onClose={closeMenu}
          className="right-3 bottom-full left-3 mb-1"
        >
          {status !== null && (
            <ModelMenu
              status={status}
              models={models}
              onChanged={() => void refreshStatus()}
              onPicked={closeMenu}
              onMore={() => openSettings('account')}
            />
          )}
        </Popover>
        <Popover
          open={openMenu === 'mode'}
          onClose={closeMenu}
          className="right-3 bottom-full left-3 mb-1"
        >
          {status !== null && (
            <ModeMenu
              mode={status.permissionMode}
              onChanged={() => void refreshStatus()}
              onPicked={closeMenu}
              onMore={() => openSettings('permissions')}
            />
          )}
        </Popover>

        <div className="rounded-xl border border-line bg-surface focus-within:border-acc">
          {(images.length > 0 || attachments.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 px-2.5 pt-2.5">
              {images.map((img, i) => (
                <div key={i} className="relative">
                  <img
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt=""
                    className="h-12 w-12 rounded border border-line object-cover"
                  />
                  <button
                    type="button"
                    className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-sel text-[10px] leading-none text-ink"
                    onClick={() => setImages((p) => p.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
              {attachments.map((a, i) => (
                <span
                  key={a.path}
                  className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-mut"
                  title={a.path}
                >
                  📎 {a.name}
                  <button
                    type="button"
                    className="text-fnt hover:text-ink"
                    onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={onComposerKey}
            rows={3}
            placeholder="给 Claude 发消息…(Enter 发送,/ 打开命令;图片可粘贴,文件可拖入)"
            className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-fnt"
          />
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
            <IconButton title="添加附件(复制进应用附件目录后 agent 才能读)" onClick={pickFiles}>
              <IconPlus />
            </IconButton>
            <IconButton
              title="命令(也可以在输入框里键入 /)"
              toggle
              active={openMenu === 'slash'}
              onClick={() => {
                if (openMenu === 'slash') return setOpenMenu(null);
                // 同 VSCode:空输入框先填一个「/」,接着打的字就是过滤词
                if (draft === '') setDraft('/');
                setSlashActive(0);
                setOpenMenu('slash');
                inputRef.current?.focus();
              }}
            >
              <IconSlash />
            </IconButton>
            <CacheBadge rec={cacheRec} now={nowMs} />
            {status !== null && (
              <button
                type="button"
                data-popover-toggle=""
                title="切换模型与思考深度"
                className={`flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-hov ${
                  openMenu === 'model' ? 'bg-hov' : ''
                }`}
                onClick={() => {
                  if (openMenu !== 'model') loadModels();
                  toggleMenu('model');
                }}
              >
                {/* 窄面板里先截思考深度,模型名永远完整 —— 用户最先要确认的是「现在是哪个模型」 */}
                <span className="shrink-0 text-ink">{modelLabel(models, status.model)}</span>
                {status.effort !== null && status.thinking !== 'off' && (
                  <span className="min-w-0 truncate text-fnt">
                    {EFFORT_LABEL[status.effort] ?? status.effort}
                  </span>
                )}
                <IconChevronDown size={12} className="shrink-0 text-fnt" />
              </button>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {status !== null && (
                <button
                  type="button"
                  data-popover-toggle=""
                  title="权限模式:agent 写入前要不要问你"
                  className={`flex h-7 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-hov ${
                    MODE_TONE[status.permissionMode] ?? ''
                  } ${openMenu === 'mode' ? 'bg-hov' : ''}`}
                  onClick={() => toggleMenu('mode')}
                >
                  <IconMode mode={status.permissionMode} size={14} />
                  {MODE_SHORT[status.permissionMode] ?? status.permissionMode}
                </button>
              )}
              <SendButton
                canSend={draft.trim() !== '' || images.length > 0 || attachments.length > 0}
                busy={busy}
                onSend={() => void submit(draft)}
                onStop={() => void window.agent.interrupt()}
              />
            </div>
          </div>
        </div>
      </div>

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-acc bg-acc-soft text-sm text-acc">
          松手添加附件
        </div>
      )}

      {turnMenu !== null &&
        (() => {
          const convId = status?.conversationId ?? null;
          const close = (): void => setTurnMenu(null);
          // 锚点:从点中的位置往前找最近一条**带锚点**的消息。
          // 助手气泡上右键 = 锚到它对应的那条用户消息(回滚的语义是"回到我发那句之前")。
          let anchor: { turnId?: string | undefined; anchorUuid?: string | undefined } | null =
            null;
          for (let k = turnMenu.index; k >= 0; k -= 1) {
            const m = items[k];
            if (m === undefined) continue;
            if (m.kind === 'user' && (m.turnId !== undefined || m.messageUuid !== undefined)) {
              anchor = { turnId: m.turnId, anchorUuid: m.messageUuid };
              break;
            }
            if (m.kind === 'assistant' && m.anchorUuid !== undefined) {
              anchor = { anchorUuid: m.anchorUuid };
              break;
            }
          }
          const why =
            convId === null
              ? '还没有会话'
              : anchor === null
                ? '这条消息定位不到轮次(可能来自更早的版本)'
                : null;
          const canFork = why === null && anchor?.anchorUuid !== undefined;
          return (
            <ContextMenu x={turnMenu.x} y={turnMenu.y} onClose={close}>
              {why !== null && <div className="px-3 py-1.5 text-[11px] text-mut">{why}</div>}
              <ContextMenuItem
                disabled={!canFork}
                title={canFork ? undefined : '这条消息没有可用于分叉的标识'}
                onClick={() => {
                  close();
                  if (convId === null || anchor?.anchorUuid === undefined) return;
                  void window.agent.forkAt(convId, anchor.anchorUuid).then((r) => {
                    if (r.error !== undefined) return toast(`分叉失败:${r.error}`);
                    toast('已从这里分叉 —— 原对话保留在历史里');
                    setItems((p) => p.slice(0, turnMenu.index));
                    void refreshStatus();
                  });
                }}
              >
                ⑂ 从这里分叉对话
              </ContextMenuItem>
              <ContextMenuItem
                danger
                disabled={why !== null}
                onClick={() => {
                  close();
                  if (convId !== null && anchor !== null) {
                    setRewind({
                      anchor: { conversationId: convId, ...anchor },
                      alsoFork: false,
                      index: turnMenu.index,
                    });
                  }
                }}
              >
                ↺ 回滚到这里(撤销 agent 的改动)
              </ContextMenuItem>
              <ContextMenuItem
                danger
                disabled={why !== null || !canFork}
                onClick={() => {
                  close();
                  if (convId !== null && anchor !== null) {
                    setRewind({
                      anchor: { conversationId: convId, ...anchor },
                      alsoFork: true,
                      index: turnMenu.index,
                    });
                  }
                }}
              >
                ⑂↺ 分叉并回滚
              </ContextMenuItem>
            </ContextMenu>
          );
        })()}

      {rewind !== null && (
        <RewindDialog
          anchor={rewind.anchor}
          alsoFork={rewind.alsoFork}
          onClose={() => setRewind(null)}
          onDone={() => {
            const anchorIdx = rewind.index;
            setRewind(null);
            // 回滚就地截断对话(用户定案):不截断的话 agent 会基于"说做了、其实没做"的
            // 上下文继续操作
            setItems((p) => p.slice(0, anchorIdx));
            void refreshStatus();
          }}
        />
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

      {settingsTab !== null && status !== null && (
        <AgentSettings
          status={status}
          initialTab={settingsTab}
          onClose={() => {
            setSettingsTab(null);
            loadModels(); // 设置里可能换了 Claude Code 版本 → 模型目录跟着变
          }}
          onChanged={() => void refreshStatus()}
        />
      )}
    </div>
  );
}

/** thinking 折叠灰块(M10 三态里的 shown)。 */
function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-line-soft bg-app/60 px-2.5 py-1.5 text-[11px] text-fnt">
      <button type="button" className="w-full text-left" onClick={() => setOpen(!open)}>
        💭 思考{open ? '' : `(${String(text.length)} 字)`}
      </button>
      {open && <pre className="mt-1 whitespace-pre-wrap text-fnt">{text}</pre>}
    </div>
  );
}

/** 工具调用 chip:入参实时长出,结果折叠。 */
function ToolChip({ item }: { item: Extract<Item, { kind: 'tool' }> }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-line-soft bg-surface/40 px-2.5 py-1.5 text-[11px]">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setOpen(!open)}
      >
        <span className={item.result === null ? 'animate-pulse' : ''}>🔧</span>
        <span className="font-mono text-mut">{shortName(item.name)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-fnt">{item.input}</span>
        <span className="shrink-0 text-fnt">
          {item.awaiting === true ? (
            <span className="text-warn-ink">等待你批准…</span>
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
        <pre className="mt-1 max-h-56 overflow-auto rounded bg-inset p-2 text-[10px] whitespace-pre-wrap text-mut">
          {item.result}
        </pre>
      )}
    </div>
  );
}
