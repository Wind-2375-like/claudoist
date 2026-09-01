import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  Actor,
  ApplyMeta,
  Command,
  RewindCommand,
  GtdSnapshot,
  GtdStore,
  InboxItem,
  Label,
  ListItem,
  Project,
  Reminder,
  SavedFilter,
  Task,
  TaskComment,
  TaskLabel,
  WaitingFor,
} from '@gtd/domain';

/**
 * GtdStore 的 node:sqlite 实现(docs/DESIGN.md §2.2)。
 * - snapshot():按 rowid 序全量读出(与参照实现的追加序一致)。
 * - apply():整批一个事务,任何命令失败全部回滚(INV-17 的原子性载体)。
 * 正确性由 @gtd/domain 的 store-contract 套件对拍保证。
 */

type Row = Record<string, unknown>;

const bool = (v: unknown): boolean => v === 1;
const int = (b: boolean): number => (b ? 1 : 0);
const s = (v: unknown): string => v as string;
const sn = (v: unknown): string | null => (v === null ? null : (v as string));

const rowToInbox = (r: Row): InboxItem => ({
  id: s(r['id']),
  text: s(r['text']),
  createdAt: s(r['created_at']),
  position: r['position'] as number,
});

const rowToProject = (r: Row): Project => ({
  id: s(r['id']),
  outcome: s(r['outcome']),
  deadline: sn(r['deadline']),
  status: s(r['status']) as Project['status'],
  createdAt: s(r['created_at']),
  completedAt: sn(r['completed_at']),
  deletedAt: sn(r['deleted_at']),
  sortOrder: r['sort_order'] as number,
});

const rowToTask = (r: Row): Task => ({
  id: s(r['id']),
  title: s(r['title']),
  estimatedMinutes: r['estimated_minutes'] as number,
  energy: s(r['energy']),
  priority: r['priority'] as number,
  projectId: sn(r['project_id']),
  deadline: sn(r['deadline']),
  status: s(r['status']) as Task['status'],
  createdAt: s(r['created_at']),
  completedAt: sn(r['completed_at']),
  deletedAt: sn(r['deleted_at']),
  description: s(r['description']),
  scheduledDate: sn(r['scheduled_date']),
  bucket: s(r['bucket']) as Task['bucket'],
  parentTaskId: sn(r['parent_task_id']),
  sortOrder: r['sort_order'] as number,
  startTime: sn(r['start_time']),
  durationMinutes: r['duration_minutes'] as number | null,
  externalId: sn(r['external_id']),
  externalCalendarId: sn(r['external_calendar_id']),
  pushedEventId: sn(r['pushed_event_id']),
  pushedFingerprint: sn(r['pushed_fingerprint']),
  timeZone: sn(r['time_zone']),
  // v18:repeat_unit 是唯一判别列(IS NULL ⟺ 不循环)
  repeat:
    r['repeat_unit'] == null
      ? null
      : {
          every: r['repeat_every'] as number,
          unit: s(r['repeat_unit']) as NonNullable<Task['repeat']>['unit'],
          from: s(r['repeat_from']) as NonNullable<Task['repeat']>['from'],
          weekdays: (r['repeat_weekdays'] ?? null) as number | null,
          until: sn(r['repeat_until']),
          anchor: s(r['repeat_anchor']),
        },
  seriesId: sn(r['series_id']),
  dayOrder: (r['day_order'] ?? null) as number | null,
});

const rowToWaiting = (r: Row): WaitingFor => ({
  id: s(r['id']),
  description: s(r['description']),
  delegatedTo: s(r['delegated_to']),
  projectId: sn(r['project_id']),
  delegatedAt: s(r['delegated_at']),
  resolved: bool(r['resolved']),
  resolvedAt: sn(r['resolved_at']),
  sourceTaskJson: sn(r['source_task_json']),
});

const rowToListItem = (r: Row): ListItem => ({
  id: s(r['id']),
  kind: s(r['kind']) as ListItem['kind'],
  text: s(r['text']),
  createdAt: s(r['created_at']),
});

