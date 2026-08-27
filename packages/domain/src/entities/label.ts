import type { Id } from './common';

/** 自由多值标签,叠加在必填 context 之上;不参与不变量计算(INVARIANTS §2.9)。 */
export interface Label {
  id: Id;
  name: string;
  color: string | null;
}

export interface TaskLabel {
  taskId: Id;
  labelId: Id;
}
