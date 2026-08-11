import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 认证探测(DESIGN §6.1)。主路径 = 复用本机 Claude Code 登录;API key 是备用。
 *
 * 这里**只做本地文件级探测,不发网络请求** —— 探测本身不该花钱,也不该在启动时卡住。
 * 真正的判定发生在第一次发消息:子进程若未登录会回 `Not logged in`,那时再引导。
 * 所以本函数的用途是"在用户发第一条消息之前就把话说清楚",而不是权威判定。
 */

export interface AuthStatus {
  /** 本机 Claude Code 看起来已登录(~/.claude.json 里有 oauthAccount) */
  loggedIn: boolean;
  /** 登录邮箱(仅用于界面显示"以谁的身份") */
  email: string | null;
  /** 环境里存在 ANTHROPIC_API_KEY(会被 SDK 优先使用,可能产生 API 计费) */
  apiKeyInEnv: boolean;
  /** 会话隔离目录 —— transcript 落在 ~/.claude/projects/<encoded(cwd)>/ */
  cwd: string;
}

export function authStatus(): AuthStatus {
  let loggedIn = false;
  let email: string | null = null;
  try {
    const p = join(homedir(), '.claude.json');
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as {
        oauthAccount?: { emailAddress?: string };
      };
      if (raw.oauthAccount) {
        loggedIn = true;
        email = raw.oauthAccount.emailAddress ?? null;
      }
    }
  } catch {
    // 文件坏了/读不到:按未登录处理,由引导文案兜住
  }
  return {
    loggedIn,
    email,
    apiKeyInEnv: typeof process.env['ANTHROPIC_API_KEY'] === 'string',
    cwd: app.getPath('userData'),
  };
}
