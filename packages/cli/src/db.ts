import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * DB 定位(DESIGN §6.7):CLAUDOIST_DB env > --db= > --prod/--dev >
 * 自动(dev 存在且 prod 不存在 → dev,否则 prod)。输出附带实际路径。
 */
export function resolveDbPath(opts: { db?: string; dev?: boolean; prod?: boolean }): {
  path: string;
  source: string;
} {
  const env = process.env['CLAUDOIST_DB'];
  if (env) return { path: env, source: 'env CLAUDOIST_DB' };
  if (opts.db) return { path: opts.db, source: '--db' };
  const base = join(homedir(), 'Library', 'Application Support');
  const prod = join(base, 'Claudoist', 'data', 'gtd.sqlite3');
  const dev = join(base, 'Claudoist-dev', 'data', 'gtd.sqlite3');
  if (opts.prod) return { path: prod, source: '--prod' };
  if (opts.dev) return { path: dev, source: '--dev' };
  if (existsSync(dev) && !existsSync(prod)) return { path: dev, source: 'auto(dev)' };
  return { path: prod, source: 'auto(prod)' };
}
