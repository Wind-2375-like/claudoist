import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Google 凭据保险箱(M6c-1)。client_id/secret 与 refresh_token 打包成一个 JSON,
 * 整体过 Electron `safeStorage`(macOS = 登录钥匙串里的 `<AppName> Safe Storage` 主密钥)
 * 后以 base64 落盘 `<userData>/secrets/google-oauth.json`,权限 0600。
 *
 * 纪律:
 * - **只在主进程**读写;token 永不进渲染进程、永不进 SQLite(DB 会被 CLI 读、会被备份)。
 * - safeStorage 必须在 app.whenReady() 之后首次调用(否则 macOS 会写错钥匙串条目)。
 * - **解密失败一律降级为"未连接"**:dev 的 `Claudoist-dev` 与打包后的 `Claudoist` 是两条
 *   不同的钥匙串条目,重新签名的构建也会被 macOS 当成另一个 App —— 这是正常状态,
 *   不是错误,引导用户重新授权即可。
 * - Desktop 类型的 client_secret 在密码学意义上不是秘密(RFC 8252 公开客户端),加密它
 *   没有安全收益;但打包在同一个密文里最省事,也顺带避免它以明文躺在磁盘上。
 */

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}

export interface GoogleTokens {
  refreshToken: string;
  accessToken: string | null;
  /** access_token 到期时刻(epoch ms) */
  expiresAt: number | null;
  /** 已连接账号(取 primary 日历的 id,即邮箱;避免多要一个 userinfo scope) */
  email: string | null;
}

/**
 * 一个已连接的 Google 账号(M6c-2b 多账号)。同一个 OAuth client 可以授权多个账号 ——
 * 学校 Workspace 常禁止把日历共享到外部账号,把两个账号都连上是唯一不依赖管理员的办法。
 */
export interface GoogleAccount extends GoogleTokens {
  /** 稳定标识 = 邮箱(primary 日历 id) */
  email: string;
}

export interface GoogleVault {
  /** client 凭据全账号共用 */
  credentials: GoogleCredentials | null;
  accounts: GoogleAccount[];
}

const EMPTY: GoogleVault = { credentials: null, accounts: [] };

/** 旧单账号形态 `{credentials, tokens}` → 新的 accounts[](就地迁移,用户无感)。 */
function normalize(parsed: Record<string, unknown>): GoogleVault {
  const credentials = (parsed['credentials'] as GoogleCredentials | undefined) ?? null;
  const accounts = parsed['accounts'] as GoogleAccount[] | undefined;
  if (Array.isArray(accounts)) return { credentials, accounts };
  const legacy = parsed['tokens'] as GoogleTokens | undefined | null;
  if (legacy && typeof legacy.refreshToken === 'string') {
    return {
      credentials,
      accounts: [{ ...legacy, email: legacy.email ?? '(未知账号)' }],
    };
  }
  return { credentials, accounts: [] };
}

const secretsDir = (): string => join(app.getPath('userData'), 'secrets');
const vaultPath = (): string => join(secretsDir(), 'google-oauth.json');

async function encrypt(plain: string): Promise<string> {
  // 官方已标注同步版"未来可能废弃";Electron 43 起有异步版,优先用
  const buf = (await safeStorage.isAsyncEncryptionAvailable())
    ? await safeStorage.encryptStringAsync(plain)
    : safeStorage.encryptString(plain);
  return buf.toString('base64');
}

/** 解密;shouldReEncrypt = 系统密钥已轮换,调用方应重新加密落盘一次。 */
async function decrypt(b64: string): Promise<{ text: string; shouldReEncrypt: boolean }> {
  const buf = Buffer.from(b64, 'base64');
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    const r = await safeStorage.decryptStringAsync(buf);
    return { text: r.result, shouldReEncrypt: r.shouldReEncrypt };
  }
  return { text: safeStorage.decryptString(buf), shouldReEncrypt: false };
}

/** 加密是否可用(Linux 无 keyring 时可能不可用 → UI 需明示无法安全保存)。 */
export async function encryptionAvailable(): Promise<boolean> {
  try {
    return (await safeStorage.isAsyncEncryptionAvailable()) || safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 读保险箱;文件缺失/损坏/解不开一律返回空(= 未连接),不抛。 */
export async function loadVault(): Promise<GoogleVault> {
  const path = vaultPath();
  if (!existsSync(path)) return EMPTY;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { v: number; data: string };
    const { text, shouldReEncrypt } = await decrypt(raw.data);
    const vault = normalize(JSON.parse(text) as Record<string, unknown>);
    // 系统密钥轮换:用新密钥重写一次,否则下次可能解不开
    if (shouldReEncrypt) await saveVault(vault);
    return vault;
  } catch {
    // 换机器/换签名/钥匙串被清 → 当作未连接,由用户重新授权
    return EMPTY;
  }
}

/** 原子写 + 0600(fs.writeFile 默认 0644 会让同机其他用户可读)。 */
export async function saveVault(vault: GoogleVault): Promise<void> {
  mkdirSync(secretsDir(), { recursive: true, mode: 0o700 });
  const data = await encrypt(JSON.stringify(vault));
  const path = vaultPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, data }), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export function clearVault(): void {
  const path = vaultPath();
  if (existsSync(path)) rmSync(path);
}

/** 追加/替换一个账号(按邮箱去重:重复授权同一账号视为刷新)。 */
export async function upsertAccount(account: GoogleAccount): Promise<void> {
  const vault = await loadVault();
  const rest = vault.accounts.filter((a) => a.email !== account.email);
  await saveVault({ credentials: vault.credentials, accounts: [...rest, account] });
}

/** 移除一个账号;最后一个账号移除后仍保留 client 凭据(便于再连)。 */
export async function removeAccount(email: string): Promise<void> {
  const vault = await loadVault();
  await saveVault({
    credentials: vault.credentials,
    accounts: vault.accounts.filter((a) => a.email !== email),
  });
}
