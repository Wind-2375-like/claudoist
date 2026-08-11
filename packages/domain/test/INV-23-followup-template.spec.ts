import { describe, expect, it } from 'vitest';
import { createFollowUp } from '../src/usecases/waiting';
import { applyToSnapshot } from '../src/index';
import { deps, project, snapshot, waitingFor } from './helpers';
import { isUsecaseError } from '../src/usecases/types';

/**
 * INV-23:对未解决 WaitingFor 的催办行动按固定模板生成;
 * 创建 follow-up 不改变 resolved 状态(催办的对象正是还没回音的委派)。
 */
describe('INV-23 waiting-for follow-up 模板(createFollowUp usecase)', () => {
  it('六字段逐一匹配模板;@phone 存在时落 @phone;waiting 仍未解决', () => {
    const base = snapshot({
      projects: [project({ id: 'p1' })],
      waiting: [
        waitingFor({ id: 'w1', description: '合同初稿', delegatedTo: 'Bob', projectId: 'p1' }),
      ],
    });
    const r = createFollowUp(base, deps(), { waitingForId: 'w1' });
    expect(isUsecaseError(r)).toBe(false);
    if (isUsecaseError(r)) return;
    const after = applyToSnapshot(base, r.commands);
    const t = after.tasks.find((x) => x.id === r.consequences.followUpCreated)!;
    expect(t.title).toBe('Follow up with Bob re: 合同初稿');
    expect(t.estimatedMinutes).toBe(5);
    expect(t.energy).toBe('low');
    expect(t.priority).toBe(2); // 「高」(D-29 翻转后)
    expect(t.projectId).toBe('p1');
    expect(t.deadline).toBeNull();
    // 不改变 resolved(INV-23)
    expect(after.waiting.find((w) => w.id === 'w1')!.resolved).toBe(false);
    expect(r.commands.some((c) => c.kind === 'updateWaitingFor')).toBe(false);
  });

  it('无 @phone → 落 sortOrder 最小的 context;已 resolved → 错误', () => {
    const base = snapshot({
      waiting: [
        waitingFor({ id: 'w1', delegatedTo: 'X' }),
        waitingFor({ id: 'w2', resolved: true }),
      ],
    });
    const r = createFollowUp(base, deps(), { waitingForId: 'w1' });
    expect(isUsecaseError(r)).toBe(false);
    if (isUsecaseError(r)) return;
    expect('error' in createFollowUp(base, deps(), { waitingForId: 'w2' })).toBe(true);
  });
});
