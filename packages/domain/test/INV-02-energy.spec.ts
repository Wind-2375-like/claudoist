import { describe, expect, it } from 'vitest';
import { energyAllows } from '../src/index';

describe('INV-02 energy 过滤方向:任务 energy ≤ 用户 energy', () => {
  it('用户 medium:low/medium 入选,high 排除', () => {
    expect(energyAllows('low', 'medium')).toBe(true);
    expect(energyAllows('medium', 'medium')).toBe(true);
    expect(energyAllows('high', 'medium')).toBe(false);
  });

  it('用户 high:三档全入选', () => {
    expect(energyAllows('low', 'high')).toBe(true);
    expect(energyAllows('medium', 'high')).toBe(true);
    expect(energyAllows('high', 'high')).toBe(true);
  });

  it('未知 energy 按 medium 参与比较', () => {
    expect(energyAllows('unknown', 'medium')).toBe(true);
    expect(energyAllows('unknown', 'low')).toBe(false);
  });
});
