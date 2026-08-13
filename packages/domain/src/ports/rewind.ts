import type { Id } from '../entities/common';
import type { Command, GtdSnapshot } from './gtdStore';
import { applyToSnapshot } from './gtdStore';

/**
 * 回滚(rewind):把 agent 对任务数据做过的改动**撤销**到某一轮之前(INV-35)。
 *
 * ## 为什么是逆命令日志,而不是快照
 *
 * 每轮存整库快照最简单,但一次 `updateTask` 只改了两个字段,存一份 180KB 的库显然荒唐。
 * 逆命令只需存**被改到的那几个键的旧值** —— 实测同样 100 轮,逆命令日志约 116KB,
 * 整库快照要几十 MB。用户明确要求 efficient。
 *
 * ## 链序引理(整套设计的地基,别改动这里的顺序假设)
 *
 * 设逆命令批按写入序 `seq` **严格降序**应用。对任意字段 `f`:
 *
 * - 走到触及 `f` 的第 k 新条目时,`f` 的当前值**恒等于**该条目记录的 `after[f]`
 *   —— 因为上一条(更新的那条)已经把它写回了自己的 before,而那个 before 正是本条的 after;
 * - 于是**外部写入(用户手改 / Google 回同步 / 另一条会话)造成的冲突,对每个字段至多被检出
 *   一次**,即在触及它的**最新**那条上;
 * - 全链走完后,`f` 的最终值 = 触及 `f` 的**最早**那条记录的 before 值。
 *
 * 三条推论直接决定了实现:
 * 1. 冲突检测**不需要**给行加 `updated_at`、也不需要记 actor —— "当前值 ≠ after" 已经天然
 *    覆盖了全部外部来源;
 * 2. "跳过某条冲突"必须**按键**传播到该键的所有更早条目 —— 按行跳会停在中间态;
 * 3. 可以只反转本会话的条目而不失正确性:别的会话的写入必然让 after 对不上 → 变成冲突 →
 *    交用户裁决,不会被静默覆盖。
 *
 * ## 为什么硬删不进 `Command` 联合
 *
 * `Command` 是**用户意图**的词汇表,而 INV-22/D-01 早就裁定"删除 = 软删"。把硬删放进联合,
 * usecase 与 agent 工具就都够得着它,那层纵深防御立刻失效。所以另立 `RewindCommand`,
 * 只有回滚执行器认得。
 */

/** 回滚专用命令 = 普通命令 + 三个硬删(**只有回滚执行器可用**) */
export type RewindCommand =
  | Command
  | { kind: 'hardDeleteTask'; id: Id }
  | { kind: 'hardDeleteProject'; id: Id }
  | { kind: 'hardDeleteWaitingFor'; id: Id };

/**
 * 与 `inverse` 逐条同下标的"apply 之后的值",用于冲突检测。
 * - `fields`:update 类,记同键的新值;
 * - `row`:create 类(逆是硬删),记行指纹;
 * - `null`:逆是 no-op(幂等的 assign / 指向不存在 id 的 update)。
 */
export type AfterEntry =
  { t: 'fields'; v: Record<string, unknown> } | { t: 'row'; hash: string } | null;

export interface RewindBatch {
  inverse: RewindCommand[];
  after: AfterEntry[];
}

/** `GtdStore.apply` 的可选元数据。**不传 = 不记日志** —— Google 同步与 CLI 走这条。 */
export interface ApplyMeta {
  rewindLog?: {
    conversationId: string;
    turnId: string;
    anchorUuid: string | null;
    toolName: string;
    toolUseId: string | null;
    batch: RewindBatch;
    createdAt: string;
  };
}

/** 回滚执行口。单独一个接口,免得逼所有 GtdStore 实现都得实现它。 */
export interface RewindStore {
  applyRewind(cmds: RewindCommand[]): void;
}

// ------------------------------------------------------------------ 行指纹

/**
 * 行指纹。用 FNV-1a 的两个变体拼成 64 位 —— domain 是零依赖纯 TS,不引 node:crypto。
 *
 * 它只用于**冲突检测**:指纹变了说明行被人动过。碰撞的后果是"漏报一次冲突",
 * 而不是数据损坏;以本应用的数据量(几十到几千行)这个风险可以忽略。
 */
