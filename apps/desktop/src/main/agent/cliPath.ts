import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

/**
 * 解析 Agent SDK 的平台原生二进制(自包含 `claude`,无需系统 Node),
 * 并把 asar 内路径重写到 asar.unpacked(打包三件套,docs/DESIGN.md §9.3)。
 *
 * 坑(M1 实证):SDK tarball 的 optionalDependencies 只声明 linux 平台包,
 * darwin 平台包必须由 apps/desktop 显式声明为 optionalDependency。
 */
export function resolveClaudeBinary(): string {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const bin = `${pkg}/claude${process.platform === 'win32' ? '.exe' : ''}`;
  const req = createRequire(__filename);
  const resolved = req.resolve(bin);
  const unpacked = resolved.replace('app.asar', 'app.asar.unpacked');
  if (unpacked !== resolved && !existsSync(unpacked)) {
    throw new Error(`Claude binary not unpacked from asar: ${unpacked}`);
  }
  return unpacked;
}
