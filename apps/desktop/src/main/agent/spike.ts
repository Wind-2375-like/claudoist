import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeBinary } from './cliPath';

/**
 * M1 spike:最小 Agent 会话。一次 send = 一个 `query()`,靠 `resume` 维持
 * 会话连续性。正式的 sessionManager(长活 streaming-input、权限桥、多会话)
 * 在 M8 按 docs/DESIGN.md §6.2 实现。
 */

export interface SpikeImage {
  /** base64,不含 data: 前缀 */
  data: string;
  mediaType: string;
}

export interface SpikeError {
  type: 'spike_error';
  message: string;
}

let sessionId: string | undefined;
let active: AbortController | null = null;

function buildEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  // 主认证路径(DESIGN §6.1):不注入 ANTHROPIC_API_KEY,复用本机 Claude Code 登录。
  // 防御:宿主环境(如 VSCode 派生 shell)可能泄漏 ELECTRON_RUN_AS_NODE。
  delete env['ELECTRON_RUN_AS_NODE'];
  // M1 实证(2026-08-08):CLAUDE_CONFIG_DIR 重定向到空目录会使订阅凭据不可见
  // (子进程报 Not logged in)。测试旋钮:CLAUDOIST_CONFIG_DIR_MODE=app 启用重定向,
  // 默认 inherit(不动 CLAUDE_CONFIG_DIR,会话按 cwd 隔离在 ~/.claude/projects 下)。
  if (process.env['CLAUDOIST_CONFIG_DIR_MODE'] === 'app') {
    const configDir = join(app.getPath('userData'), 'claude');
    mkdirSync(configDir, { recursive: true });
    env['CLAUDE_CONFIG_DIR'] = configDir;
  }
  return env;
}

function userMessage(text: string, images: SpikeImage[]): SDKUserMessage {
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

export function spikeBusy(): boolean {
  return active !== null;
}

export function spikeInterrupt(): void {
  active?.abort();
}

export async function runSpikeTurn(
  text: string,
  images: SpikeImage[],
  onMessage: (msg: SDKMessage | SpikeError) => void,
): Promise<void> {
  if (active) {
    onMessage({ type: 'spike_error', message: '上一条消息还在处理中' });
    return;
  }
  const abortController = new AbortController();
  active = abortController;

  const options: Options = {
    cwd: app.getPath('userData'),
    env: buildEnv(),
    pathToClaudeCodeExecutable: resolveClaudeBinary(),
    includePartialMessages: true,
    maxTurns: 8,
    abortController,
    ...(sessionId ? { resume: sessionId } : {}),
  };

  async function* once(): AsyncIterable<SDKUserMessage> {
    yield userMessage(text, images);
  }

  try {
    for await (const msg of query({ prompt: once(), options })) {
      if ('session_id' in msg && typeof msg.session_id === 'string') {
        sessionId = msg.session_id;
      }
      onMessage(msg);
    }
  } catch (err) {
    onMessage({ type: 'spike_error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    active = null;
  }
}
