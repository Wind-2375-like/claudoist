/**
 * INV-01 ⚠SP:**1 = 最高,5 = 最低**(2026-08-11 D-29 翻转,与 Todoist 的 p1–p4 同向);
 * 任何地方不重编号,展示用文字(D-14)。
 *
 * 翻转的理由是"一个应用里不允许出现两套方向相反的数字":过滤器语言要用 Todoist 的
 * `p1 = 最高`,若存储仍是 5 = 最高,则 `p1` 与 `--priority=1` 恰好相反,必然出事。
 */

export const PRIORITY_MIN = 1;
export const PRIORITY_MAX = 5;
export const PRIORITY_DEFAULT = 3;

export const PRIORITY_LABELS: Record<number, string> = {
  1: '最高',
  2: '高',
  3: '中',
  4: '低',
  5: '最低',
};

/** 展示顺序(最高 → 最低):UI 的优先级选择器一律由此派生,不许各写一份。 */
export const PRIORITY_CHOICES: { value: number; label: string }[] = [1, 2, 3, 4, 5].map((v) => ({
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
