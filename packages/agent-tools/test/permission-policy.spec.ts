import { describe, expect, it } from 'vitest';
import { emptySnapshot } from '@gtd/domain';
import type { Command, GtdSnapshot, GtdStore, Task } from '@gtd/domain';
import {
  classify,
  decide,
  DEFAULT_PERMISSION_MODE,
  DESTRUCTIVE_TOOL_NAMES,
  isModeAvailable,
  PERMISSION_MODES,
  qualifiedToolName,
  READ_TOOL_NAMES,
  sdkPermissionMode,
  WRITE_TOOL_NAMES,
  type PermissionModeId,
} from '../src/index';

/**
 * M9 权限矩阵。ROADMAP 要求"五种权限模式各有一条集成测试,断言其 SDK 选项组合与实际行为"。
 *
 * 这里逐格断言的理由:这张表是**唯一**决定 agent 能不能改用户数据的东西。一个格子写反
 * 的后果是"自动模式下悄悄删了任务",而它不会在任何别的测试里露头 —— 只有把 5 × 4 全写
 * 出来,才能在改动时立刻看到哪一格变了。
 */

const stubStore = (tasks: Task[] = []): GtdStore => {
  const snap: GtdSnapshot = { ...emptySnapshot(), tasks };
  return {
    snapshot: () => snap,
    apply: (_c: Command[]) => undefined,
  };
};

const t = (over: Partial<Task>): Task =>
  ({
    id: 'x',
    title: 't',
    estimatedMinutes: 15,
    energy: 'medium',
    priority: 3,
    projectId: null,
    deadline: null,
    status: 'active',
    createdAt: '2026-08-01T00:00:00',
    completedAt: null,
    deletedAt: null,
    description: '',
    scheduledDate: null,
    bucket: 'inbox',
    parentTaskId: null,
    sortOrder: 0,
    startTime: null,
    durationMinutes: null,
    externalId: null,
    externalCalendarId: null,
    pushedEventId: null,
    pushedFingerprint: null,
    timeZone: null,
    ...over,
  }) as Task;

const ask = (mode: PermissionModeId, tool: string, store = stubStore(), input = {}): string =>
  decide({
    mode,
    classification: classify(tool, input, store),
    alwaysAllow: [],
  }).decision;

describe('M9 权限矩阵:五种模式 × 四类工具', () => {
  it('plan(只读):读放行,一切写入拒绝', () => {
    expect(ask('plan', 'list_today')).toBe('allow');
    expect(ask('plan', 'create_task')).toBe('deny');
    expect(ask('plan', 'update_task')).toBe('deny');
    expect(ask('plan', 'delete_task')).toBe('deny');
  });

  it('manual(逐条确认):读放行,一切写入弹窗', () => {
    expect(ask('manual', 'list_today')).toBe('allow');
    expect(ask('manual', 'create_task')).toBe('ask');
    expect(ask('manual', 'update_task')).toBe('ask');
    expect(ask('manual', 'delete_task')).toBe('ask');
  });

  it('acceptEdits(自动改已有):改既有直通,新建与破坏性仍问', () => {
    expect(ask('acceptEdits', 'update_task')).toBe('allow');
    expect(ask('acceptEdits', 'move_task')).toBe('allow');
    expect(ask('acceptEdits', 'add_comment')).toBe('allow');
    expect(ask('acceptEdits', 'create_task')).toBe('ask');
    expect(ask('acceptEdits', 'capture')).toBe('ask');
    expect(ask('acceptEdits', 'delete_task')).toBe('ask');
  });

  it('auto(自动):写入直通,破坏性仍问', () => {
    expect(ask('auto', 'create_task')).toBe('allow');
    expect(ask('auto', 'update_task')).toBe('allow');
    expect(ask('auto', 'delete_task')).toBe('ask');
    expect(ask('auto', 'complete_project')).toBe('ask');
  });

  it('bypass(全部放行):包括删除', () => {
    expect(ask('bypass', 'delete_task')).toBe('allow');
    expect(ask('bypass', 'complete_project')).toBe('allow');
  });

  it('每个写工具在每种模式下都有明确判定(没有工具漏出分类表)', () => {
    for (const mode of PERMISSION_MODES) {
      for (const tool of WRITE_TOOL_NAMES) {
        const d = ask(mode, tool);
        expect(['allow', 'ask', 'deny']).toContain(d);
        // 只读模式下写工具**永远**不放行
        if (mode === 'plan') expect(d).toBe('deny');
      }
      for (const tool of READ_TOOL_NAMES) {
        expect(ask(mode, tool)).toBe('allow');
      }
    }
  });
});

