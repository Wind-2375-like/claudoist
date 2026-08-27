import { describe, expect, it } from 'vitest';
import { engageCandidates, normalizePriority, priorityLabel } from '../src/index';
import { ctx, snapshot, task } from './helpers';

describe('INV-01 priority:1=最低 5=最高,不重编号', () => {
  it('engage 排序中 P5 排在 P1 之前', () => {
    const c = ctx({ id: 'c1' });
    const snap = snapshot({
      contexts: [c],
      tasks: [
        task({ id: 'low', contextId: 'c1', priority: 1 }),
        task({ id: 'high', contextId: 'c1', priority: 5 }),
      ],
    });
    const got = engageCandidates(snap, 'c1', 60, 'high').map((t) => t.id);
    expect(got).toEqual(['high', 'low']);
  });

  it('选择器文字映射:最高=5、最低=1,存储数值不翻转', () => {
    expect(priorityLabel(5)).toBe('最高');
    expect(priorityLabel(1)).toBe('最低');
  });

  it('越界/非法输入回退默认 3', () => {
    expect(normalizePriority(0)).toBe(3);
    expect(normalizePriority(6)).toBe(3);
    expect(normalizePriority('x')).toBe(3);
    expect(normalizePriority(2.5)).toBe(3);
    expect(normalizePriority(4)).toBe(4);
  });
});
