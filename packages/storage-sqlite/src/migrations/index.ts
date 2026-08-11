/**
 * 迁移(源码,提交入库):按序号排列的内嵌 SQL(docs/DESIGN.md §2.2)。
 * schema 权威 = docs/DESIGN.md §5.1,此处逐字转写为 SQLite 方言。
 * 只允许追加新迁移,禁止修改已发布条目。
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE contexts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  deadline TEXT,
  parent_id TEXT REFERENCES projects(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','complete')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_projects_parent ON projects(parent_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  context_id TEXT NOT NULL REFERENCES contexts(id),
  estimated_minutes INTEGER NOT NULL DEFAULT 15,
  energy TEXT NOT NULL DEFAULT 'medium',
  priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  project_id TEXT REFERENCES projects(id),
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','deleted')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  deleted_at TEXT
);
CREATE INDEX idx_tasks_context ON tasks(context_id, status);
CREATE INDEX idx_tasks_project ON tasks(project_id, status);

CREATE TABLE calendar_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  project_id TEXT REFERENCES projects(id),
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  source_task_json TEXT
);
CREATE INDEX idx_calendar_date ON calendar_items(date, done);

CREATE TABLE waiting_for (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  delegated_to TEXT NOT NULL DEFAULT 'someone',
  project_id TEXT REFERENCES projects(id),
  delegated_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  source_task_json TEXT
);

CREATE TABLE list_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('someday','reference','trash')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  label_id TEXT NOT NULL REFERENCES labels(id),
  PRIMARY KEY (task_id, label_id)
);

CREATE TABLE filters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  query_json TEXT NOT NULL
);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  calendar_item_id TEXT REFERENCES calendar_items(id),
  remind_at TEXT NOT NULL,
  dispatched INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK ((task_id IS NULL) <> (calendar_item_id IS NULL))
);
CREATE INDEX idx_reminders_due ON reminders(dispatched, remind_at);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  sdk_session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  forked_from TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE agent_audit (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allowed-auto','allowed-user','denied')),
  result_summary TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_audit_conv ON agent_audit(conversation_id, created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'task-description-scheduled-date',
    // M5R(INVARIANTS §2.3 桌面扩展字段 / D-19)
    sql: `
ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN scheduled_date TEXT;
`,
  },
  {
    version: 3,
    name: 'task-bucket',
    // M5R2 容器模型(D-20):'project' ⟺ project_id 非空,回填既有数据
    sql: `
ALTER TABLE tasks ADD COLUMN bucket TEXT NOT NULL DEFAULT 'inbox'
  CHECK (bucket IN ('inbox','project','someday','reference'));
UPDATE tasks SET bucket = 'project' WHERE project_id IS NOT NULL;
`,
  },
  {
    version: 4,
    name: 'flat-projects-subtasks-comments',
    // D-21:项目平面化(重建表去 parent_id,存量子项目升为顶层)+
    // 任务子树(parent_task_id,INV-25)+ 任务评论。
    // 表重建期间外键约束须为 OFF —— openDb 在 migrate 之后才开 foreign_keys。
    sql: `
CREATE TABLE projects_v4 (
  id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','complete')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
INSERT INTO projects_v4 (id, outcome, deadline, status, created_at, completed_at)
  SELECT id, outcome, deadline, status, created_at, completed_at FROM projects;
DROP TABLE projects;
ALTER TABLE projects_v4 RENAME TO projects;

ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at);
`,
  },
  {
    version: 5,
    name: 'task-sort-order',
    // D-24/INV-27:手动排序。存量任务默认 0,同级组内按 (sort_order, created_at) 兜底稳定。
    sql: `
ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 6,
    name: 'calendar-unification',
    // D-23/M6a 日历统一:任务获得 start_time/duration_minutes;calendar_items 迁移为
    // 带时间的任务(id 复用,提醒随迁),随后删除该表;reminders 重建去 calendar_item_id。
    // 注:source_task_json 归档快照随实体退役丢弃(INV-19 退役)。
    // context 取 sort_order 最小的未归档 context;若库里有日历数据却一个 context 都没有
    // (历史 UI 允许不建 context 直接建日历项),先补一个 '@migrated' 兜底 context ——
    // 否则 NOT NULL(context_id)使整个迁移失败、应用永远起不来。completed_at 无真实完成
    // 时刻可用,取 MAX(created_at, date)(完成不早于事件日,近似)。
    // 表重建期间外键 OFF(openDb 在 migrate 之后才开 foreign_keys)。
    sql: `
ALTER TABLE tasks ADD COLUMN start_time TEXT;
ALTER TABLE tasks ADD COLUMN duration_minutes INTEGER;

INSERT INTO contexts (id, name, sort_order, created_at, archived)
SELECT 'ctx-migrated-v6', '@migrated', 0,
       COALESCE((SELECT MIN(created_at) FROM calendar_items), '1970-01-01T00:00:00'), 0
WHERE EXISTS (SELECT 1 FROM calendar_items)
  AND NOT EXISTS (SELECT 1 FROM contexts);

INSERT INTO tasks (id, title, context_id, estimated_minutes, energy, priority, project_id,
                   deadline, status, created_at, completed_at, deleted_at, description,
                   scheduled_date, bucket, parent_task_id, sort_order, start_time, duration_minutes)
SELECT c.id, c.title,
       COALESCE(
         (SELECT id FROM contexts WHERE archived = 0 ORDER BY sort_order LIMIT 1),
         (SELECT id FROM contexts ORDER BY sort_order LIMIT 1)),
       15, 'medium', 3, c.project_id,
       NULL,
       CASE WHEN c.done THEN 'done' ELSE 'active' END,
       c.created_at,
       CASE WHEN c.done THEN MAX(c.created_at, c.date) ELSE NULL END,
       NULL, '', c.date,
       CASE WHEN c.project_id IS NULL THEN 'inbox' ELSE 'project' END,
       NULL,
       10000 + (SELECT COUNT(*) FROM calendar_items c2
                WHERE c2.created_at < c.created_at OR (c2.created_at = c.created_at AND c2.id < c.id)),
       c.time, NULL
FROM calendar_items c;

UPDATE reminders SET task_id = calendar_item_id, calendar_item_id = NULL
  WHERE calendar_item_id IS NOT NULL;
CREATE TABLE reminders_v6 (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  remind_at TEXT NOT NULL,
  dispatched INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
INSERT INTO reminders_v6 (id, task_id, remind_at, dispatched, created_at)
  SELECT id, task_id, remind_at, dispatched, created_at FROM reminders;
DROP TABLE reminders;
ALTER TABLE reminders_v6 RENAME TO reminders;
CREATE INDEX idx_reminders_due ON reminders(dispatched, remind_at);

DROP TABLE calendar_items;
`,
  },
  {
    version: 7,
    name: 'external-calendar-mirror',
    // D-25/INV-29(M6c-3a):外部日历事件镜像为任务。external_id 全局唯一(同一事件
    // 只对应一个本地任务);external_calendar_id 用于着色与随日历显隐。
    sql: `
ALTER TABLE tasks ADD COLUMN external_id TEXT;
ALTER TABLE tasks ADD COLUMN external_calendar_id TEXT;
CREATE UNIQUE INDEX idx_tasks_external ON tasks(external_id) WHERE external_id IS NOT NULL;
`,
  },
  {
    version: 8,
    name: 'task-push-state',
    // D-26/INV-30(M6c-3b):任务 → 专用 Claudoist 日历的推送态。
    // pushed_event_id 记住对应的 Google 事件;pushed_fingerprint 用于跳过无变化的推送。
    sql: `
ALTER TABLE tasks ADD COLUMN pushed_event_id TEXT;
ALTER TABLE tasks ADD COLUMN pushed_fingerprint TEXT;
`,
  },
  {
    version: 9,
    name: 'task-time-zone',
    // D-27/INV-31(M6d):时区。NULL = 浮动时间(跨时区不变),与既有 naive 语义一致,
    // 故存量任务无需回填。
    sql: `
ALTER TABLE tasks ADD COLUMN time_zone TEXT;
`,
  },
  {
    version: 10,
    name: 'priority-flip',
    // D-29:priority 方向翻转为 1 = 最高、5 = 最低(与 Todoist 的 pN 同向)。
    // 存量值必须一起翻,否则旧数据的"最高"会变成"最低" —— 这是静默的语义损坏。
    // 3(中)是对称中点,翻转后不动;CHECK (1..5) 与默认值 3 都不受影响。
    // filters.query_json 里的 priorityMin 同步改名为 priorityMax 并取补值:
    // 旧 {priorityMin:n} = "priority ≥ n" = "至少第 (6-n) 档重要" → 新 {priorityMax:6-n}。
    sql: `
UPDATE tasks SET priority = 6 - priority;
UPDATE filters
   SET query_json = json_remove(
         json_set(query_json, '$.priorityMax', 6 - json_extract(query_json, '$.priorityMin')),
         '$.priorityMin')
 WHERE json_extract(query_json, '$.priorityMin') IS NOT NULL;
`,
  },
  {
    version: 11,
    name: 'context-into-label',
    // D-30:context 并入 label(与 Todoist 一致,只保留一种自由多值标签)。
    //
    // 名称口径:label 名**不含 '@'**('@' 只是过滤器语法与界面显示的前缀),
    // 故 context '@home' → label 'home'。用户已有 label 'home'/'errands' 与
    // context '@home'/'@errands' **撞名 → 直接合并**(2026-08-11 用户定案):
    // INSERT OR IGNORE 撞上 labels.name 的 UNIQUE 约束时保留既有 label,
    // 随后按**名字**而非 id 关联,两边的任务因此落到同一个标签上。
    //
    // 顺序要紧:先补 task_labels 再删列 —— 反过来就再也不知道谁属于哪个 context。
    sql: `
INSERT OR IGNORE INTO labels (id, name, color)
SELECT c.id, ltrim(c.name, '@'), NULL FROM contexts c;

INSERT OR IGNORE INTO task_labels (task_id, label_id)
SELECT t.id, l.id
  FROM tasks t
  JOIN contexts c ON c.id = t.context_id
  JOIN labels l ON l.name = ltrim(c.name, '@');

DROP INDEX IF EXISTS idx_tasks_context;
ALTER TABLE tasks DROP COLUMN context_id;
DROP TABLE contexts;
`,
  },
  {
    version: 12,
    name: 'priority-flip-revert',
    // D-31:撤回 D-29(v10)的方向翻转,回到 1 = 最低、5 = 最高。
    //
    // 撤回的理由是比较的可读性:过滤器语言要支持 `p >= 4`(高及以上),而在 1 = 最高
    // 之下"大于"到底指"更重要"还是"数值更大",两种读法结论相反;5 = 最高时读法唯一。
    // 代价是与 Todoist 的 pN 相反 —— 这正是 INV-01 标 ⚠SP 的原因。
    //
    // v10 已在存量库上跑过,所以只能再翻一次而不是删掉 v10(迁移只允许追加)。
    // 6 - p 是对合运算,连翻两次恰好回到原值;3 始终不动。
    sql: `
UPDATE tasks SET priority = 6 - priority;
UPDATE filters
   SET query_json = json_remove(
         json_set(query_json, '$.priorityMin', 6 - json_extract(query_json, '$.priorityMax')),
         '$.priorityMax')
 WHERE json_extract(query_json, '$.priorityMax') IS NOT NULL;
`,
  },
];