export function rowHash(row: unknown): string {
  const s = stableJson(row);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b + c, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** 键排序的 JSON —— 对象键序不该影响指纹。 */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

// ------------------------------------------------------------------ 求逆

type Row = Record<string, unknown>;

const find = (arr: readonly unknown[], id: Id): Row | undefined =>
  (arr as Row[]).find((x) => x['id'] === id);

/** 只取 patch 里**出现过的键**的旧值。旧值 undefined 必须落成 null(SQLite 绑不了 undefined)。 */
function oldValues(row: Row | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) out[k] = row?.[k] ?? null;
  return out;
}

const newValues = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...patch });

/**
 * 依 apply **之前**的快照算出逆命令批。
 *
 * 关键细节(每条都对应一个会出错的地方):
 * - `assignLabel` 的逆只在 before 里**不存在**该 pair 时才发出(存储层是 INSERT OR IGNORE,
 *   重复 assign 是 no-op)—— 否则回滚会把用户原本就有的标签摘掉;
 * - `unassignLabel` 对称;
 * - `deleteLabel` 的逆是 `createLabel` + 若干 `assignLabel`,且 **createLabel 必须在前**(外键);
 * - `updateReminder` 的逆**剔除 `dispatched`** —— 把它回滚成 false 会让提醒**再响一次**。
 *   回滚数据不等于回滚副作用。
 */
export function invertCommands(before: GtdSnapshot, cmds: Command[]): RewindBatch {
  const inverse: RewindCommand[] = [];
  const after: AfterEntry[] = [];
  const push = (c: RewindCommand, a: AfterEntry): void => {
    inverse.push(c);
    after.push(a);
  };

  for (const c of cmds) {
    switch (c.kind) {
      case 'createTask':
        push({ kind: 'hardDeleteTask', id: c.task.id }, { t: 'row', hash: rowHash(c.task) });
        break;
      case 'createProject':
        push(
          { kind: 'hardDeleteProject', id: c.project.id },
          { t: 'row', hash: rowHash(c.project) },
        );
        break;
      case 'createWaitingFor':
        push({ kind: 'hardDeleteWaitingFor', id: c.item.id }, { t: 'row', hash: rowHash(c.item) });
        break;
      case 'createInboxItem':
        push({ kind: 'deleteInboxItem', id: c.item.id }, { t: 'row', hash: rowHash(c.item) });
        break;
      case 'createListItem':
        push({ kind: 'deleteListItem', id: c.item.id }, { t: 'row', hash: rowHash(c.item) });
        break;
      case 'createLabel':
        push({ kind: 'deleteLabel', id: c.label.id }, { t: 'row', hash: rowHash(c.label) });
        break;
      case 'createFilter':
        push({ kind: 'deleteFilter', id: c.filter.id }, { t: 'row', hash: rowHash(c.filter) });
        break;
      case 'createReminder':
        push(
          { kind: 'deleteReminder', id: c.reminder.id },
          { t: 'row', hash: rowHash(c.reminder) },
        );
        break;
      case 'createComment':
        push({ kind: 'deleteComment', id: c.comment.id }, { t: 'row', hash: rowHash(c.comment) });
        break;

      case 'updateTask':
        push(
          { kind: 'updateTask', id: c.id, patch: oldValues(find(before.tasks, c.id), c.patch) },
          { t: 'fields', v: newValues(c.patch) },
        );
        break;
      case 'updateProject':
        push(
          {
            kind: 'updateProject',
            id: c.id,
            patch: oldValues(find(before.projects, c.id), c.patch),
          },
          { t: 'fields', v: newValues(c.patch) },
        );
        break;
      case 'updateWaitingFor':
        push(
          {
            kind: 'updateWaitingFor',
            id: c.id,
            patch: oldValues(find(before.waiting, c.id), c.patch),
          },
          { t: 'fields', v: newValues(c.patch) },
        );
        break;
      case 'updateLabel':
        push(
          { kind: 'updateLabel', id: c.id, patch: oldValues(find(before.labels, c.id), c.patch) },
          { t: 'fields', v: newValues(c.patch) },
        );
        break;
      case 'updateFilter':
        push(
          { kind: 'updateFilter', id: c.id, patch: oldValues(find(before.filters, c.id), c.patch) },
          { t: 'fields', v: newValues(c.patch) },
        );
        break;
      case 'updateReminder': {
        // ⚠ 剔除 dispatched:回滚成 false 会让提醒再响一次(回滚数据 ≠ 回滚副作用)
        const patch = { ...c.patch } as Record<string, unknown>;
        delete patch['dispatched'];
        if (Object.keys(patch).length === 0) {
          push({ kind: 'updateReminder', id: c.id, patch: {} }, null);
          break;
        }
        push(
          {
            kind: 'updateReminder',
            id: c.id,
            patch: oldValues(find(before.reminders, c.id), patch) as never,
          },
          { t: 'fields', v: newValues(patch) },
        );
        break;
      }

      case 'assignLabel': {
        // 存储层是 INSERT OR IGNORE:before 里已存在时这条 apply 是 no-op,逆也必须是 no-op,
        // 否则回滚会摘掉用户原本就有的标签
        const existed = before.taskLabels.some(
          (tl) => tl.taskId === c.taskId && tl.labelId === c.labelId,
        );
        if (existed) push({ kind: 'assignLabel', taskId: c.taskId, labelId: c.labelId }, null);
        else push({ kind: 'unassignLabel', taskId: c.taskId, labelId: c.labelId }, null);
        break;
      }
      case 'unassignLabel': {
        const existed = before.taskLabels.some(
          (tl) => tl.taskId === c.taskId && tl.labelId === c.labelId,
        );
        if (existed) push({ kind: 'assignLabel', taskId: c.taskId, labelId: c.labelId }, null);
        else push({ kind: 'unassignLabel', taskId: c.taskId, labelId: c.labelId }, null);
        break;
      }

      case 'deleteInboxItem': {
        const row = find(before.inbox, c.id);
        if (row) push({ kind: 'createInboxItem', item: row as never }, null);
        break;
      }
      case 'deleteListItem': {
        const row = find(before.listItems, c.id);
        if (row) push({ kind: 'createListItem', item: row as never }, null);
        break;
      }
      case 'deleteLabel': {
        const row = find(before.labels, c.id);
        if (row) {
          // createLabel 必须排在 assignLabel 前面(外键)
          push({ kind: 'createLabel', label: row as never }, null);
          for (const tl of before.taskLabels.filter((x) => x.labelId === c.id)) {
            push({ kind: 'assignLabel', taskId: tl.taskId, labelId: tl.labelId }, null);
          }
        }
        break;
      }
      case 'deleteFilter': {
        const row = find(before.filters, c.id);
        if (row) push({ kind: 'createFilter', filter: row as never }, null);
        break;
      }
      case 'deleteReminder': {
        const row = find(before.reminders, c.id);
        if (row) push({ kind: 'createReminder', reminder: row as never }, null);
        break;
      }
      case 'deleteComment': {
        const row = find(before.comments, c.id);
        if (row) push({ kind: 'createComment', comment: row as never }, null);
        break;
      }
    }
  }
  return { inverse, after };
}