describe('M9 破坏性判定', () => {
  it('静态破坏性集合 = 删除任务 + 完成项目', () => {
    expect([...DESTRUCTIVE_TOOL_NAMES].sort()).toEqual(['complete_project', 'delete_task']);
  });

  it('complete_task 无活跃子任务时只是普通修改', () => {
    const store = stubStore([t({ id: 'a' })]);
    expect(classify('complete_task', { taskId: 'a' }, store).toolClass).toBe('edit');
    expect(ask('auto', 'complete_task', store, { taskId: 'a' })).toBe('allow');
  });

  it('complete_task 有活跃子任务时升级为破坏性 —— 自动模式也要问', () => {
    const store = stubStore([
      t({ id: 'a' }),
      t({ id: 'b', parentTaskId: 'a' }),
      t({ id: 'c', parentTaskId: 'a' }),
      // done 的后代不会被级联,不该计入
      t({ id: 'd', parentTaskId: 'a', status: 'done' }),
    ]);
    const c = classify('complete_task', { taskId: 'a' }, store);
    expect(c.toolClass).toBe('destructive');
    expect(c.escalation).toContain('2');
    expect(ask('auto', 'complete_task', store, { taskId: 'a' })).toBe('ask');
    expect(ask('acceptEdits', 'complete_task', store, { taskId: 'a' })).toBe('ask');
  });

  it('全限定名与短名等价 —— 判定不因调用方写法而变', () => {
    expect(classify(qualifiedToolName('delete_task'), {}, stubStore()).toolClass).toBe(
      'destructive',
    );
  });

  it('未知工具(内置 Skill/Read)按只读处理', () => {
    expect(classify('Skill', {}, stubStore()).toolClass).toBe('read');
    expect(ask('plan', 'Skill')).toBe('allow');
  });
});

describe('M9 始终允许', () => {
  const withAlways = (mode: PermissionModeId, tool: string, always: string[]): string =>
    decide({ mode, classification: classify(tool, {}, stubStore()), alwaysAllow: always }).decision;

  it('把 ask 变成 allow', () => {
    expect(withAlways('manual', 'create_task', ['create_task'])).toBe('allow');
  });

  it('对破坏性同样生效(用户的显式选择优先于默认谨慎)', () => {
    expect(withAlways('auto', 'delete_task', ['delete_task'])).toBe('allow');
  });

  it('**不能捅穿只读模式** —— 选了只读就是只读', () => {
    expect(withAlways('plan', 'create_task', ['create_task'])).toBe('deny');
    expect(withAlways('plan', 'delete_task', ['delete_task'])).toBe('deny');
  });
});

describe('M9 SDK 选项组合', () => {
  it('只有 plan 交给 SDK 的 plan 模式;其余一律 default(放行在 canUseTool)', () => {
    expect(sdkPermissionMode('plan')).toBe('plan');
    for (const m of PERMISSION_MODES.filter((x) => x !== 'plan')) {
      expect(sdkPermissionMode(m)).toBe('default');
    }
  });

  it('打包版禁用 bypass;其余模式不受影响', () => {
    expect(isModeAvailable('bypass', true)).toBe(false);
    expect(isModeAvailable('bypass', false)).toBe(true);
    for (const m of PERMISSION_MODES.filter((x) => x !== 'bypass')) {
      expect(isModeAvailable(m, true)).toBe(true);
    }
  });

  it('默认模式是逐条确认 —— 新用户不该一上来就自动写', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('manual');
  });
});
