#!/usr/bin/env node
/**
 * M2 验收工具:核对 docs/INVARIANTS.md 的每条 INV-xx 与 BUG-xx 在
 * packages/domain/test/ 中有对应覆盖(文件名或 describe 标题提及)。
 * 退出码非零 = 有遗漏。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const invariantsPath = join(repoRoot, 'docs', 'INVARIANTS.md');
const testDir = join(here, '..', 'test');

const invDoc = readFileSync(invariantsPath, 'utf8');
const wanted = new Set();
for (const m of invDoc.matchAll(/^#### (INV-\d{2})/gm)) wanted.add(m[1]);
for (const m of invDoc.matchAll(/^### (BUG-\d{2})/gm)) wanted.add(m[1]);

const specs = readdirSync(testDir).filter((f) => f.endsWith('.spec.ts'));
const corpus = specs.map((f) => `${f}\n${readFileSync(join(testDir, f), 'utf8')}`).join('\n');

const missing = [...wanted].filter((id) => !corpus.includes(id)).sort();
const covered = wanted.size - missing.length;
console.log(`INV/BUG 覆盖:${covered}/${wanted.size}(spec 文件 ${specs.length} 个)`);
if (missing.length > 0) {
  console.error(`缺失覆盖:${missing.join(', ')}`);
  process.exit(1);
}
console.log('全部覆盖 ✓');
