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

/** 本机缓存快照(L3 兜底):断网 / 起不了子进程时,面板至少还能显示点东西。 */
export interface LocalSnapshot {
  email: string | null;
  organization: string | null;
  /** 'max' | 'pro' | 'team' | 'enterprise' | null —— 由 organizationType 反推 */
  plan: string | null;
  /** cachedUsageUtilization.utilization,交给 usageModel 解析 */
  utilization: unknown;
  /** 缓存写入时刻(epoch ms) */
  fetchedAtMs: number | null;
}

/** CLI 自己的映射(organizationType → subscriptionType),再套展示名。 */
const PLAN_LABEL: Record<string, string> = {
  claude_max: 'Claude Max',
  claude_pro: 'Claude Pro',
  claude_team: 'Claude Team',
  claude_enterprise: 'Claude Enterprise',
};

/**
 * 读 `~/.claude.json` 的账号与用量缓存。
 *
 * 三道校验缺一不可,任何一道不过就当缓存不存在:
 * 1. 文件可读且 JSON 合法;
 * 2. **`cachedUsageUtilization.accountUuid` 必须等于 `oauthAccount.accountUuid`** ——
 *    否则换过账号,面板会拿上一个账号的额度糊弄用户(CLI 自己在不等时会直接删缓存);
 * 3. 写入时刻在 1 小时以内(CLI 自己也是这个上限,超时即判缓存失效)。
 *
 * 注意:accountUuid / organizationUuid 只用于**比对**,绝不进 VM、绝不进日志。
 */
export function localSnapshot(): LocalSnapshot | null {
  try {
    const p = join(homedir(), '.claude.json');
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const oauth = raw['oauthAccount'] as Record<string, unknown> | undefined;
    if (!oauth) return null;
    const orgType = typeof oauth['organizationType'] === 'string' ? oauth['organizationType'] : '';
    const snap: LocalSnapshot = {
      email: typeof oauth['emailAddress'] === 'string' ? oauth['emailAddress'] : null,
      organization:
        typeof oauth['organizationName'] === 'string' ? oauth['organizationName'] : null,
      plan: PLAN_LABEL[orgType] ?? null,
      utilization: null,
      fetchedAtMs: null,
    };
    const cached = raw['cachedUsageUtilization'] as Record<string, unknown> | undefined;
    const fetchedAtMs = typeof cached?.['fetchedAtMs'] === 'number' ? cached['fetchedAtMs'] : null;
    const sameAccount =
      typeof cached?.['accountUuid'] === 'string' && cached['accountUuid'] === oauth['accountUuid'];
    const fresh = fetchedAtMs !== null && Date.now() - fetchedAtMs < 60 * 60 * 1000;
    if (sameAccount && fresh) {
      snap.utilization = cached['utilization'];
      snap.fetchedAtMs = fetchedAtMs;
    }
    return snap;
  } catch {
    return null;
  }
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
