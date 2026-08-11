import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db';

/** M3 验收:agent_audit 与 reminders 表结构与 docs/DESIGN.md §5.1 一致。 */
describe('schema 与 DESIGN §5.1 对齐', () => {
  const cols = (table: string): { name: string; notnull: number }[] =>
    openDb(':memory:').prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      notnull: number;
    }[];

  it('agent_audit 列结构', () => {
    expect(cols('agent_audit').map((c) => c.name)).toEqual([
      'id',
      'conversation_id',
      'tool_name',
      'input_json',
      'decision',
      'result_summary',
      'created_at',
    ]);
  });

  it('agent_audit.decision 只接受三种权限决定', () => {
    const db = openDb(':memory:');
    db.prepare(
      "INSERT INTO conversations (id,sdk_session_id,title,model,created_at,last_message_at) VALUES ('cv1','s1','t','m','2026-08-08','2026-08-08')",
    ).run();
    const ins = (decision: string): void => {
      db.prepare(
        `INSERT INTO agent_audit (id,conversation_id,tool_name,input_json,decision,created_at) VALUES ('${decision}','cv1','tool','{}','${decision}','2026-08-08')`,
      ).run();
    };
    ins('allowed-auto');
    ins('allowed-user');
    ins('denied');
    expect(() => ins('yolo')).toThrow();
  });

  it('reminders 列结构(D-23/M6a:仅挂任务,task_id 必填)', () => {
    expect(cols('reminders').map((c) => c.name)).toEqual([
      'id',
      'task_id',
      'remind_at',
      'dispatched',
      'created_at',
    ]);
    const db = openDb(':memory:');
    // D-30:tasks 已无 context_id
    db.prepare(
      "INSERT INTO tasks (id,title,estimated_minutes,energy,priority,status,created_at) VALUES ('t1','x',15,'medium',3,'active','t')",
    ).run();
    const ok = db.prepare(
      'INSERT INTO reminders (id,task_id,remind_at,created_at) VALUES (?,?,?,?)',
    );
    ok.run('r1', 't1', '2026-08-08T10:00', 't');
    expect(() => ok.run('r2', null, 'x', 't')).toThrow(); // task_id NOT NULL → 拒
  });
});
