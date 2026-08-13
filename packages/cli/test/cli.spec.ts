import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clock, FlowDeps } from '@gtd/domain';
import { openDb, SqliteGtdStore } from '@gtd/storage-sqlite';
import { CliError, makeDeps, runCommand, type CliArgs } from '../src/commands';
import { resolveDbPath } from '../src/db';

/** 固定时钟(INV-03 本地 naive;测试可复现)。 */
const fixedClock: Clock = {
  now: () => '2026-08-09T10:00:00',
  today: () => '2026-08-09',
};

const args = (positionals: string[] = [], opts: CliArgs['opts'] = {}): CliArgs => ({
  positionals,
  opts,
});

describe('@gtd/cli 命令层(真实 sqlite 库)', () => {
  let dir: string;
  let store: SqliteGtdStore;
  let deps: FlowDeps;
  const run = (cmd: string, a: CliArgs = args()): unknown => runCommand(cmd, store, deps, a).data;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gtd-cli-'));
    store = new SqliteGtdStore(openDb(join(dir, 'gtd.sqlite3')));
    deps = makeDeps(fixedClock);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('D-30:空库直接 add 即可(无 context 前置);label-add 建标签', () => {
    const t = run('add', args(['写周报'])) as { title: string };
    expect(t.title).toBe('写周报');
    run('label-add', args(['电脑']));
    const ls = run('labels') as { name: string }[];
    expect(ls.map((l) => l.name)).toEqual(['电脑']);
  });

  it('add 带属性入 inbox;--json data 含 id', () => {
    const t = run(
      'add',
      args(['写周报'], { date: 'today', deadline: 'tomorrow', priority: '5' }),
    ) as {
      id: string;
      bucket: string;
      scheduledDate: string;
      deadline: string;
      priorityLabel: string;
    };
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/); // INV-04 完整 UUID
    expect(t.bucket).toBe('inbox'); // D-20:默认容器 inbox
    expect(t.scheduledDate).toBe('2026-08-09');
    expect(t.deadline).toBe('2026-08-10'); // tomorrow 本地展开
    expect(t.priorityLabel).toBe('最高'); // INV-01:5 = 最高;D-14 文字展示
  });

  it('capture 多条零判断进 inbox(INV-16)', () => {
    const rows = run('capture', args(['想法A', '想法A'])) as { title: string; bucket: string }[];
    expect(rows).toHaveLength(2); // 重复内容合法
    expect(rows.every((r) => r.bucket === 'inbox')).toBe(true);
    const inbox = run('list', args(['inbox'])) as unknown[];
    expect(inbox).toHaveLength(4); // 前两个用例各留一条「写周报」+ 本例两条
  });

  it('move:id 前缀引用 → someday', () => {
    const [a] = run('capture', args(['孵化中的想法'])) as { id: string }[];
    const moved = run('move', args([a!.id.slice(0, 8), 'someday'])) as { bucket: string };
    expect(moved.bucket).toBe('someday');
    expect((run('list', args(['someday'])) as unknown[]).length).toBe(1);
  });

  it('标题引用不唯一(两条 想法A)→ 报错并列出候选', () => {
    expect(() => run('show', args(['想法A']))).toThrow(/不唯一/);
  });

  it('标题引用优先解析到唯一 active:同名 done 存在时 complete 不歧义(回归)', () => {
    // 完成一条『周报』(done),再建同名 active『周报』
    const first = run('add', args(['周报'])) as { id: string };
    run('complete', args([first.id]));
    const second = run('add', args(['周报'])) as { id: string };
    // complete 按标题 → 唯一 active,不被 done 撞成歧义
    const c = run('complete', args(['周报'])) as { taskId: string };
    expect(c.taskId).toBe(second.id);
    // 两条都 done 后,按标题 show → 歧义报错(无唯一 active 且非 deleted 有 2 条)
    expect(() => run('show', args(['周报']))).toThrow(/不唯一/);
  });

  it('move 到项目(名称引用)+ INV-10 copy-on-move', () => {
    run('project-add', args(['发布 v1'], { deadline: '2026-09-01' }));
    const t = run('add', args(['准备发布说明'])) as { id: string; deadline: string | null };
    expect(t.deadline).toBeNull();
    const moved = run('move', args([t.id, '发布 v1'])) as {
      bucket: string;
      project: string;
      deadline: string;
    };
    expect(moved.bucket).toBe('project');
    expect(moved.project).toBe('发布 v1');
    expect(moved.deadline).toBe('2026-09-01'); // INV-10 move 版静默复制
  });

  it('today 统一列表(D-21):计划 ∪ 截止,去重', () => {
    const d = run('today') as { today: string; tasks: { title: string }[] };
    expect(d.today).toBe('2026-08-09');
    const titles = d.tasks.map((t) => t.title);
    expect(titles).toContain('写周报'); // scheduled=today 且 deadline=tomorrow
    expect(titles.filter((x) => x === '写周报')).toHaveLength(1); // 不重复计入
  });

  it('update:改标题、清 deadline(none)', () => {
    const t = run('add', args(['临时任务'], { deadline: '2026-08-20' })) as { id: string };
    const u = run('update', args([t.id], { title: '正式任务', deadline: 'none' })) as {
      title: string;
      deadline: string | null;
    };
    expect(u.title).toBe('正式任务');
    expect(u.deadline).toBeNull();
  });

  it('complete 返回项目余活动提示(INV-15 不级联);completed 列表可见', () => {
    const t = run('add', args(['项目内行动'], { project: '发布 v1' })) as { id: string };
    const c = run('complete', args([t.id])) as { projectHasRemainingActivity?: boolean };
    expect(c.projectHasRemainingActivity).toBe(true); // 项目里还有 准备发布说明
    const done = run('list', args(['completed'])) as { title: string }[];
    expect(done.map((x) => x.title)).toContain('项目内行动');
  });

  it('delete 软删;list 各处不再出现', () => {
    const t = run('add', args(['要删的'])) as { id: string };
    run('delete', args([t.id]));
    const all = run('list', args(['all'])) as { title: string }[];
    expect(all.map((x) => x.title)).not.toContain('要删的');
  });

  it('labels:label-add + add --labels 关联;未知 label 报错', () => {
    run('label-add', args(['work']));
    const t = run('add', args(['带标签'], { labels: 'work' })) as { labels: string[] };
    expect(t.labels).toEqual(['work']);
    expect(() => run('add', args(['x'], { labels: '不存在' }))).toThrow(CliError);
  });

  it('projects 平面列表含计数与进度(D-21)', () => {
    const rows = run('projects') as {
      name: string;
      activeCount: number;
      doneCount: number;
      progressPct: number;
    }[];
    const p = rows.find((n) => n.name === '发布 v1')!;
    expect(p.activeCount).toBe(1); // 准备发布说明(另一条已完成)
    expect(p.doneCount).toBe(1);
    expect(p.progressPct).toBe(50);
  });

  it('子任务:add --parent 建、show 树、complete/delete 子树纪律(INV-25/26)', () => {
    const parent = run('add', args(['整理发布材料'], { project: '发布 v1' })) as { id: string };
    const sub = run('add', args(['写 release notes'], { parent: parent.id })) as {
      id: string;
      parentTaskId: string;
      project: string;
      depth: number;
    };
    expect(sub.parentTaskId).toBe(parent.id);
    expect(sub.project).toBe('发布 v1'); // 继承父的项目
    expect(sub.depth).toBe(2);
    run('comment', args([parent.id, '记得配截图']));
    const detail = run('show', args([parent.id])) as {
      subtasks: { id: string }[];
      comments: { body: string }[];
    };
    expect(detail.subtasks.map((s) => s.id)).toContain(sub.id);
    expect(detail.comments.map((c) => c.body)).toContain('记得配截图');
    const done = run('complete', args([parent.id])) as { completedSubtaskCount: number };
    expect(done.completedSubtaskCount).toBe(1); // D-22:向下级联完成
    // 子任务随父完成;reopen 撤销父任务(仅父)
    expect((run('show', args([sub.id])) as { status: string }).status).toBe('done');
    run('reopen', args([parent.id]));
    expect((run('show', args([parent.id])) as { status: string }).status).toBe('active');
    expect((run('show', args([sub.id])) as { status: string }).status).toBe('done'); // 不级联重开
  });

  it('list 树状:根 + 嵌套子任务成树,data 为根数组带 children(M5R5)', () => {
    const p = run('add', args(['树根'])) as { id: string };
    const c1 = run('add', args(['子1'], { parent: p.id })) as { id: string };
    run('add', args(['孙1'], { parent: c1.id }));
    const roots = run('list', args(['inbox'])) as {
      id: string;
      children: { id: string; children: unknown[] }[];
    }[];
    const node = roots.find((r) => r.id === p.id)!;
    expect(node.children.map((c) => c.id)).toContain(c1.id); // 子任务在 children,不在顶层
    expect(node.children.find((c) => c.id === c1.id)!.children).toHaveLength(1); // 孙 nested
    expect(roots.map((r) => r.id)).not.toContain(c1.id); // 子任务不作为顶层根出现
  });

  it('reorder:--before 换位 / --parent 拖成子任务 / list 顺序随之(INV-27)', () => {
    const x = run('add', args(['排序X'])) as { id: string };
    const y = run('add', args(['排序Y'])) as { id: string };
    const z = run('add', args(['排序Z'])) as { id: string };
    // 把 Z 移到 X 之前 → inbox 顺序含 Z 在 X 前
    run('reorder', args([z.id], { before: x.id }));
    const roots1 = (run('list', args(['inbox'])) as { id: string }[]).map((r) => r.id);
    expect(roots1.indexOf(z.id)).toBeLessThan(roots1.indexOf(x.id));
    // 把 Y 拖成 X 的子任务
    const c = run('reorder', args([y.id], { parent: x.id })) as { parentTaskId: string | null };
    expect(c.parentTaskId).toBe(x.id);
    const roots2 = run('list', args(['inbox'])) as { id: string; children: { id: string }[] }[];
    expect(roots2.map((r) => r.id)).not.toContain(y.id); // Y 不再是顶层根
    expect(roots2.find((r) => r.id === x.id)!.children.map((ch) => ch.id)).toContain(y.id);
  });

  it('add --parent 支持 --labels/--remind(D-22 完整属性集)', () => {
    run('label-add', args(['sub-label']));
    const root = run('add', args(['根任务A'])) as { id: string };
    const sub = run(
      'add',
      args(['子任务A'], {
        parent: root.id,
        labels: 'sub-label',
        remind: '2026-08-10T09:00',
      }),
    ) as { id: string; labels: string[] };
    expect(sub.labels).toContain('sub-label');
    const detail = run('show', args([sub.id])) as { reminders: string[] };
    expect(detail.reminders.length).toBe(1);
  });

  it('project-update:改 deadline 命中继承行动时须显式二选一(INV-12/§5.4 单次调用)', () => {
    run('project-add', args(['迁移博客'], { deadline: '2026-10-01' }));
    const t = run('add', args(['导出旧文章'], { project: '迁移博客' })) as { deadline: string };
    expect(t.deadline).toBe('2026-10-01'); // INV-10
    // 不带任何选择 → 报错,不做半吊子更新(传播窗口只在本次)
    expect(() => run('project-update', args(['迁移博客'], { deadline: '2026-11-01' }))).toThrow(
      /--propagate/,
    );
    // --keep-tasks:只改项目,行动不动
    const r1 = run(
      'project-update',
      args(['迁移博客'], { deadline: '2026-11-01', 'keep-tasks': true }),
    ) as { propagated?: boolean };
    expect(r1.propagated).toBeUndefined();
    expect((run('show', args(['导出旧文章'])) as { deadline: string }).deadline).toBe('2026-10-01');
    // 把行动对齐当前值后再改,--propagate 同步
    run('update', args(['导出旧文章'], { deadline: '2026-11-01' }));
    const r2 = run(
      'project-update',
      args(['迁移博客'], { deadline: '2027-01-01', propagate: true }),
    ) as { propagated?: boolean };
    expect(r2.propagated).toBe(true);
    expect((run('show', args(['导出旧文章'])) as { deadline: string }).deadline).toBe('2027-01-01');
    // 未知选项报错(拼错不许无声吞掉)
    expect(() => run('project-update', args(['迁移博客'], { deadlnie: '2027-02-01' }))).toThrow(
      /不认识选项/,
    );
  });

  it('project-complete:完成项目,未完成任务保持不变(INV-15)', () => {
    run('project-add', args(['要归档的项目']));
    run('add', args(['遗留行动'], { project: '要归档的项目' }));
    const c = run('project-complete', args(['要归档的项目'])) as { activeTaskCount: number };
    expect(c.activeTaskCount).toBe(1);
    const projects2 = run('projects') as { name: string }[];
    expect(projects2.map((p) => p.name)).not.toContain('要归档的项目'); // 只列 active
    // 已完成项目不能再添任务(与 moveTask 同口径)
    expect(() => run('add', args(['新任务'], { project: '要归档的项目' }))).toThrow(CliError);
  });

  it('未知命令 / 未知列表报 CliError', () => {
    expect(() => run('nonsense')).toThrow(CliError);
    expect(() => run('list', args(['trash']))).toThrow(CliError);
  });

  // ---- 循环(D-37/INV-36)
  it('repeat:add --repeat=weekly:wed → 🔁 上行;complete 输出 ↻ 下一次;show 有下三次', () => {
    const t = run(
      'add',
      args(['写周会纪要'], {
        date: '2026-08-12',
        repeat: 'weekly:wed',
        'repeat-until': '2026-12-31',
      }),
    ) as {
      id: string;
      repeatShort: string | null;
    };
    expect(t.repeatShort).toBe('每周三');
    const out = runCommand('complete', store, deps, args(['写周会纪要']));
    expect(out.text).toContain('↻ 下一次:2026-08-19');
    const nxt = run('show', args(['写周会纪要'])) as {
      scheduledDate: string;
      nextOccurrences: string[];
    };
    expect(nxt.scheduledDate).toBe('2026-08-19');
    expect(nxt.nextOccurrences).toEqual(['2026-08-26', '2026-09-02', '2026-09-09']);
  });

  it('repeat:未给 --date 默认今天且输出点明;--date=none 被拒;--repeat=none 关闭', () => {
    const out = runCommand('add', store, deps, args(['倒垃圾'], { repeat: 'daily' }));
    expect(out.text).toContain('未给 --date,循环从今天 2026-08-09 起算');
    expect(() => run('update', args(['倒垃圾'], { date: 'none' }))).toThrow(/repeat=none/);
    const t = run('update', args(['倒垃圾'], { repeat: 'none' })) as { repeat: unknown };
    expect(t.repeat).toBeNull();
  });

  it('repeat:--repeat-basis 单独出现而无循环 → 报错;filter recurring 命中', () => {
    run('add', args(['一次性'], {}));
    expect(() => run('update', args(['一次性'], { 'repeat-basis': 'completed' }))).toThrow(
      CliError,
    );
    const f = run('filter', args(['recurring'])) as { sections: { tasks: { title: string }[] }[] };
    const titles = f.sections.flatMap((s) => s.tasks.map((r) => r.title));
    expect(titles).toContain('写周会纪要');
  });

  it('repeat:子任务设循环被拒;裸表达式解析错误可读', () => {
    run('add', args(['父任务'], {}));
    expect(() => run('add', args(['子'], { parent: '父任务', repeat: 'daily' }))).toThrow(/子任务/);
    expect(() => run('add', args(['x'], { date: '2026-08-12', repeat: 'fortnightly' }))).toThrow(
      /无法解析/,
    );
  });
});

describe('resolveDbPath 优先级', () => {
  it('CLAUDOIST_DB > --db > --prod/--dev', () => {
    process.env['CLAUDOIST_DB'] = '/tmp/x.sqlite3';
    expect(resolveDbPath({ db: '/tmp/y.sqlite3' }).path).toBe('/tmp/x.sqlite3');
    delete process.env['CLAUDOIST_DB'];
    expect(resolveDbPath({ db: '/tmp/y.sqlite3' }).path).toBe('/tmp/y.sqlite3');
    expect(resolveDbPath({ prod: true }).path).toContain('Claudoist/data');
    expect(resolveDbPath({ dev: true }).path).toContain('Claudoist-dev/data');
  });
});
