import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * 本机 Claude Code 二进制的发现与挑选(纯函数,不碰 Electron,便于单测)。
 *
 * ## 为什么不只用打包内置的那份
 *
 * 2026-10-18 用户:「我想要可选模型列表和 vscode claude code 插件显示的模型能保持一致」,
 * 随后:「注意我需要让 claude code sdk 能自动升级」。模型目录是 CLI 在 initialize 时下发的,
 * 钉死在打包内置的版本上,就意味着每次插件升级都要手动升 SDK、重新打包。
 * 而本机通常已经装着会**自己升级**的 Claude Code:
 *
 * - VSCode 插件:`~/.vscode/extensions/anthropic.claude-code-<ver>-<platform>-<arch>/resources/native-binary/claude`
 * - 原生安装器:`~/.local/bin/claude` → `~/.local/share/claude/versions/<ver>`
 *
 * 所以每次起会话时挑**版本最高**的那份用;打包内置的那份是保底(别人的机器上可能都没有)。
 * 实测(2026-10-18)SDK JS 0.3.269 驱动 CLI 2.1.301 —— 差 32 个版本 —— init、in-process
 * MCP 工具、canUseTool 全部正常:SDK 只经 `pathToClaudeCodeExecutable` 起子进程,
 * 不校验 CLI 版本,JS 落后于 CLI 是受支持的组合。
 */

export type ClaudeBinarySource = 'vscode' | 'native' | 'bundled';

export interface ClaudeBinary {
  path: string;
  /** x.y.z;解析不出来的候选不参与挑选 */
  version: string | null;
  source: ClaudeBinarySource;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** 按数字逐段比较 x.y.z(字符串比较会把 2.1.62 排在 2.1.301 后面) */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (pa === null || pb === null) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** VSCode 把待删的旧版本记在 `.obsolete` 里,目录可能还没删 —— 那些不算"装着的" */
function obsoleteSet(extDir: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(join(extDir, '.obsolete'), 'utf8')) as Record<
      string,
      unknown
    >;
    return new Set(Object.keys(raw).filter((k) => raw[k] === true));
  } catch {
    return new Set();
  }
}

/** 扫描本机已装的 Claude Code(只看文件系统,不执行任何东西) */
export function scanLocalClaudeBinaries(
  home: string,
  platform: string = process.platform,
  arch: string = process.arch,
): ClaudeBinary[] {
  const found: ClaudeBinary[] = [];
  const exe = platform === 'win32' ? 'claude.exe' : 'claude';

  const dirPattern = new RegExp(
    `^anthropic\\.claude-code-(\\d+\\.\\d+\\.\\d+)-${platform}-${arch}$`,
  );
  for (const root of ['.vscode/extensions', '.vscode-insiders/extensions']) {
    const extDir = join(home, root);
    let names: string[];
    try {
      names = readdirSync(extDir);
    } catch {
      continue;
    }
    const obsolete = obsoleteSet(extDir);
    for (const name of names) {
      const m = dirPattern.exec(name);
      if (m === null || obsolete.has(name)) continue;
      const path = join(extDir, name, 'resources', 'native-binary', exe);
      if (existsSync(path)) found.push({ path, version: m[1]!, source: 'vscode' });
    }
  }

  // 原生安装器:bin 下是指向 versions/<ver> 的符号链接;versions 里还留着旧版,
  // 只认链接当前指向的那个
  try {
    const real = realpathSync(join(home, '.local', 'bin', exe));
    const v = basename(real);
    if (SEMVER.test(v)) found.push({ path: real, version: v, source: 'native' });
  } catch {
    // 没装
  }
  return found;
}

/**
 * 挑版本最高的;平手时打包内置的优先(同版本没必要冒外部文件被升级器挪走的风险)。
 * `usable` 过滤掉跑不起来 / 本次运行已失败过的候选。
 */
export function pickClaudeBinary(
  local: ClaudeBinary[],
  bundled: ClaudeBinary,
  usable: (b: ClaudeBinary) => boolean = () => true,
): ClaudeBinary {
  let best = bundled;
  const sorted = local
    .filter((b) => b.version !== null)
    .sort((a, b) => compareVersions(b.version!, a.version!));
  for (const b of sorted) {
    if (best.version !== null && compareVersions(b.version!, best.version) <= 0) break;
    if (usable(b)) {
      best = b;
      break;
    }
  }
  return best;
}
