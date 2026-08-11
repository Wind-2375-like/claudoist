/**
 * 优先级展示表 —— **镜像** domain 的 `PRIORITY_LABELS` / `PRIORITY_CHOICES`。
 *
 * 渲染层按 DESIGN §4.1 不得 import `@gtd/*`,所以这份必须手工与 domain 保持一致。
 * 放在 shared/ 而不是各组件里,是因为 D-29 翻转时发现 TaskCard 与 TaskDetailModal
 * **各抄了一份**:两份重复的方向常量,正是翻转最容易只改一处的地方。
 *
 * INV-01/D-29:**1 = 最高,5 = 最低**(与 Todoist 的 pN 同向);默认 3(中)。
 */
export const PRIORITY_CHOICES: { value: number; label: string }[] = [
  { value: 1, label: '最高' },
  { value: 2, label: '高' },
  { value: 3, label: '中' },
  { value: 4, label: '低' },
  { value: 5, label: '最低' },
];

export const PRIORITY_DEFAULT = 3;
