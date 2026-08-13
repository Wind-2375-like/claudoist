import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyRewindToSnapshot, reverseChain } from '@gtd/domain';
import type { AfterEntry, GtdSnapshot, RewindBatch, RewindCommand, RewindStore } from '@gtd/domain';
import { rowHash } from '@gtd/domain';

/**
 * 回滚 agent 对任务数据的改动(INV-35)。
 *
 * 算法就是链序引理的直接落地(见 packages/domain/src/ports/rewind.ts 的头注释):
 * 从最新一条日志开始**严格降序、不跳号**地把逆命令贴回去,直到锚点那一轮。
 *
 * **回滚本身不进日志** —— 用户明确接受"不可撤销"。但"不可撤销"指的是界面上没有 undo,
 * 不等于可以不吭声地吃掉用户自己的改动:所以①执行前强制 diff 预览,②冲突必须显式裁决,
 * ③事务开始前先 `VACUUM INTO` 一份整库快照(实测 2ms / 180KB)作为人工救援通道。
 */

export interface RewindLogRow {
  seq: number;
  conversationId: string;
  turnId: string;
  toolName: string;
  inverse: RewindCommand[];
  after: AfterEntry[];
  createdAt: string;
}

export interface RewindConflict {
  seq: number;
  toolName: string;
  /** 人话描述:哪个实体的哪个字段被谁改过 */
  detail: string;
}

export interface RewindPreview {
  /** 会被撤销的日志条数 */
  entryCount: number;
  /** 涉及的工具调用名(按出现次数聚合) */
  tools: { name: string; count: number }[];
  /** 会被**硬删除**的行数 —— 这是整套机制里唯一真正不可逆的部分,必须单列 */
  hardDeleteCount: number;
  /** 冲突:agent 写完之后又被别人(用户 / Google 同步 / 另一条会话)改过 */
  conflicts: RewindConflict[];
  /** 链里混进的其它会话的条目数 */
  foreignEntryCount: number;
}

interface Db {
  prepare(sql: string): {
    all(...p: unknown[]): unknown[];
    get(...p: unknown[]): unknown;
    run(...p: unknown[]): unknown;
  };
  exec(sql: string): void;
}

const parseRow = (r: Record<string, unknown>): RewindLogRow => ({
  seq: r['seq'] as number,
  conversationId: r['conversation_id'] as string,
  turnId: r['turn_id'] as string,
  toolName: r['tool_name'] as string,
  inverse: (JSON.parse(r['inverse_json'] as string) as { cmds: RewindCommand[] }).cmds,
  after: JSON.parse(r['after_json'] as string) as AfterEntry[],
  createdAt: r['created_at'] as string,
});

/**
 * 从锚点轮起、尚未被撤销的全部日志(升序)。
 *
 * 起点取 `MIN(seq)`:菜单挂在某一轮上,「回滚到这里」= 撤销**这一轮及其之后**的一切。
 * 链必须连续 —— 跳号会让后面的逆基于错误的中间态。
 */
export interface RewindAnchor {
  conversationId: string;
  /** 本次会话里新发的消息有它 */
  turnId?: string | undefined;
  /** 历史会话里只有它(我们塞给 SDK 的用户消息 uuid,transcript 里读得到) */
  anchorUuid?: string | undefined;
}

/**
 * 锚点解析放在**主进程**而不是渲染层:历史会话渲染出来的消息只有 uuid、没有 turnId,
 * 渲染层没法自己算出"这一轮及之后"的 turnId 列表。服务端按 `MIN(seq)` 一次搞定,
 * 两种锚点走同一条路。
 */
export function chainFrom(db: Db, a: RewindAnchor): RewindLogRow[] {
  const where: string[] = ['conversation_id = ?', 'rewound_at IS NULL'];
  const args: unknown[] = [a.conversationId];
  if (a.turnId !== undefined) {
    where.push('turn_id = ?');
    args.push(a.turnId);
  } else if (a.anchorUuid !== undefined) {
    where.push('anchor_uuid = ?');
    args.push(a.anchorUuid);
  } else {
    return [];
  }
  const min = db
    .prepare(`SELECT MIN(seq) AS s FROM agent_rewind_log WHERE ${where.join(' AND ')}`)
    .get(...args) as { s: number | null };
  if (min.s === null) return [];
  // ⚠ 不按 conversation_id 过滤:链是**全局**的。别的会话在这期间写过同一行时,
  // 只回滚本会话的条目会停在中间态 —— 那些条目要么一并撤销,要么在预览里点名。
  return (
    db
      .prepare('SELECT * FROM agent_rewind_log WHERE seq >= ? AND rewound_at IS NULL ORDER BY seq')
      .all(min.s) as Record<string, unknown>[]
  ).map(parseRow);
}