const rowToLabel = (r: Row): Label => ({
  id: s(r['id']),
  name: s(r['name']),
  color: sn(r['color']),
});

const rowToTaskLabel = (r: Row): TaskLabel => ({
  taskId: s(r['task_id']),
  labelId: s(r['label_id']),
});

const rowToReminder = (r: Row): Reminder => ({
  id: s(r['id']),
  taskId: s(r['task_id']),
  remindAt: s(r['remind_at']),
  dispatched: bool(r['dispatched']),
  createdAt: s(r['created_at']),
});

const rowToComment = (r: Row): TaskComment => ({
  id: s(r['id']),
  taskId: s(r['task_id']),
  body: s(r['body']),
  createdAt: s(r['created_at']),
});

const rowToFilter = (r: Row): SavedFilter => ({
  id: s(r['id']),
  name: s(r['name']),
  position: r['position'] as number,
  // D-32:该列自 v13 起存**查询原文**(列名沿用 query_json,改名要重建表,不值当)
  query: s(r['query_json']),
});

/**
 * 实体字段 → 列名/序列化(update patch 白名单即这些键)。
 * 多列形态(cols)给"一个实体键落多个列"的值对象用 —— Task.repeat 六列一体
 * (v18 跨列 CHECK 保证全有或全无,分开 patch 会撞 CHECK 整批回滚)。
 */
type ColumnSpec = Record<
  string,
  | { col: string; enc?: (v: unknown) => SQLInputValue }
  | { cols: string[]; enc: (v: unknown) => SQLInputValue[] }
>;

const encBool = (v: unknown): SQLInputValue => int(v as boolean);
const id0 = (v: unknown): SQLInputValue => v as SQLInputValue;

const REPEAT_COLS = [
  'repeat_unit',
  'repeat_every',
  'repeat_from',
  'repeat_weekdays',
  'repeat_until',
  'repeat_anchor',
];
const encRepeat = (v: unknown): SQLInputValue[] => {
  const r = v as Task['repeat'];
  return r === null
    ? [null, null, null, null, null, null]
    : [r.unit, r.every, r.from, r.weekdays, r.until, r.anchor];
};

const COLS: Record<string, ColumnSpec> = {
  inbox_items: {
    text: { col: 'text' },
    createdAt: { col: 'created_at' },
    position: { col: 'position' },
  },
  projects: {
    outcome: { col: 'outcome' },
    deadline: { col: 'deadline' },
    status: { col: 'status' },
    createdAt: { col: 'created_at' },
    completedAt: { col: 'completed_at' },
    // ⚠ 不在白名单里的字段会被 update() 静默丢弃 —— 漏了它,软删项目会写不进 deleted_at
    deletedAt: { col: 'deleted_at' },
    sortOrder: { col: 'sort_order' },
  },
  tasks: {
    title: { col: 'title' },
    estimatedMinutes: { col: 'estimated_minutes' },
    energy: { col: 'energy' },
    priority: { col: 'priority' },
    projectId: { col: 'project_id' },
    deadline: { col: 'deadline' },
    status: { col: 'status' },
    createdAt: { col: 'created_at' },
    completedAt: { col: 'completed_at' },
    deletedAt: { col: 'deleted_at' },
    description: { col: 'description' },
    scheduledDate: { col: 'scheduled_date' },
    bucket: { col: 'bucket' },
    parentTaskId: { col: 'parent_task_id' },
    sortOrder: { col: 'sort_order' },
    startTime: { col: 'start_time' },
    durationMinutes: { col: 'duration_minutes' },
    externalId: { col: 'external_id' },
    externalCalendarId: { col: 'external_calendar_id' },
    pushedEventId: { col: 'pushed_event_id' },
    pushedFingerprint: { col: 'pushed_fingerprint' },
    timeZone: { col: 'time_zone' },
    // ⚠ 漏了这两条,update() 会静默丢弃:用户在 UI 设了循环、界面显示成功、重启后规则消失
    repeat: { cols: REPEAT_COLS, enc: encRepeat },
    seriesId: { col: 'series_id' },
    dayOrder: { col: 'day_order' },
  },
  waiting_for: {
    description: { col: 'description' },
    delegatedTo: { col: 'delegated_to' },
    projectId: { col: 'project_id' },
    delegatedAt: { col: 'delegated_at' },
    resolved: { col: 'resolved', enc: encBool },
    resolvedAt: { col: 'resolved_at' },
    sourceTaskJson: { col: 'source_task_json' },
  },
  list_items: {
    kind: { col: 'kind' },
    text: { col: 'text' },
    createdAt: { col: 'created_at' },
  },
  labels: {
    name: { col: 'name' },
    color: { col: 'color' },
  },
  filters: {
    name: { col: 'name' },
    position: { col: 'position' },
    query: { col: 'query_json' },
  },
  reminders: {
    taskId: { col: 'task_id' },
    remindAt: { col: 'remind_at' },
    dispatched: { col: 'dispatched', enc: encBool },
    createdAt: { col: 'created_at' },
  },
  task_comments: {
    taskId: { col: 'task_id' },
    body: { col: 'body' },
    createdAt: { col: 'created_at' },
  },
};

