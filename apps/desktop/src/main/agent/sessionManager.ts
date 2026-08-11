import { app } from 'electron';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createGtdReadServer,
  qualifiedToolName,
  READ_TOOL_NAMES,
  statusSnapshot,
} from '@gtd/agent-tools';
import type { ReadToolDeps } from '@gtd/agent-tools';
import { resolveClaudeBinary } from './cliPath';
import { skillsOption } from './skills';
import { buildSystemPrompt } from './systemPrompt';

/**
 * 会话管理(DESIGN §6.2)。M1 spike 是"一次 send 一个 `query()`",M8 换成
 * **一会话一个长驻 streaming-input `query()`**。
 *
 * 为什么必须是长驻 + streaming input:SDK 的控制方法(`interrupt()`、`setModel()`、
 * `setPermissionMode()`)在 .d.ts 上都写着 "Only available in streaming input mode"。
 * 一次一 query 拿不到它们 —— 尤其 `interrupt()`,那是"只停当前 turn、会话继续"的
 * 唯一手段。
 *
 * **中断分两级**(这是最容易做错的地方):
 * - `interrupt()` → 停当前 turn,会话还活着,可以接着聊;
 * - `AbortController.abort()` → 杀掉整个 `query()`,**等于销毁会话**,只用于关闭会话
 *   与应用退出。
 * 早先文档把 `agent:interrupt` 写成接 AbortController,那样"中断后会话可继续"这条
 * 验收标准根本不可能成立。
 *
 * **只读保证**:`tools: []` 关掉 SDK 全部内置工具(Bash/Read/Write/Edit…),再经
 * `mcpServers` 只注入 GTD 只读工具。注意 `allowedTools` **不是**"有哪些工具",
 * 它只是"免确认自动放行"名单 —— 只写 allowedTools 而不收 `tools`,Bash 依然可用,
 * 而 Bash 能跑 `pnpm cli complete`,"只读"就名存实亡了。
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
}

let live: LiveSession | null = null;

/** 把用户消息变成 SDK 需要的形状;图片在前、文本在后(与 M1 spike 一致)。 */
export interface AgentImage {
  data: string;
  mediaType: string;
}

function userMessage(text: string, images: AgentImage[]): SDKUserMessage {
  const content: unknown[] = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));
  content.push({ type: 'text', text });
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
  /** 续接已有会话(SDK session id);缺省 = 新会话 */
  resume?: string;
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
}

/** 起一个长驻会话;返回后即可 `send()`。同一时刻只维持一个(M10 再做多会话)。 */
export function startSession(input: StartSessionInput, onEvent: (e: SessionEvent) => void): void {
  destroySession();
  const stream = pushableStream();
  const abort = new AbortController();

  const options: Options = {
    // 会话按 cwd 隔离在 ~/.claude/projects/<encoded>/ 下,与用户自己的 CLI 项目互不混淆
    cwd: app.getPath('userData'),
    env: buildEnv(),
    pathToClaudeCodeExecutable: resolveClaudeBinary(),
    abortController: abort,
    includePartialMessages: true,
    // 只读保证:内置工具只留 `Skill`(否则 skill 加载了却调不动 —— 冒烟实测 `tools: []`
    // 会连 Skill 一起关掉)。Bash/Read/Write/Edit/WebFetch 一概不给:Bash 能跑
    // `pnpm cli complete`,给了它"只读"就名存实亡。
    tools: ['Skill'],
    mcpServers: { gtd: createGtdReadServer(input.deps) },
    // 只用我们注入的 MCP,不加载 .mcp.json / 用户设置里的服务器
    strictMcpConfig: true,
    // 这些工具全部只读,逐个确认没有意义 —— 但 allowedTools 只管"免确认",不管"有没有"
    allowedTools: READ_TOOL_NAMES.map(qualifiedToolName),
    // 用户的 ~/.claude/settings.json 不得影响应用行为;project/local 保留以便 skill 发现
    settingSources: ['project', 'local'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: buildSystemPrompt(statusSnapshot(input.deps)),
    },
    ...skillsOption(),
    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.resume !== undefined ? { resume: input.resume } : {}),
  };

  const q = query({ prompt: stream.iterable, options });
  live = { q, push: stream.push, close: stream.close, abort, sdkSessionId: null, busy: false };

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
    }
  })();
}

export function sessionAlive(): boolean {
  return live !== null;
}

export function sessionBusy(): boolean {
  return live?.busy === true;
}

export function sdkSessionId(): string | null {
  return live?.sdkSessionId ?? null;
}

export function send(text: string, images: AgentImage[]): { error?: string } {
  if (!live) return { error: '会话未启动' };
  if (live.busy) return { error: '上一条消息还在处理中' };
  live.busy = true;
  live.push(userMessage(text, images));
  return {};
}

/** 只停当前 turn —— 会话继续存活,可以接着聊。 */
export async function interruptTurn(): Promise<void> {
  if (!live) return;
  try {
    await live.q.interrupt();
  } finally {
    if (live) live.busy = false;
  }
}

/** 销毁会话(关闭聊天 / 应用退出)。这才是 AbortController 的用途。 */
export function destroySession(): void {
  if (!live) return;
  const s = live;
  live = null;
  s.close();
  s.abort.abort();
}

app.on('will-quit', destroySession);
