/**
 * INV-01 ⚠SP:**1 = 最低,5 = 最高**;任何地方不重编号,展示用文字(D-14)。
 *
 * 2026-08-11 曾按 D-29 翻转成 1 = 最高(为对齐 Todoist 的 pN),当天即按 D-31 撤回:
 * **比较会变得别扭** —— `p >= 4` 在 1=最高 下到底指"比 p4 更重要"还是"数值不小于 4",
 * 两种读法结论相反。保持 5 = 最高后,过滤器里的 `p>=4` = 高及以上,读法唯一。
 * 代价是与 Todoist 的 `p1 = 最高` 相反(⚠SP 的由来),粘贴 Todoist 过滤器时须留意。
 */

export const PRIORITY_MIN = 1;
export const PRIORITY_MAX = 5;
export const PRIORITY_DEFAULT = 3;

export const PRIORITY_LABELS: Record<number, string> = {
  5: '最高',
  4: '高',
  3: '中',
  2: '低',
  1: '最低',
};

/** 展示顺序(最高 → 最低):UI 的优先级选择器一律由此派生,不许各写一份。 */
export const PRIORITY_CHOICES: { value: number; label: string }[] = [5, 4, 3, 2, 1].map((v) => ({
  value: v,
  label: PRIORITY_LABELS[v]!,
}));

/** 越界/非法输入回退默认 3(INVARIANTS §2.3)。 */
export function normalizePriority(input: unknown): number {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isInteger(n) || n < PRIORITY_MIN || n > PRIORITY_MAX) return PRIORITY_DEFAULT;
  return n;
}

export function priorityLabel(p: number): string {
  return PRIORITY_LABELS[p] ?? PRIORITY_LABELS[PRIORITY_DEFAULT]!;
}
