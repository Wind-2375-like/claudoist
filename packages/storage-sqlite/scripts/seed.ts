/**
 * `pnpm seed` — 向 dev userData 数据库写入覆盖全实体的演示数据(dev-only)。
 * 语义(ROADMAP M3):默认拒绝写入非空库;`--reset` 删库重建后写入;
 * `--db=<path>` 覆盖目标(默认 Claudoist-dev 的 dev 数据库)。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Command } from '@gtd/domain';
import { openDb } from '../src/db';
import { SqliteGtdStore } from '../src/store';

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const dbArg = args.find((a) => a.startsWith('--db='))?.slice('--db='.length);
const dbPath =
  dbArg ??
  join(homedir(), 'Library', 'Application Support', 'Claudoist-dev', 'data', 'gtd.sqlite3');

if (reset && existsSync(dbPath)) {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  console.log(`--reset:已删除 ${dbPath}`);
}
mkdirSync(dirname(dbPath), { recursive: true });

const db = openDb(dbPath);
const store = new SqliteGtdStore(db);

const existing = store.snapshot();
const nonEmpty = existing.tasks.length + existing.inbox.length + existing.projects.length > 0;
if (nonEmpty) {
  console.error(`目标库非空(${dbPath})。默认拒绝写入;如需重建请加 --reset。`);
  process.exit(1);
}

// 本地 naive 日期/时间(INV-03)—— 严禁 toISOString(UTC 会在晚间把"今天"推到明天)
const pad = (n: number): string => String(n).padStart(2, '0');
const localDate = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const day = (offset: number): string => {
  const d = new Date(now);
  d.setDate(d.getDate() + offset);
  return localDate(d);
};
const T = `${localDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
const id = (): string => randomUUID();

const commands: Command[] = [];

// labels(D-30:原 contexts 已并入,名字不带 '@';home/errands 两边同名 → 天然合并)
const labelIds: Record<string, string> = {};
[
  'computer',
  'phone',
  'errands',
  'home',
  'office',
  'lab',
  'read',
  'next',
  'waiting_for',
  'calls',
  'email',
  'work',
].forEach((name) => {
  const lid = id();
  labelIds[name] = lid;
  commands.push({ kind: 'createLabel', label: { id: lid, name, color: null } });
});

// inbox(未理清的原始想法 = inbox 容器任务,D-20)
const rawThoughts = [
  '给论文加一节 ablation',
  '订下周去苏黎世的火车票',
  '看看新出的 agent 基准测试',
  '妈妈生日礼物',
];

// 项目(D-21 平面):两个 active(其一带 deadline)+ 一个 complete
const pRelease = id();
const pM4 = id();
const pOld = id();
commands.push(
  {
    kind: 'createProject',
    project: {
      id: pRelease,
      outcome: '发布 Claudoist 1.0',
      deadline: day(30),
      status: 'active',
      createdAt: T,
      completedAt: null,
      deletedAt: null,
    },
  },
  {
    kind: 'createProject',
    project: {
      id: pM4,
      outcome: '完成只读壳(M4)',
      deadline: day(7),
      status: 'active',
      createdAt: T,
      completedAt: null,
      deletedAt: null,
    },
  },
  {
    kind: 'createProject',
    project: {
      id: pOld,
      outcome: '已完成的老项目',
      deadline: null,
      status: 'complete',
      createdAt: T,
      completedAt: T,
      deletedAt: null,
    },
  },
);

// tasks:覆盖 priority/energy/deadline(过期、今天、将来)/status
interface SeedTask {
  title: string;
  ctx: string;
  min: number;
  energy: string;
  pri: number;
  project?: string;
  deadline?: string;
  status?: 'active' | 'done' | 'deleted';
  labels?: string[];
  desc?: string;
  sched?: string;
  bucket?: 'inbox' | 'someday' | 'reference';
}
const seedTasks: SeedTask[] = [
  {
    title: '写 IPC 读通道',
    ctx: '@computer',
    min: 60,
    energy: 'high',
    pri: 5,
    project: pM4,
    deadline: day(7),
    labels: ['work', 'next'],
  },
  {
    title: '侧栏组件拆分',
    ctx: '@computer',
    min: 45,
    energy: 'medium',
    pri: 4,
    project: pM4,
    deadline: day(7),
  },
  {
    title: '设计应用图标',
    ctx: '@computer',
    min: 30,
    energy: 'medium',
    pri: 3,
    project: pRelease,
    deadline: day(21),
  },
  {
    title: '交报销单',
    ctx: '@office',
    min: 10,
    energy: 'low',
    pri: 4,
    deadline: day(-2),
    labels: ['work'],
  },
  {
    title: '读《Getting Things Done》第三章',
    ctx: '@home',
    min: 25,
    energy: 'low',
    pri: 2,
    labels: ['read'],
    sched: day(1),
  },
  {
    title: '给导师发周报',
    ctx: '@computer',
    min: 15,
    energy: 'medium',
    pri: 5,
    deadline: day(0),
    sched: day(0),
    desc: '附上 ablation 初步数字',
    labels: ['email', 'work'],
  },
  { title: '买猫粮', ctx: '@errands', min: 20, energy: 'low', pri: 3, labels: ['errands'] },
  { title: '约牙医', ctx: '@phone', min: 5, energy: 'low', pri: 4, labels: ['calls'] },
  { title: '整理书桌', ctx: '@home', min: 15, energy: 'low', pri: 1, labels: ['home'] },
  { title: '已完成:配置 CI', ctx: '@computer', min: 30, energy: 'high', pri: 4, status: 'done' },
  { title: '已删除:过时想法', ctx: '@computer', min: 5, energy: 'low', pri: 1, status: 'deleted' },
];
for (const [ti, t] of seedTasks.entries()) {
  const tid = id();
  const status = t.status ?? 'active';
  commands.push({
    kind: 'createTask',
    task: {
      id: tid,
      title: t.title,
      estimatedMinutes: t.min,
      energy: t.energy,
      priority: t.pri,
      projectId: t.project ?? null,
      deadline: t.deadline ?? null,
      status,
      createdAt: T,
      completedAt: status === 'done' ? T : null,
      deletedAt: status === 'deleted' ? T : null,
      description: t.desc ?? '',
      scheduledDate: t.sched ?? null,
      bucket: t.project ? 'project' : (t.bucket ?? 'inbox'),
      parentTaskId: null,
      sortOrder: ti,
      startTime: null,
      durationMinutes: null,
      externalId: null,
      externalCalendarId: null,
      pushedEventId: null,
      pushedFingerprint: null,
      timeZone: null,
      repeat: null,
      seriesId: null,
    },
  });
  // D-30:原 context 现在就是一个标签(去掉 '@');与 t.labels 去重由 assignLabel 幂等保证
  for (const l of new Set([t.ctx.replace(/^@/, ''), ...(t.labels ?? [])])) {
    commands.push({ kind: 'assignLabel', taskId: tid, labelId: labelIds[l]! });
  }
}

// 子任务树(D-21/INV-25)+ 评论:发布材料 → release notes → changelog(3 层)
const tMaterials = id();
const tNotes = id();
const tChangelog = id();
const subtask = (tid: string, title: string, parent: string | null, done = false): Command => ({
  kind: 'createTask',
  task: {
    id: tid,
    title,
    estimatedMinutes: 20,
    energy: 'medium',
    priority: 4,
    projectId: pRelease,
    deadline: day(30), // INV-10:项目 deadline 副本
    status: done ? 'done' : 'active',
    createdAt: T,
    completedAt: done ? T : null,
    deletedAt: null,
    description: '',
    scheduledDate: null,
    bucket: 'project',
    parentTaskId: parent,
    sortOrder: 0,
    startTime: null,
    durationMinutes: null,
    externalId: null,
    externalCalendarId: null,
    pushedEventId: null,
    pushedFingerprint: null,
    timeZone: null,
    repeat: null,
    seriesId: null,
  },
});
commands.push(
  subtask(tMaterials, '准备 1.0 发布材料', null),
  subtask(tNotes, '写 release notes', tMaterials),
  subtask(tChangelog, '整理 changelog', tNotes, true),
  {
    kind: 'createComment',
    comment: { id: id(), taskId: tMaterials, body: '记得配两张截图', createdAt: T },
  },
  {
    kind: 'createComment',
    comment: { id: id(), taskId: tMaterials, body: 'changelog 已经整理完了', createdAt: T },
  },
);

let bucketOrder = 0;
function seedBucketTask(title: string, bucket: 'someday' | 'reference'): void {
  commands.push({
    kind: 'createTask',
    task: {
      id: id(),
      title,
      estimatedMinutes: 15,
      energy: 'medium',
      priority: 3,
      projectId: null,
      deadline: null,
      status: 'active',
      createdAt: T,
      completedAt: null,
      deletedAt: null,
      description: '',
      scheduledDate: null,
      bucket,
      parentTaskId: null,
      sortOrder: bucketOrder++,
      startTime: null,
      durationMinutes: null,
      externalId: null,
      externalCalendarId: null,
      pushedEventId: null,
      pushedFingerprint: null,
      timeZone: null,
      repeat: null,
      seriesId: null,
    },
  });
}

for (const [ri, title] of rawThoughts.entries()) {
  commands.push({
    kind: 'createTask',
    task: {
      id: id(),
      title,
      estimatedMinutes: 15,
      energy: 'medium',
      priority: 3,
      projectId: null,
      deadline: null,
      status: 'active',
      createdAt: T,
      completedAt: null,
      deletedAt: null,
      description: '',
      scheduledDate: null,
      bucket: 'inbox',
      parentTaskId: null,
      sortOrder: 100 + ri,
      startTime: null,
      durationMinutes: null,
      externalId: null,
      externalCalendarId: null,
      pushedEventId: null,
      pushedFingerprint: null,
      timeZone: null,
      repeat: null,
      seriesId: null,
    },
  });
}

// 带时间任务(D-23/M6a,取代 calendar_items):今天定时 + 今天全天 + 明天 + 已完成
let timedOrder = 200;
const timed = (
  title: string,
  date: string,
  time: string | null,
  project: string | null,
  done = false,
): Command => ({
  kind: 'createTask',
  task: {
    id: id(),
    title,
    estimatedMinutes: 60,
    energy: 'medium',
    priority: 3,
    projectId: project,
    deadline: null,
    status: done ? 'done' : 'active',
    createdAt: T,
    completedAt: done ? T : null,
    deletedAt: null,
    description: '',
    scheduledDate: date,
    bucket: project ? 'project' : 'inbox',
    parentTaskId: null,
    sortOrder: timedOrder++,
    startTime: time,
    durationMinutes: time !== null ? 60 : null,
    externalId: null,
    externalCalendarId: null,
    pushedEventId: null,
    pushedFingerprint: null,
    timeZone: null,
    repeat: null,
    seriesId: null,
  },
});
commands.push(
  timed('组会', day(0), '15:00', pRelease),
  timed('健身房约练', day(0), null, null),
  timed('和 Wei 过 M4 设计', day(1), '10:30', pM4),
  timed('已完成:牙医复诊', day(-3), '09:00', null, true),
);

// waiting:未解决 + 已解决
commands.push(
  {
    kind: 'createWaitingFor',
    item: {
      id: id(),
      description: '实验室服务器扩容审批',
      delegatedTo: 'IT 部门',
      projectId: pRelease,
      delegatedAt: T,
      resolved: false,
      resolvedAt: null,
      sourceTaskJson: null,
    },
  },
  {
    kind: 'createWaitingFor',
    item: {
      id: id(),
      description: '合作者返回论文意见',
      delegatedTo: 'Alice',
      projectId: null,
      delegatedAt: T,
      resolved: true,
      resolvedAt: T,
      sourceTaskJson: null,
    },
  },
);

// someday / reference 容器任务(D-20:任务制,不再用 ListItem)
seedBucketTask('学木工', 'someday');
seedBucketTask('把博客迁到自建服务器', 'someday');
seedBucketTask('GTD 五阶段:capture/clarify/organize/reflect/engage', 'reference');

// 预置 filters(DESIGN §8)
// D-32/INV-33:存查询原文
const filters: [string, string][] = [
  ['Low energy · <15 min', 'energy: low & est: 15'],
  ['Due this week', `deadline before: ${day(7)}`],
  ['No project', 'no project'],
  ['High priority next', 'p>=4'],
  // Date/Deadline 分离后最有价值的一条:一周内到期却还没决定哪天做
  ['该排期了', 'deadline before: +7 days & no date'],
];
filters.forEach(([name, query], i) =>
  commands.push({ kind: 'createFilter', filter: { id: id(), name, position: i + 1, query } }),
);

store.apply(commands, 'user');
const snap = store.snapshot();
console.log(`seed 完成 → ${dbPath}`);
console.log(
  `  inbox-tasks ${snap.tasks.filter((t) => t.bucket === 'inbox' && t.status === 'active').length} · projects ${snap.projects.length} · tasks ${snap.tasks.length} · waiting ${snap.waiting.length} · lists ${snap.listItems.length} · labels ${snap.labels.length} · filters ${snap.filters.length}`,
);
db.close();