// ------------------------------------------------------------------ 参照实现

/**
 * 参照实现:在内存快照上应用回滚命令。SQLite 侧的 `applyRewind` 与它对拍。
 * 硬删**不级联** —— 有入向引用时应当由调用方在预检里报冲突,而不是悄悄连坐。
 */
export function applyRewindToSnapshot(snap: GtdSnapshot, cmds: RewindCommand[]): GtdSnapshot {
  let next = snap;
  const plain: Command[] = [];
  const flush = (): void => {
    if (plain.length > 0) {
      next = applyToSnapshot(next, plain);
      plain.length = 0;
    }
  };
  for (const c of cmds) {
    if (c.kind === 'hardDeleteTask') {
      flush();
      next = { ...next, tasks: next.tasks.filter((t) => t.id !== c.id) };
    } else if (c.kind === 'hardDeleteProject') {
      flush();
      next = { ...next, projects: next.projects.filter((p) => p.id !== c.id) };
    } else if (c.kind === 'hardDeleteWaitingFor') {
      flush();
      next = { ...next, waiting: next.waiting.filter((w) => w.id !== c.id) };
    } else {
      plain.push(c);
    }
  }
  flush();
  return next;
}

/** 倒序应用整条链(回滚的算法本体:批与批之间倒序,批内也倒序)。 */
export function reverseChain(batches: readonly RewindBatch[]): RewindCommand[] {
  const out: RewindCommand[] = [];
  for (let i = batches.length - 1; i >= 0; i -= 1) {
    const b = batches[i]!;
    for (let j = b.inverse.length - 1; j >= 0; j -= 1) out.push(b.inverse[j]!);
  }
  return out;
}
