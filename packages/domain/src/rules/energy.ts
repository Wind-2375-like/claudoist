import type { Energy } from '../entities/common';

/** INV-02:精力序 low(1) < medium(2) < high(3);未知值按 medium 处理。 */
export const ENERGY_ORDER: Record<Energy, number> = { low: 1, medium: 2, high: 3 };

export function energyRank(e: string): number {
  return e in ENERGY_ORDER ? ENERGY_ORDER[e as Energy] : ENERGY_ORDER.medium;
}

/** INV-02 ⚠SP:过滤方向 —— 任务 energy ≤ 用户当前 energy。 */
export function energyAllows(taskEnergy: string, userEnergy: Energy): boolean {
  return energyRank(taskEnergy) <= ENERGY_ORDER[userEnergy];
}
