import { shell } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GoogleCredentials, GoogleTokens } from './secrets';

/**
 * Google OAuth 2.0 授权码 + PKCE 流程(M6c-1)。桌面端唯一可行路径:
 * **系统浏览器 + 本地回环回调**(http://127.0.0.1:<随机端口>)。
 * - OOB(urn:ietf:wg:oauth:2.0:oob)自 2023-01-31 起被 Google 彻底封禁;
 * - 在 BrowserWindow/webview 里加载 accounts.google.com 违反 "Use secure browsers" 政策
 *   (典型报错 403 disallowed_useragent),伪装 UA 属规避政策,不做;
 * - Desktop 类型的 client 在控制台**没有** redirect URI 输入框,任意 loopback 端口自动放行。
 */

/** 最小 scope 组合(D-23/M6c):写只限本应用创建的日历,其余只读。 */
export const SCOPES = [
  // 创建次级日历(专用 "Claudoist" 日历)并对其事件完整 CRUD —— 碰不到用户其它日历
  'https://www.googleapis.com/auth/calendar.app.created',
  // 列出用户订阅的日历(设置页勾选用)
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  // 只读展示外部日历的事件(sensitive scope:未验证应用授权时会出现提示页)
  'https://www.googleapis.com/auth/calendar.readonly',
] as const;

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** 授权等待上限:用户可能开着浏览器去忙别的 */
const AUTH_TIMEOUT_MS = 5 * 60_000;

const b64url = (b: Buffer): string => b.toString('base64url');

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
  scope?: string;
}

function tokenForm(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

async function postToken(fields: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, tokenForm(fields));
  const text = await res.text();
  if (!res.ok) {
    // Google 的错误体形如 {"error":"invalid_grant","error_description":"..."}
    let msg = text;
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string };
      msg = `${j.error ?? res.status}${j.error_description ? `: ${j.error_description}` : ''}`;
    } catch {
      /* 保留原文 */
    }
    throw new Error(`Google token 请求失败(${res.status})— ${msg}`);
  }
  return JSON.parse(text) as TokenResponse;
}

const donePage = (ok: boolean, detail = ''): string =>
  `<!doctype html><meta charset="utf-8"><title>Claudoist</title>
<body style="font-family:system-ui;margin:0;display:flex;height:100vh;align-items:center;justify-content:center;background:#faf9f8">
<div style="text-align:center">
<h2 style="margin:0 0 8px">${ok ? '✅ 已连接 Claudoist' : '❌ 授权未完成'}</h2>
<p style="color:#666;margin:0">${ok ? '可以关闭此页面,回到 Claudoist 继续。' : detail}</p>
</div></body>`;

/**
 * 走完整授权:起本地回环服务器 → 打开系统浏览器 → 收 code → 换 token。
 * 返回的 tokens 一定含 refresh_token(access_type=offline + prompt=consent)。
 */
export async function authorize(cred: GoogleCredentials): Promise<GoogleTokens> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  // redirect_uri 在换 token 时必须与授权请求**逐字一致**,故随 code 一起带出闭包
  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
    (resolve, reject) => {
      let settled = false;
      let redirect = '';
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        fn();
      };

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/favicon.ico') {
          res.writeHead(404).end();
          return;
        }
        const err = url.searchParams.get('error');
        const got = url.searchParams.get('code');
        const gotState = url.searchParams.get('state');
        if (err) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(donePage(false, `Google 返回:${err}`));
          finish(() => reject(new Error(`授权被拒绝:${err}`)));
          return;
        }
        if (gotState !== state) {
          // CSRF 防护:state 不匹配的回调一律丢弃
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(donePage(false, 'state 校验失败'));
          return;
        }
        if (!got) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(donePage(false, '回调缺少 code'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(donePage(true));
        finish(() => resolve({ code: got, redirectUri: redirect }));
      });

      const timer = setTimeout(
        () => finish(() => reject(new Error('授权超时(5 分钟未完成)'))),
        AUTH_TIMEOUT_MS,
      );
      server.on('error', (e) => finish(() => reject(e)));

      // 0 端口 = 由 OS 分配空闲端口,拿到后才能拼 redirect_uri
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        redirect = `http://127.0.0.1:${port}`;
        const auth = new URL(AUTH_ENDPOINT);
        auth.search = new URLSearchParams({
          client_id: cred.clientId,
          redirect_uri: redirect,
          response_type: 'code',
          scope: SCOPES.join(' '),
          // offline + consent:确保任何情况下都能拿到 refresh_token(仅 offline 时,
          // 已授权过的账号再次授权不会再下发 refresh_token)
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
        }).toString();
        void shell.openExternal(auth.toString()).catch((e: unknown) => {
          finish(() => reject(e instanceof Error ? e : new Error(String(e))));
        });
      });
    },
  );

  const tok = await postToken({
    code,
    client_id: cred.clientId,
    client_secret: cred.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  if (!tok.refresh_token) {
    // 理论上 offline+consent 必然下发;真缺了就明说,别留个只能用一小时的连接
    throw new Error('Google 未返回 refresh_token —— 请在授权页完整同意后重试');
  }
  return {
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    expiresAt: Date.now() + tok.expires_in * 1000,
    email: null,
  };
}

/** 用 refresh_token 换新的 access_token。400 invalid_grant = 凭据已失效,须重新授权。 */
export async function refreshAccessToken(
  cred: GoogleCredentials,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const tok = await postToken({
    client_id: cred.clientId,
    client_secret: cred.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return { accessToken: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
}

/** 断开连接:撤销授权(撤 access_token 会连带撤掉对应的 refresh_token)。 */
export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_ENDPOINT, tokenForm({ token })).catch(() => undefined);
}
