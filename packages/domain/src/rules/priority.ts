/** INV-01 ⚠SP:1 = 最低,5 = 最高;任何地方不重编号,展示用文字(D-14)。 */

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

/** 越界/非法输入回退默认 3(INVARIANTS §2.3)。 */
export function normalizePriority(input: unknown): number {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isInteger(n) || n < PRIORITY_MIN || n > PRIORITY_MAX) return PRIORITY_DEFAULT;
  return n;
}

export function priorityLabel(p: number): string {
  return PRIORITY_LABELS[p] ?? PRIORITY_LABELS[PRIORITY_DEFAULT]!;
}
