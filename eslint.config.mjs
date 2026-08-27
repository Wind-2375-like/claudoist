// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Dependency-direction enforcement (docs/DESIGN.md §3.2) via scoped
 * `no-restricted-imports` zones. Direction:
 *
 *   @gtd/domain  ←  @gtd/storage-sqlite
 *        ↑       ←  @gtd/agent-tools
 *        ↑       ←  apps/desktop (main)      renderer/preload → IPC only
 */
const restrict = (patterns) => ({
  'no-restricted-imports': [
    'error',
    { patterns: patterns.map((p) => ({ group: [p.group], message: p.message })) },
  ],
});

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/release/**', 'docs/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // dev 脚本(Node 运行)
    files: ['**/scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  {
    // @gtd/domain: pure TS. No sibling packages, no platform, no framework.
    files: ['packages/domain/**/*.ts'],
    rules: restrict([
      { group: '@gtd/*', message: 'domain 是最内层,不得 import 任何 @gtd 包' },
      { group: 'electron*', message: 'domain 禁止依赖 Electron' },
      { group: 'better-sqlite3', message: 'domain 禁止依赖存储实现' },
      { group: '@anthropic-ai/*', message: 'domain 禁止依赖 Agent SDK' },
      { group: 'react*', message: 'domain 禁止依赖 UI 框架' },
    ]),
  },
  {
    // @gtd/storage-sqlite: may import domain only.
    files: ['packages/storage-sqlite/**/*.ts'],
    rules: restrict([
      { group: '@gtd/agent-tools', message: 'storage 只能向内依赖 @gtd/domain' },
      { group: 'electron*', message: 'storage 禁止依赖 Electron(路径由 main 注入)' },
      { group: 'react*', message: 'storage 禁止依赖 UI 框架' },
    ]),
  },
  {
    // @gtd/agent-tools: may import domain only.
    files: ['packages/agent-tools/**/*.ts'],
    rules: restrict([
      {
        group: '@gtd/storage-sqlite',
        message: 'agent-tools 只能向内依赖 @gtd/domain(store 经接口注入)',
      },
      { group: 'electron*', message: 'agent-tools 禁止依赖 Electron' },
      { group: 'react*', message: 'agent-tools 禁止依赖 UI 框架' },
    ]),
  },
  {
    // @gtd/cli: 与 desktop-main 同向 — 只向内依赖 domain/storage,无 Electron/UI。
    files: ['packages/cli/**/*.ts'],
    rules: restrict([
      { group: 'electron*', message: 'cli 禁止依赖 Electron' },
      { group: 'react*', message: 'cli 禁止依赖 UI 框架' },
      { group: '@anthropic-ai/*', message: 'cli 禁止依赖 Agent SDK' },
    ]),
  },
  {
    // renderer: sandboxed — no Node, no Electron main-side modules, no inner packages.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: restrict([
      { group: '@gtd/*', message: 'renderer 只能经 preload IPC 访问数据(docs/DESIGN.md §4.1)' },
      { group: 'electron*', message: 'renderer 禁止直接 import electron' },
      { group: 'node:*', message: 'renderer 是 sandboxed,无 Node API' },
      { group: 'better-sqlite3', message: 'renderer 禁止访问数据库' },
      { group: '@anthropic-ai/*', message: 'renderer 禁止访问 Agent SDK' },
    ]),
  },
  {
    // preload: bridge only — electron APIs yes, inner packages no.
    files: ['apps/desktop/src/preload/**/*.ts'],
    rules: restrict([
      { group: '@gtd/*', message: 'preload 只做 contextBridge 转发,不 import 内层包' },
    ]),
  },
  prettier,
);
