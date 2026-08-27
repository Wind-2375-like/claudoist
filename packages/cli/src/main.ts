import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, SqliteGtdStore } from '@gtd/storage-sqlite';
import { resolveDbPath } from './db';
import { CliError, HELP, makeDeps, runCommand, type CliArgs } from './commands';

/**
 * CLI 进程入口(DESIGN §6.7)。argv → runCommand;--json 输出 {ok, db, data};
 * 失败退出码 1。人读模式下 db 路径打到 stderr,stdout 只留结果(便于管道)。
 */

const argv = process.argv.slice(2);
const opts: CliArgs['opts'] = {};
const positionals: string[] = [];
for (const a of argv) {
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq === -1) opts[a.slice(2)] = true;
    else opts[a.slice(2, eq)] = a.slice(eq + 1);
  } else {
    positionals.push(a);
  }
}
const cmd = positionals.shift() ?? 'help';
const json = opts['json'] === true;

if (cmd === 'help' || opts['help'] === true) {
  console.log(HELP);
  process.exit(0);
}

const dbOpt = opts['db'];
const resolved = resolveDbPath({
  ...(typeof dbOpt === 'string' && { db: dbOpt }),
  ...(opts['dev'] === true && { dev: true }),
  ...(opts['prod'] === true && { prod: true }),
});

try {
  mkdirSync(dirname(resolved.path), { recursive: true });
  const db = openDb(resolved.path);
  try {
    const out = runCommand(cmd, new SqliteGtdStore(db), makeDeps(), { positionals, opts });
    if (json) {
      console.log(JSON.stringify({ ok: true, db: resolved.path, data: out.data }));
    } else {
      console.error(`# db: ${resolved.path}(${resolved.source})`);
      console.log(out.text);
    }
  } finally {
    db.close();
  }
} catch (err) {
  const message = err instanceof CliError ? err.message : String(err);
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`错误: ${message}`);
  process.exit(1);
}