/** 当前行的某几个键 */
function currentFields(snap: GtdSnapshot, cmd: RewindCommand): Record<string, unknown> | null {
  const pick = (arr: readonly unknown[], id: string): Record<string, unknown> | undefined =>
    (arr as Record<string, unknown>[]).find((x) => x['id'] === id);
  switch (cmd.kind) {
    case 'updateTask':
      return pick(snap.tasks, cmd.id) ?? null;
    case 'updateProject':
      return pick(snap.projects, cmd.id) ?? null;
    case 'updateWaitingFor':
      return pick(snap.waiting, cmd.id) ?? null;
    case 'updateLabel':
      return pick(snap.labels, cmd.id) ?? null;
    case 'updateFilter':
      return pick(snap.filters, cmd.id) ?? null;
    case 'updateReminder':
      return pick(snap.reminders, cmd.id) ?? null;
    case 'hardDeleteTask':
      return pick(snap.tasks, cmd.id) ?? null;
    case 'hardDeleteProject':
      return pick(snap.projects, cmd.id) ?? null;
    case 'hardDeleteWaitingFor':
      return pick(snap.waiting, cmd.id) ?? null;
    default:
      return null;
  }
}

/**
 * 预检:只读,不写任何东西。
 *
 * 冲突判据来自链序引理 —— 按 seq 降序走时,某个字段的当前值**应当**恒等于该条目记录的
 * `after`;不等就说明中间有人动过。这个判据天然覆盖了三种外部来源(用户手改、
 * Google 回同步、另一条会话),所以不需要给表加 updated_at,也不需要记 actor。
 */
export function previewRewind(
  snap: GtdSnapshot,
  rows: RewindLogRow[],
  conversationId: string,
): RewindPreview {
  const conflicts: RewindConflict[] = [];
  let hardDeleteCount = 0;
  const toolCount = new Map<string, number>();
  let foreignEntryCount = 0;

  // 模拟倒序回滚,边走边比对
  let sim = snap;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    toolCount.set(row.toolName, (toolCount.get(row.toolName) ?? 0) + 1);
    if (row.conversationId !== conversationId) foreignEntryCount += 1;

    for (let j = row.inverse.length - 1; j >= 0; j -= 1) {
      const cmd = row.inverse[j]!;
      const after = row.after[j] ?? null;
      if (cmd.kind.startsWith('hardDelete')) hardDeleteCount += 1;
      const cur = currentFields(sim, cmd);
      if (after !== null && after.t === 'fields') {
        for (const [k, v] of Object.entries(after.v)) {
          const now = cur?.[k] ?? null;
          if (JSON.stringify(now) !== JSON.stringify(v ?? null)) {
            conflicts.push({
              seq: row.seq,
              toolName: row.toolName,
              detail: `${describe(cmd)} 的 ${k}:现在是 ${json(now)},而 agent 当时写的是 ${json(v)} —— 这之后有人改过它`,
            });
          }
        }
      } else if (after !== null && after.t === 'row') {
        if (cur === null) {
          conflicts.push({
            seq: row.seq,
            toolName: row.toolName,
            detail: `${describe(cmd)}:这一行已经不在了(可能已被删除)`,
          });
        } else if (rowHash(cur) !== after.hash) {
          conflicts.push({
            seq: row.seq,
            toolName: row.toolName,
            detail: `${describe(cmd)}:这一行在 agent 建好之后被改过,硬删会连你的改动一起没掉`,
          });
        }
      }
    }
    sim = applyRewindToSnapshot(sim, reverseChain([{ inverse: row.inverse, after: row.after }]));
  }

  return {
    entryCount: rows.length,
    tools: [...toolCount.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    hardDeleteCount,
    conflicts,
    foreignEntryCount,
  };
}

const json = (v: unknown): string => (typeof v === 'string' ? `「${v}」` : JSON.stringify(v));
const describe = (c: RewindCommand): string =>
  'id' in c ? `${c.kind.replace(/^(update|hardDelete)/, '')} ${String(c.id).slice(0, 8)}` : c.kind;

/**
 * 执行回滚。
 *
 * 事务前先 `VACUUM INTO` 一份整库快照 —— 这**不是**界面上的 undo(用户要的不可撤销保持
 * 不变),而是出事之后的人工救援通道。实测 2ms / 180KB,拿这个换掉"一次误点永久丢数据"
 * 的尾部风险,便宜得没有理由不做。只留最近 3 份。
 */
export function executeRewind(
  db: Db,
  store: RewindStore,
  rows: RewindLogRow[],
  now: string,
  /** 备份目录。注入而不是自己取 —— 这样整个模块不依赖 electron,可以离线对拍 */
  backupDir: string | null,
): { backupPath: string | null } {
  const backupPath = backupDir === null ? null : backup(db, backupDir);
  const batches: RewindBatch[] = rows.map((r) => ({ inverse: r.inverse, after: r.after }));
  store.applyRewind(reverseChain(batches));
  const marks = rows.map(() => '?').join(',');
  db.prepare(`UPDATE agent_rewind_log SET rewound_at = ? WHERE seq IN (${marks})`).run(
    now,
    ...rows.map((r) => r.seq),
  );
  return { backupPath };
}

function backup(db: Db, dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite3`);
    db.prepare('VACUUM INTO ?').run(path);
    // 只留最近 3 份
    const old = readdirSync(dir)
      .filter((f) => f.endsWith('.sqlite3'))
      .sort()
      .slice(0, -3);
    for (const f of old) rmSync(join(dir, f), { force: true });
    return path;
  } catch (e) {
    process.stderr.write(`[rewind] 备份失败(不阻塞回滚): ${String(e)}\n`);
    return null;
  }
}