export class SqliteGtdStore implements GtdStore {
  constructor(private readonly db: DatabaseSync) {}

  snapshot(): GtdSnapshot {
    const all = (table: string): Row[] =>
      this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
    return {
      inbox: all('inbox_items').map(rowToInbox),
      tasks: all('tasks').map(rowToTask),
      projects: all('projects').map(rowToProject),
      waiting: all('waiting_for').map(rowToWaiting),
      listItems: all('list_items').map(rowToListItem),
      labels: all('labels').map(rowToLabel),
      taskLabels: all('task_labels').map(rowToTaskLabel),
      filters: all('filters').map(rowToFilter),
      reminders: all('reminders').map(rowToReminder),
      comments: all('task_comments').map(rowToComment),
    };
  }

  apply(commands: Command[], _actor: Actor, meta?: ApplyMeta): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of commands) this.applyOne(c);
      // 日志必须写在**同一个事务里**:apply 第一句就 BEGIN,外面再包一层会报
      // "cannot start a transaction within a transaction"(嵌套 BEGIN 不允许)。
      // 写在里面还顺带保证了「改动落库」与「逆命令入账」原子同生共死 ——
      // 少了这条,崩在中间就会出现改了却回滚不了的记录。
      const log = meta?.rewindLog;
      if (log !== undefined) {
        this.db
          .prepare(
            `INSERT INTO agent_rewind_log
               (conversation_id, turn_id, anchor_uuid, tool_name, tool_use_id,
                inverse_json, after_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            log.conversationId,
            log.turnId,
            log.anchorUuid,
            log.toolName,
            log.toolUseId,
            JSON.stringify({ v: 1, cmds: log.batch.inverse }),
            JSON.stringify(log.batch.after),
            log.createdAt,
          );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 回滚执行口(INV-35)。**不记日志** —— 回滚本身不可撤销,这是用户明确接受的语义。
   *
   * `defer_foreign_keys` 让批内乱序删除成立(逆命令是整批倒序的,先删父后删子很正常)。
   * ⚠ 外键违规要到 COMMIT 才报,**而且事务仍然开着** —— catch 分支必须显式 ROLLBACK。
   */
  applyRewind(cmds: RewindCommand[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    this.db.exec('PRAGMA defer_foreign_keys = ON');
    try {
      for (const c of cmds) {
        switch (c.kind) {
          case 'hardDeleteTask':
            this.db.prepare('DELETE FROM tasks WHERE id = ?').run(c.id);
            break;
          case 'hardDeleteProject':
            this.db.prepare('DELETE FROM projects WHERE id = ?').run(c.id);
            break;
          case 'hardDeleteWaitingFor':
            this.db.prepare('DELETE FROM waiting_for WHERE id = ?').run(c.id);
            break;
          default:
            this.applyOne(c);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private insert(table: string, entity: Record<string, unknown>): void {
    const spec = COLS[table]!;
    const cols = ['id', ...Object.values(spec).flatMap((c) => ('cols' in c ? c.cols : [c.col]))];
    const values: SQLInputValue[] = [
      entity['id'] as SQLInputValue,
      ...Object.entries(spec).flatMap(([key, c]) =>
        'cols' in c ? c.enc(entity[key]) : [(c.enc ?? id0)(entity[key])],
      ),
    ];
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    this.db.prepare(sql).run(...values);
  }

  private update(table: string, id: string, patch: Record<string, unknown>): void {
    const spec = COLS[table]!;
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const c = spec[key];
      if (!c) continue; // 白名单外的键忽略(与参照实现的展开合并等价:实体无未知键)
      // 多列值对象(repeat)逐列展开 —— 六列同批 SET,守住 v18 的全有或全无 CHECK
      if ('cols' in c) {
        const vs = c.enc(value);
        c.cols.forEach((col, i) => {
          sets.push(`${col} = ?`);
          values.push(vs[i]!);
        });
      } else {
        sets.push(`${c.col} = ?`);
        values.push((c.enc ?? id0)(value));
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  private applyOne(c: Command): void {
    switch (c.kind) {
      case 'createInboxItem':
        return this.insert('inbox_items', c.item as unknown as Record<string, unknown>);
      case 'deleteInboxItem':
        this.db.prepare('DELETE FROM inbox_items WHERE id = ?').run(c.id);
        return;
      case 'createTask':
        return this.insert('tasks', c.task as unknown as Record<string, unknown>);
      case 'updateTask':
        return this.update('tasks', c.id, c.patch as Record<string, unknown>);
      case 'createProject':
        return this.insert('projects', c.project as unknown as Record<string, unknown>);
      case 'updateProject':
        return this.update('projects', c.id, c.patch as Record<string, unknown>);
      case 'createWaitingFor':
        return this.insert('waiting_for', c.item as unknown as Record<string, unknown>);
      case 'updateWaitingFor':
        return this.update('waiting_for', c.id, c.patch as Record<string, unknown>);
      case 'createListItem':
        return this.insert('list_items', c.item as unknown as Record<string, unknown>);
      case 'deleteListItem':
        this.db.prepare('DELETE FROM list_items WHERE id = ?').run(c.id);
        return;
      case 'createLabel':
        return this.insert('labels', c.label as unknown as Record<string, unknown>);
      case 'updateLabel':
        return this.update('labels', c.id, c.patch as Record<string, unknown>);
      case 'deleteLabel':
        // 与参照实现一致:级联清除 task_labels
        this.db.prepare('DELETE FROM task_labels WHERE label_id = ?').run(c.id);
        this.db.prepare('DELETE FROM labels WHERE id = ?').run(c.id);
        return;
      case 'assignLabel':
        // 幂等(参照实现去重)
        this.db
          .prepare('INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)')
          .run(c.taskId, c.labelId);
        return;
      case 'unassignLabel':
        this.db
          .prepare('DELETE FROM task_labels WHERE task_id = ? AND label_id = ?')
          .run(c.taskId, c.labelId);
        return;
      case 'createFilter':
        return this.insert('filters', c.filter as unknown as Record<string, unknown>);
      case 'updateFilter':
        return this.update('filters', c.id, c.patch as Record<string, unknown>);
      case 'deleteFilter':
        this.db.prepare('DELETE FROM filters WHERE id = ?').run(c.id);
        return;
      case 'createReminder':
        return this.insert('reminders', c.reminder as unknown as Record<string, unknown>);
      case 'updateReminder':
        return this.update('reminders', c.id, c.patch as Record<string, unknown>);
      case 'deleteReminder':
        this.db.prepare('DELETE FROM reminders WHERE id = ?').run(c.id);
        return;
      case 'createComment':
        return this.insert('task_comments', c.comment as unknown as Record<string, unknown>);
      case 'deleteComment':
        this.db.prepare('DELETE FROM task_comments WHERE id = ?').run(c.id);
        return;
    }
  }
}
