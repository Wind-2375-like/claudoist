import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  EffortLevel,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { createGtdServer, nowLine, statusSnapshot } from '@gtd/agent-tools';
import type { ReadToolDeps, WriteToolDeps } from '@gtd/agent-tools';
import { resolveClaudeBinary } from './cliPath';
import { skillsOption } from './skills';
import { ensureUserMemory } from './userMemory';
import { buildSystemPrompt } from './systemPrompt';
import { rejectAllPending } from './permissions';
import { sdkPermissionMode, type PermissionModeId } from '@gtd/agent-tools';

/**
 * 会话管理(DESIGN §6.2)。M1 spike 是"一次 send 一个 `query()`",M8 起是
 * **一会话一个长驻 streaming-input `query()`**。
 *
 * 为什么必须是长驻 + streaming input:SDK 的控制方法(`interrupt()`、`setModel()`、
 * `setPermissionMode()`、`applyFlagSettings()`)在 .d.ts 上都写着
 * "Only available in streaming input mode"。一次一 query 拿不到它们 —— 尤其
 * `interrupt()`,那是"只停当前 turn、会话继续"的唯一手段。
 *
 * **中断分两级**(最容易做错的地方):
 * - `interrupt()` → 停当前 turn,会话还活着,可以接着聊;
 * - `AbortController.abort()` → 杀掉整个 `query()`,**等于销毁会话**,只用于关闭会话
 *   与应用退出。
 *
 * **工具面**:`tools: ['Skill']` 关掉 SDK 全部内置工具(Bash/Read/Write/Edit…)只留
 * Skill,再经 `mcpServers` 注入 GTD 工具。注意 `allowedTools` **不是**"有哪些工具",
 * 它只是"免确认自动放行"名单 —— 只写 allowedTools 而不收 `tools`,Bash 依然可用,
 * 而 Bash 能跑 `pnpm cli complete`,任何权限模式都名存实亡。
 *
 * **M9 起不再用 `allowedTools`**:放行一律经 `canUseTool`(见 permissionPolicy.ts 的
 * 说明),这样每一次工具调用都能落进 `agent_audit`,包括自动放行的那些。
 */

export interface SessionEvent {
  type: 'message' | 'error' | 'ended';
  /** SDKMessage 序列化后原样透传给渲染层;error/ended 时为说明文本 */
  payload?: unknown;
  message?: string;
}

interface LiveSession {
  q: Query;
  /** streaming-input 的推送口 */
  push: (m: SDKUserMessage) => void;
  close: () => void;
  abort: AbortController;
  /** SDK 侧会话 id,首条 system/init 到达后填 */
  sdkSessionId: string | null;
  busy: boolean;
  conversationId: string;
}

let live: LiveSession | null = null;

export interface AgentImage {
  data: string;
  mediaType: string;
}

/**
 * 把用户消息变成 SDK 需要的形状。
 *
 * **每条消息都前置"此刻"**(时刻/星期/时区/地区)。只在会话开头注入一次不够:长会话
 * 跨几小时甚至隔夜,模型对"现在"的印象会停在开场那一刻,于是把下周的会议当成现在能做
 * 的事(M8 复测实录)。时间戳单独成一个 content block,不与用户原话混在一起。
 *
 * 附件(M10)以绝对路径附在末尾:文件已复制进 userData/attachments,内置 Read 可直接读。
 */
function userMessage(text: string, images: AgentImage[], attachments: string[]): SDKUserMessage {
  const content: unknown[] = [{ type: 'text', text: nowLine() }];
  content.push(
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })),
  );
  const body =
    attachments.length > 0
      ? `${text}\n\n附件(可用 Read 工具读取):\n${attachments.map((p) => `- ${p}`).join('\n')}`
      : text;
  content.push({ type: 'text', text: body });
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

/**
 * 手写一个可外部推送的 AsyncIterable —— SDK 的 streaming input 要的就是它。
 * 用等待队列而不是轮询:没有待消费消息时 `next()` 挂起,推一条就唤醒一个。
 */
function pushableStream(): {
  iterable: AsyncIterable<SDKUserMessage>;
  push: (m: SDKUserMessage) => void;
  close: () => void;
} {
  const queue: SDKUserMessage[] = [];
  let resolveNext: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  let closed = false;
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            const queued = queue.shift();
            if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
            if (closed) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((res) => {
              resolveNext = res;
            });
          },
          return(): Promise<IteratorResult<SDKUserMessage>> {
            closed = true;
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    },
    push(m) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: m, done: false });
      } else {
        queue.push(m);
      }
    },
    close() {
      closed = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as never, done: true });
      }
    },
  };
}

