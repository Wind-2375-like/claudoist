import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  compareVersions,
  pickClaudeBinary,
  scanLocalClaudeBinaries,
  type ClaudeBinary,
} from '../src/main/agent/claudeBinaries';

/**
 * 2026-10-18 用户:「注意我需要让 claude code sdk 能自动升级」。起会话时挑本机版本最高的
 * Claude Code(VSCode 插件 / 原生安装器),打包内置的那份保底。
 */

const home = mkdtempSync(join(tmpdir(), 'gtd-claude-bin-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const touch = (path: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
};
const vscodeExt = (ver: string, arch = 'arm64', root = '.vscode'): string => {
  const p = join(
    home,
    root,
    'extensions',
    `anthropic.claude-code-${ver}-darwin-${arch}`,
    'resources',
    'native-binary',
    'claude',
  );
  touch(p);
  return p;
};

const bundled: ClaudeBinary = { path: '/app/claude', version: '2.1.301', source: 'bundled' };
const b = (version: string, source: ClaudeBinary['source'] = 'vscode'): ClaudeBinary => ({
  path: `/x/${version}`,
  version,
  source,
});

describe('compareVersions', () => {
  it('逐段按数字比,不是字符串比', () => {
    expect(compareVersions('2.1.301', '2.1.62')).toBeGreaterThan(0);
    expect(compareVersions('2.2.0', '2.1.999')).toBeGreaterThan(0);
    expect(compareVersions('2.1.301', '2.1.301')).toBe(0);
  });
});

describe('scanLocalClaudeBinaries', () => {
  it('VSCode(含 insiders)按本机架构认,跳过 .obsolete;原生安装只认符号链接当前指向的版本', () => {
    const v301 = vscodeExt('2.1.301');
    vscodeExt('2.1.300'); // 被 VSCode 标为待删
    vscodeExt('2.1.400', 'x64'); // 别的架构
    const insiders = vscodeExt('2.1.305', 'arm64', '.vscode-insiders');
    writeFileSync(
      join(home, '.vscode', 'extensions', '.obsolete'),
      JSON.stringify({ 'anthropic.claude-code-2.1.300-darwin-arm64': true }),
    );
    // 没有 native-binary 的目录(VSCode 正在解压)不算
    mkdirSync(join(home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.302-darwin-arm64'));

    const versions = join(home, '.local', 'share', 'claude', 'versions');
    touch(join(versions, '2.1.62'));
    touch(join(versions, '2.1.284'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(join(versions, '2.1.284'), join(home, '.local', 'bin', 'claude'));

    const found = scanLocalClaudeBinaries(home, 'darwin', 'arm64');
    expect(found).toHaveLength(3);
    expect(found).toContainEqual({ path: v301, version: '2.1.301', source: 'vscode' });
    expect(found).toContainEqual({ path: insiders, version: '2.1.305', source: 'vscode' });
    expect(found.find((f) => f.source === 'native')?.version).toBe('2.1.284');
  });

  it('什么都没装 → 空', () => {
    expect(
      scanLocalClaudeBinaries(mkdtempSync(join(tmpdir(), 'gtd-empty-')), 'darwin', 'arm64'),
    ).toEqual([]);
  });
});

describe('pickClaudeBinary', () => {
  it('挑版本最高的', () => {
    expect(
      pickClaudeBinary([b('2.1.310'), b('2.1.284', 'native'), b('2.1.320')], bundled).version,
    ).toBe('2.1.320');
  });

  it('平手或更旧 → 打包内置优先', () => {
    expect(pickClaudeBinary([b('2.1.301'), b('2.1.284', 'native')], bundled)).toBe(bundled);
  });

  it('最高的那个用不了 → 退到下一个仍比内置新的;都用不了 → 内置', () => {
    const usable = (x: ClaudeBinary): boolean => x.version !== '2.1.320';
    expect(pickClaudeBinary([b('2.1.320'), b('2.1.310')], bundled, usable).version).toBe('2.1.310');
    expect(pickClaudeBinary([b('2.1.320')], bundled, usable)).toBe(bundled);
  });

  it('内置版本读不出来 → 任何能用的本机安装都胜出', () => {
    const unknown: ClaudeBinary = { ...bundled, version: null };
    expect(pickClaudeBinary([b('2.1.62', 'native')], unknown).version).toBe('2.1.62');
  });
});
