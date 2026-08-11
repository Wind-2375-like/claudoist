import { describe, expect, it } from 'vitest';
import { captureToInbox } from '../src/usecases/capture';
import { quickAddTask } from '../src/usecases/tasks';
import { createProjectDirect } from '../src/usecases/projects';
import { createFollowUp, createWaitingForDirect } from '../src/usecases/waiting';
import { moveToList } from '../src/usecases/lists';
import { createLabel } from '../src/usecases/labels';
import { createFilter } from '../src/usecases/filters';
import { isUsecaseError } from '../src/usecases/types';
import type { UsecaseResult } from '../src/usecases/types';
import { deps, snapshot, waitingFor } from './helpers';

function ok<C>(r: UsecaseResult<C>): C {
  if (isUsecaseError(r)) throw new Error(r.error);
  return r.consequences;
}

describe('INV-04 所有 usecase 创建的实体 id 均来自 deps.idGen 且互不相同', () => {
  it('跨 8 个创建型 usecase 用同一 seqIdGen:id 形态正确、无重复', () => {
    const w = waitingFor({ id: 'w1', description: '报价单', delegatedTo: '老王' });
    const snap = snapshot({ waiting: [w] });
    const d = deps(); // seqIdGen('id') → id-1, id-2, …

    const ids: string[] = [];
    ids.push(...ok(captureToInbox(snap, d, { texts: ['想法一', '想法二'] })).createdIds);
    ids.push(ok(quickAddTask(snap, d, { title: '买牛奶' })).taskId);
    ids.push(ok(createProjectDirect(snap, d, { outcome: '装修厨房' })).projectId);
    ids.push(ok(createWaitingForDirect(snap, d, { description: '等报销' })).waitingForId);
    ids.push(ok(createFollowUp(snap, d, { waitingForId: 'w1' })).followUpCreated);
    ids.push(ok(moveToList(snap, d, { text: '以后学琴', kind: 'someday' })).listItemId);
    ids.push(ok(createLabel(snap, d, { name: 'urgent' })).labelId);
    ids.push(ok(createFilter(snap, d, { name: '快事', query: 'est: 10' })).filterId);

    expect(ids).toHaveLength(9);
    // 全部来自注入的 idGen(seqIdGen 前缀),而非任何内置生成器
    for (const id of ids) expect(id).toMatch(/^id-\d+$/);
    // 互不相同
    expect(new Set(ids).size).toBe(ids.length);
  });
});