/**
 * 附件根目录 —— **唯一**被授权的目录(M10)。逐个文件授权会让用户面对一串弹窗,
 * 而授权文件原处的目录等于把 agent 放进用户的整个文件系统。复制进这里再授权这一个根,
 * 是两者之外的第三条路。
 */
export function attachmentsDir(): string {
  const dir = join(app.getPath('userData'), 'attachments');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function buildEnv(): Record<string, string | undefined> {
  // ⚠ SDK 的 env 一旦设置就**整体替换**(不与 process.env 合并),所以必须先 spread
  const env: Record<string, string | undefined> = { ...process.env };
  // 主认证路径(DESIGN §6.1):不注入 ANTHROPIC_API_KEY,复用本机 Claude Code 登录。
  // 防御:宿主(如 VSCode 派生 shell)可能泄漏 ELECTRON_RUN_AS_NODE,会让子进程跑成 node。
  delete env['ELECTRON_RUN_AS_NODE'];
  // CLAUDE_CONFIG_DIR **不设置**:M1 实证重定向到空目录会使订阅凭据不可见(Not logged in)。
  return env;
}

export interface StartSessionInput {
  deps: ReadToolDeps;
  /** 给了才注册写工具;只读模式(plan)下宿主直接不传 */
  write?: WriteToolDeps;
  settings: { get<T>(key: string): T | null; set(key: string, value: unknown): void };
  /** 本地会话行 id(审计外键、用量归集) */
  conversationId: string;
  /** 续接已有 SDK 会话;缺省 = 新会话 */
  resume?: string;
  /** 与 resume 搭配:从该会话分叉出一条新的(原会话不受影响) */
  forkSession?: boolean;
  model?: string;
  effort?: EffortLevel;
  thinking?: ThinkingConfig;
  permissionMode: PermissionModeId;
  canUseTool: CanUseTool;
  /** 省略 = 不限。**别用 0 表达"不限"**:0 预算会让会话一开口就熄火 */
  maxTurns?: number;
  maxBudgetUsd?: number;
}

/** 起一个长驻会话;返回后即可 `send()`。同一时刻只维持一个。 */
export function startSession(input: StartSessionInput, onEvent: (e: SessionEvent) => void): void {
  destroySession();
  // 用户可调的那层 prompt:SDK 会从 cwd 读 CLAUDE.md(settingSources 含 'project')。
  // 只在缺失时创建,之后是用户的文件,我们不碰。
  ensureUserMemory();
  const stream = pushableStream();
  const abort = new AbortController();

  const options: Options = {
    // 会话按 cwd 隔离在 ~/.claude/projects/<encoded>/ 下,与用户自己的 CLI 项目互不混淆
    cwd: app.getPath('userData'),
    env: buildEnv(),
    pathToClaudeCodeExecutable: resolveClaudeBinary(),
    abortController: abort,
    includePartialMessages: true,
    // 内置工具只留 `Skill` 与 `Read`(`tools: []` 会连 Skill 一起关掉 —— 冒烟实测过)。
    // Read 是附件功能的必要条件(M10:拖进来的文件靠它读)。Write/Edit/Bash/WebFetch
    // 一概不给:Bash 能跑 `pnpm cli complete`,给了它任何权限模式都名存实亡。
    tools: ['Skill', 'Read'],
    mcpServers: {
      gtd: createGtdServer({ ...input.deps, ...(input.write ? { write: input.write } : {}) }),
    },
    // 只用我们注入的 MCP,不加载 .mcp.json / 用户设置里的服务器
    strictMcpConfig: true,
    // 放行全部经 canUseTool(审计完整性,见 permissionPolicy.ts);故不设 allowedTools
    canUseTool: input.canUseTool,
    permissionMode: sdkPermissionMode(input.permissionMode),
    // 附件只授权这一个稳定根目录,而不是逐个文件/目录授权
    additionalDirectories: [attachmentsDir()],
    // 用户的 ~/.claude/settings.json 不得影响应用行为;project/local 保留以便 skill 发现
    settingSources: ['project', 'local'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: buildSystemPrompt(statusSnapshot(input.deps), {
        canWrite: input.write !== undefined,
        permissionMode: input.permissionMode,
      }),
    },
    ...skillsOption(input.settings),
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
    ...(input.resume !== undefined ? { resume: input.resume } : {}),
    ...(input.forkSession === true ? { forkSession: true } : {}),
  };

  const q = query({ prompt: stream.iterable, options });
  live = {
    q,
    push: stream.push,
    close: stream.close,
    abort,
    sdkSessionId: null,
    busy: false,
    conversationId: input.conversationId,
  };

  void (async () => {
    try {
      for await (const msg of q) {
        const m = msg as SDKMessage & { type: string; subtype?: string; session_id?: string };
        if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
          if (live) live.sdkSessionId = m.session_id;
        }
        if (m.type === 'result' && live) live.busy = false;
        onEvent({ type: 'message', payload: m });
      }
      onEvent({ type: 'ended' });
    } catch (e) {
      // abort 是我们自己发的(销毁会话/退出),不算错误
      if (!abort.signal.aborted) {
        onEvent({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
      onEvent({ type: 'ended' });
    } finally {
      if (live?.q === q) live = null;
      rejectAllPending('会话已结束');
    }
  })();
}

// ------------------------------------------------------------------ 控制

export function sessionAlive(): boolean {
  return live !== null;
}

export function sessionBusy(): boolean {
  return live?.busy === true;
}

export function sdkSessionId(): string | null {
  return live?.sdkSessionId ?? null;
}

/**
 * 活会话的 Query,供只读控制方法蹭用(见 probe.ts)。
 * **调用方拿到它只能读**;任何会终止会话的操作都必须走 destroySession()。
 */
export function liveQuery(): Query | null {
  return live?.q ?? null;
}

export function currentConversationId(): string | null {
  return live?.conversationId ?? null;
}

export function send(
  text: string,
  images: AgentImage[],
  attachments: string[] = [],
): { error?: string } {
  if (!live) return { error: '会话未启动' };
  if (live.busy) return { error: '上一条消息还在处理中' };
  live.busy = true;
  live.push(userMessage(text, images, attachments));
  return {};
}

/** 只停当前 turn —— 会话继续存活,可以接着聊。 */
export async function interruptTurn(): Promise<void> {
  if (!live) return;
  try {
    await live.q.interrupt();
  } finally {
    if (live) live.busy = false;
    // 挂起中的审批要一并打回:中断了却还弹着窗,用户点哪个都别扭
    rejectAllPending('本轮已中断');
  }
}

/** 销毁会话(关闭聊天 / 应用退出)。这才是 AbortController 的用途。 */
export function destroySession(): void {
  if (!live) return;
  const s = live;
  live = null;
  s.close();
  s.abort.abort();
  rejectAllPending('会话已结束');
}

app.on('will-quit', destroySession);

/**
 * 切换模型。
 *
 * **没有活会话不是错误** —— 调用方已经把选择落了盘,下次起会话自然带上。
 * 这里只负责"如果现在有会话,顺便热切一下"。早先版本在无会话时返回
 * `{error: '会话未启动'}`,于是界面写着"先发一条消息再回来切模型" ——
 * 那个限制是我们自己加的,SDK 侧并不存在。
 */
export async function setModel(model: string): Promise<{ applied: boolean; error?: string }> {
  if (!live) return { applied: false };
  try {
    await live.q.setModel(model);
    return { applied: true };
  } catch (e) {
    // SDK 自带模型名校验,它的报错文案可以直接给用户看
    return { applied: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 会话中途改 effort(flag settings 层,不写用户的 settings 文件)。 */
export async function setEffort(
  effort: EffortLevel,
): Promise<{ applied: boolean; error?: string }> {
  if (!live) return { applied: false };
  try {
    await live.q.applyFlagSettings({ effortLevel: effort });
    return { applied: true };
  } catch (e) {
    return { applied: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * thinking 三态:关 / 开但折叠 / 开且展示。
 * 用 `setMaxThinkingTokens(n, display)` —— 它在 streaming 模式下可中途生效,
 * 而 `thinking` 选项只能在起会话时给。
 */
export async function setThinking(
  mode: 'off' | 'hidden' | 'shown',
): Promise<{ applied: boolean; error?: string }> {
  if (!live) return { applied: false };
  try {
    // 从 off 切回来时**必须显式给 display**:以 thinking 关闭起的会话没有 display 模式,
    // 只传 null 会拿到 API 默认值而不是你以为的那个
    if (mode === 'off') await live.q.setMaxThinkingTokens(0, null);
    else await live.q.setMaxThinkingTokens(null, mode === 'shown' ? 'summarized' : 'omitted');
    return { applied: true };
  } catch (e) {
    return { applied: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 切权限模式 —— plan ↔ 其它需要通知 SDK(它据此调整自己的行为提示)。 */
export async function setPermissionMode(mode: PermissionModeId): Promise<{ error?: string }> {
  if (!live) return {};
  try {
    await live.q.setPermissionMode(sdkPermissionMode(mode));
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
