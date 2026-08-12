import { app } from 'electron';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeBinary } from './cliPath';
import { liveQuery, sessionBusy } from './sessionManager';

/**
 * 零 token 探针(M11-A)。
 *
 * ## 它解决什么
 *
 * 账号信息、模型列表、订阅额度这三样都挂在 `Query` 上,而在此之前应用里只有
 * "用户发过消息才有 Query"。于是出现两个荒谬的限制:没聊过天就看不到用量,
 * 也**换不了模型**(界面上还写着"先发一条消息,再回来切换模型")。
 *
 * 关键发现(已实测):SDK 那句 "only supported when streaming input/output is used"
 * 说的是 **prompt 必须是 AsyncIterable**,**不是**"必须先发过一条消息"。
 * 于是给它一个**永不 yield** 的 AsyncIterable:子进程照常起来、控制通道照常可用,
 * 而模型**一次都不会被调用**。实测 `usage.session.total_cost_usd === 0`、
 * `model_usage === {}`,端到端 0.8–1.7s。
 *
 * ## 三条硬纪律(违反任何一条 = 用户正在进行的对话被踢掉)
 *
 * 1. 探针必须用**自己的** AbortController;
 * 2. **绝不**调用 `startSession()` / `destroySession()`(前者开头就 destroy 掉 live);
 * 3. `finally` 里只 abort 自己那一个。
 *
 * ## 选路
 *
 * 有活会话且不忙 → 直接蹭它(~285ms,不起进程);否则起探针(~1s)。
 * **忙的时候不蹭** —— "turn 进行中调 usage() 会不会打断这一轮"没验证过,
 * 而探针与长驻会话并存是**实测安全**的(两个独立子进程,同 cwd 不冲突)。
 */

/** 探针不加载 skill、不注册任何工具、不注入 GTD MCP —— 它连数据库都不碰。 */
function probeOptions(abort: AbortController): Options {
  const env: Record<string, string | undefined> = { ...process.env };
  // 与 sessionManager 同因:宿主可能泄漏这个变量,会让子进程跑成 node
  delete env['ELECTRON_RUN_AS_NODE'];
  // ⚠ 绝不设 CLAUDE_CONFIG_DIR:一设凭据就不可见(M1 实证),探针会误报"未登录"
  return {
    cwd: app.getPath('userData'),
    env,
    pathToClaudeCodeExecutable: resolveClaudeBinary(),
    abortController: abort,
    // 故意的空数组:探针不需要任何工具。sessionManager 那边注释说 `tools: []`
    // 会连 Skill 一起关掉 —— 那正是这里想要的效果,别"顺手修好"它。
    tools: [],
    strictMcpConfig: true,
    settingSources: [],
  };
}

/** 永不产出的输入流 —— 模型因此永远不会被调用。 */
const silentPrompt: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]() {
    return { next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) };
  },
};

async function withProbe<T>(fn: (q: Query) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const q = query({ prompt: silentPrompt, options: probeOptions(abort) });
  try {
    // 等 initialize 落地后控制通道才可用
    await q.initializationResult();
    return await fn(q);
  } finally {
    abort.abort();
  }
}

/**
 * 在**某个** Query 上执行一段读取。优先蹭活会话,否则起探针。
 * 调用方不需要知道走的哪条路 —— 但返回值会带上 `source` 供 UI 标注新鲜度。
 */
export async function onQuery<T>(fn: (q: Query) => Promise<T>): Promise<{
  value: T;
  source: 'live-session' | 'probe';
}> {
  const live = liveQuery();
  if (live !== null && !sessionBusy()) {
    try {
      return { value: await fn(live), source: 'live-session' };
    } catch {
      // 活会话恰好在这中间死了 —— 退回探针,而不是把错误抛给用户
    }
  }
  return { value: await withProbe(fn), source: 'probe' };
}

// ------------------------------------------------------------------ 具体读取

/** SDK 原始返回,交给 usageModel 翻译(这里刻意不做任何解释)。 */
export interface RawSnapshot {
  account: unknown;
  usage: unknown;
  models: ModelInfo[];
  source: 'live-session' | 'probe';
}

/**
 * 60 秒缓存。每次取数都可能起一个 CLI 子进程(冷启 0.5–1.5s),而这个面板
 * 用户会反复点开;更要紧的是 `usage()` 每次都真发一个 HTTPS 请求。
 * 打开面板取一次、点「刷新」强制取一次 —— **不做轮询**。
 */
let cache: { at: number; snap: RawSnapshot } | null = null;
const CACHE_MS = 60_000;

export function invalidateSnapshot(): void {
  cache = null;
}

/**
 * 一次拿齐账号 + 用量 + 模型列表。
 *
 * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` 的名字就是它的说明书:
 * 随时可能改名或消失。所以它单独 try/catch —— 拿不到用量不该连账号和模型一起拖垮。
 */
export async function readSnapshot(force = false): Promise<RawSnapshot> {
  if (!force && cache !== null && Date.now() - cache.at < CACHE_MS) return cache.snap;
  const { value, source } = await onQuery(async (q) => {
    const init = await q.initializationResult();
    let usage: unknown = null;
    try {
      const anyQ = q as unknown as Record<string, unknown>;
      const fn = anyQ['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'];
      if (typeof fn === 'function') {
        usage = await (fn as () => Promise<unknown>).call(q);
      }
    } catch {
      usage = null;
    }
    return { account: init.account as unknown, usage, models: init.models };
  });
  const snap: RawSnapshot = { ...value, source };
  cache = { at: Date.now(), snap };
  return snap;
}

/**
 * 模型列表。走同一份缓存 —— 面板同时要账号、用量和模型,
 * 分两次调用就会**起两个子进程**。
 */
export async function readModels(): Promise<ModelInfo[]> {
  return (await readSnapshot()).models;
}
