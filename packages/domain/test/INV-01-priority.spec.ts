import { describe, expect, it } from 'vitest';
import { engageCandidates, normalizePriority, priorityLabel } from '../src/index';
import { snapshot, task, TODAY } from './helpers';

describe('INV-01 priority:1=最低 5=最高(D-29 翻转当天按 D-31 撤回),不重编号', () => {
  it('engage 排序中 p5 排在 p1 之前(数值大 = 更高)', () => {
    const snap = snapshot({
      tasks: [task({ id: 'low', priority: 1 }), task({ id: 'high', priority: 5 })],
    });
    const got = engageCandidates(snap, null, 60, 'high', TODAY).map((t) => t.id);
    expect(got).toEqual(['high', 'low']);
  });

  it('选择器文字映射:最高=5、最低=1,存储数值不翻转', () => {
    expect(priorityLabel(5)).toBe('最高');
    expect(priorityLabel(4)).toBe('高');
    expect(priorityLabel(3)).toBe('中');
    expect(priorityLabel(2)).toBe('低');
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
