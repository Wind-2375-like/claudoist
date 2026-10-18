import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { settingsStore } from '../db';
import { pickClaudeBinary, scanLocalClaudeBinaries, type ClaudeBinary } from './claudeBinaries';

/** 是否跟随本机已装的 Claude Code(VSCode 插件 / 原生安装器)自动升级;缺省 = 跟随 */
export const CLI_FOLLOW_LOCAL_KEY = 'agent.cli.followLocal';

/**
 * 解析 Agent SDK 的平台原生二进制(自包含 `claude`,无需系统 Node),
 * 并把 asar 内路径重写到 asar.unpacked(打包三件套,docs/DESIGN.md §9.3)。
 *
 * 坑(M1 实证):SDK tarball 的 optionalDependencies 只声明 linux 平台包,
 * darwin 平台包必须由 apps/desktop 显式声明为 optionalDependency。
 */
function bundledClaudeBinary(): ClaudeBinary {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const bin = `${pkg}/claude${process.platform === 'win32' ? '.exe' : ''}`;
  const req = createRequire(__filename);
  const resolved = req.resolve(bin);
  const unpacked = resolved.replace('app.asar', 'app.asar.unpacked');
  if (unpacked !== resolved && !existsSync(unpacked)) {
    throw new Error(`Claude binary not unpacked from asar: ${unpacked}`);
  }
  // 读不出来就当最旧:任何能跑的本机安装都会胜出
  return { path: unpacked, version: versionOf(unpacked), source: 'bundled' };
}

/** 本次运行里起会话失败过的外部二进制 —— 不再选它,退回下一个 */
const bad = new Set<string>();

export function markClaudeBinaryBad(path: string): void {
  bad.add(path);
}

/**
 * 跑一次 `--version` 读真实版本号(`2.1.301 (Claude Code)` → `2.1.301`)。
 * 60–110ms,按 路径 + mtime 缓存,一个版本只跑一次。跑不起来 = null。
 */
const versions = new Map<string, string | null>();
function versionOf(path: string): string | null {
  let key: string;
  try {
    key = `${path}@${String(statSync(path).mtimeMs)}`;
  } catch {
    return null;
  }
  if (versions.has(key)) return versions.get(key)!;
  const env = { ...process.env };
  delete env['ELECTRON_RUN_AS_NODE'];
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 5000, env });
  const v = r.status === 0 ? (/^(\d+\.\d+\.\d+)\b/.exec(r.stdout.trim())?.[1] ?? null) : null;
  versions.set(key, v);
  return v;
}

/** 外部候选能用吗:本次没失败过,且真能执行、版本与路径上写的一致(防升级器写到一半之类) */
function usable(b: ClaudeBinary): boolean {
  return !bad.has(b.path) && b.version !== null && versionOf(b.path) === b.version;
}

function followLocal(): boolean {
  try {
    return settingsStore().get<boolean>(CLI_FOLLOW_LOCAL_KEY) ?? true;
  } catch {
    // spike 通道等没初始化设置库的场合:按缺省
    return true;
  }
}

let lastLogged: string | null = null;

/** 此刻起会话该用哪一个 Claude Code。每次起会话 / 起探针都重新挑 —— 插件升级后无需重启应用。 */
export function currentClaudeBinary(): ClaudeBinary {
  const bundled = bundledClaudeBinary();
  const pick = followLocal()
    ? pickClaudeBinary(scanLocalClaudeBinaries(homedir()), bundled, usable)
    : bundled;
  if (pick.path !== lastLogged) {
    lastLogged = pick.path;
    process.stderr.write(
      `[agent] Claude Code ${pick.version ?? '?'}(${pick.source}):${pick.path}\n`,
    );
  }
  return pick;
}

export function resolveClaudeBinary(): string {
  return currentClaudeBinary().path;
}
