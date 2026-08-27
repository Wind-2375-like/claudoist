import { describe, it } from 'vitest';
import { storeContractScenarios } from '@gtd/domain';
import { openDb } from '../src/db';
import { SqliteGtdStore } from '../src/store';

/** domain 定义的 contract 套件对 SQLite 适配器运行(:memory:)。 */
describe('store-contract(SqliteGtdStore / :memory:)', () => {
  for (const scenario of storeContractScenarios) {
    it(scenario.name, () => {
      scenario.run(() => new SqliteGtdStore(openDb(':memory:')));
    });
  }
});
