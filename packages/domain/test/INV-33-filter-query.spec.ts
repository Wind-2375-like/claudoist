import { describe, expect, it } from 'vitest';
import { parseFilterQuery, runFilterQuery, unknownNames } from '../src/rules/filterQuery';
import type { GtdSnapshot } from '../src/index';
import { project, snapshot, task } from './helpers';

const TODAY = '2026-08-11';
const ctx = { today: TODAY };

/** 覆盖各维度的 fixture。 */
function snap(): GtdSnapshot {
  return snapshot({
    projects: [project({ id: 'p1', outcome: '发布 1.0' })],
    labels: [
      { id: 'lc', name: 'computer', color: null },
      { id: 'lh', name: 'home', color: null },
    ],
    taskLabels: [
      { taskId: 'a', labelId: 'lc' },
      { taskId: 'b', labelId: 'lc' },
      { taskId: 'b', labelId: 'lh' },
      { taskId: 'c', labelId: 'lh' },
    ],
    tasks: [
      task({
        id: 'a',
        title: '写周报',
        priority: 5,
        energy: 'low',
        estimatedMinutes: 15,
        scheduledDate: TODAY,
        startTime: '09:00',
      }),
      task({
        id: 'b',
        title: '改论文',
        description: '先补 ablation 表',
        priority: 4,
        energy: 'high',
        estimatedMinutes: 90,
        projectId: 'p1',
        bucket: 'project',
        deadline: '2026-08-14',
      }),
      task({ id: 'c', title: '买牛奶', priority: 2, scheduledDate: '2026-08-09' }), // 过期计划
      task({ id: 'd', title: '学木工', bucket: 'someday' }),
      task({ id: 'e', title: '旧的周报', status: 'done', priority: 5 }),
      task({ id: 'f', title: '删掉的周报', status: 'deleted' }),
    ],
  });
}

const ids = (src: string, s: GtdSnapshot = snap()): string[] => {
  const r = runFilterQuery(s, src, ctx);
  if ('error' in r) throw new Error(`${src} → ${r.error.message}`);
  return r.sections.flatMap((x) => x.tasks.map((t) => t.id));
};

describe('INV-33 过滤器查询语言:解析与求值', () => {
  it('标签 / 项目 / 布尔与括号', () => {
    expect(ids('@computer')).toEqual(['a', 'b']);
    expect(ids('@computer & @home')).toEqual(['b']);
    expect(ids('@computer | @home')).toEqual(['a', 'b', 'c']);
    expect(ids('@computer & !@home')).toEqual(['a']);
    expect(ids('(@computer | @home) & p>=4')).toEqual(['a', 'b']);
    expect(ids('#"发布 1.0"')).toEqual(['b']);
  });

  it('优先级:p5 = 最高(INV-01),支持比较', () => {
    expect(ids('p5')).toEqual(['a']); // e 是 done,默认作用域只看 active
    expect(ids('p>=4')).toEqual(['a', 'b']);
    expect(ids('p<=2')).toEqual(['c']); // d 是默认 p3
  });

  it('裸日期关键字作用于**计划日**;截止日只经 deadline: 访问', () => {
    expect(ids('today')).toEqual(['a']);
    expect(ids('overdue')).toEqual(['c']);
    expect(ids('no date')).toEqual(['b', 'd']);
    expect(ids('deadline: 2026-08-14')).toEqual(['b']);
    expect(ids('deadline before: +7 days')).toEqual(['b']);
    expect(ids('no deadline')).toEqual(['a', 'c', 'd']);
    // GTD 检视最有价值的一条:一周内到期、却还没决定哪天做
    expect(ids('deadline before: +7 days & no date')).toEqual(['b']);
  });

  it('next N days 含今天、不含过期', () => {
    expect(ids('next 7 days')).toEqual(['a']);
    expect(ids('7 days')).toEqual(['a']);
  });

  it('energy / est 是"容量"语义(≤),与 engage 同向(INV-02)', () => {
    expect(ids('energy: low')).toEqual(['a']); // c/d 是默认 medium,不 ≤ low
    expect(ids('energy: high')).toEqual(['a', 'b', 'c', 'd']);
    expect(ids('est: 15')).toEqual(['a', 'c', 'd']);
    expect(ids('est>60')).toEqual(['b']);
  });

  it('容器 / 状态:默认只看 active,没提 deleted 就永不返回软删', () => {
    expect(ids('someday')).toEqual(['d']);
    expect(ids('bucket: project')).toEqual(['b']);
    expect(ids('done')).toEqual(['e']);
    expect(ids('search: 周报')).toEqual(['a']); // 默认作用域排除 done 的 e 与 deleted 的 f
    expect(ids('search: 周报 & status: any')).toEqual(['a', 'e', 'f']);
    expect(ids('search: 周报 & done')).toEqual(['e']);
    // 关键:提了状态但没提 deleted → 仍排除软删
    expect(ids('search: 周报 & status: active,done')).toEqual(['a', 'e']);
  });

  it('search 命中标题或描述;title:/desc: 可限定', () => {
    expect(ids('search: ablation')).toEqual(['b']);
    expect(ids('title: ablation')).toEqual([]);
    expect(ids('desc: ablation')).toEqual(['b']);
  });

  it('标志位:no labels / no project / no time / subtask / mirrored', () => {
    expect(ids('no labels')).toEqual(['d']);
    expect(ids('no project')).toEqual(['a', 'c', 'd']);
    expect(ids('no time')).toEqual(['b', 'c', 'd']);
    expect(ids('!no time')).toEqual(['a']);
  });

  it('顶层逗号 = 多段并列,不是"或";每段保留原文', () => {
    const r = runFilterQuery(snap(), 'today, overdue', ctx);
    if ('error' in r) throw new Error(r.error.message);
    expect(r.sections.map((s) => s.source)).toEqual(['today', 'overdue']);
    expect(r.sections.map((s) => s.tasks.map((t) => t.id))).toEqual([['a'], ['c']]);
  });

  it('未知标签 = 空结果(不是错误),并可被查出来提示', () => {
    expect(ids('@nope')).toEqual([]);
    const parsed = parseFilterQuery('@nope & #"不存在的项目"');
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(unknownNames(snap(), parsed.ast)).toEqual({
      labels: ['nope'],
      projects: ['不存在的项目'],
    });
  });

  it('语法错误带位置与可操作的提示', () => {
    const bad = (src: string): string => {
      const r = parseFilterQuery(src);
      if (r.ok) throw new Error(`应当解析失败: ${src}`);
      return r.error.message;
    };
    expect(bad('')).toContain('不能为空');
    expect(bad('p5 &')).toBeTruthy();
    expect(bad('(p5')).toContain('括号没有闭合');
    expect(bad('(today, tomorrow)')).toContain('括号内不能出现逗号');
    expect(bad('search: "报销')).toContain('引号没有闭合');
    expect(bad('todayy')).toContain('search: todayy'); // 提示写成文本搜索
    expect(bad('energy: extreme')).toContain('low / medium / high');
    expect(bad('due before: 2026-1-5')).toContain('日期写法无效');
    expect(bad('bucket: trash')).toContain('inbox / project / someday / reference');

    const r = parseFilterQuery('@computer & todayy');
    if (r.ok) throw new Error('应当失败');
    expect('@computer & todayy'.slice(r.error.span.start, r.error.span.end)).toBe('todayy');
  });
});
