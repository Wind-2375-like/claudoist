#!/usr/bin/env node
/**
 * M8 门禁:断言 system prompt 里引用的每个 INV 编号在 docs/INVARIANTS.md 里
 * **存在且未被标为退役**。
 *
 * 由来:M8 开工勘察在 DESIGN §6.6 的固化不变量里查出 5 处与 INVARIANTS 的漂移,
 * 其中两条("子任务永不随父完成"、"someday 激活必回 inbox")已被 D-22 / INV-21
 * 推翻 —— 照着固化会让 agent 拒绝用户完全合法的操作。规则会继续演进,靠人读拦不住,
 * 所以把"prompt 引用的不变量必须还活着"变成一条机器断言。
 *
 * 注意它**只能**保证编号有效,保证不了措辞与规则一致 —— 那由 M10 的 coaching evals 覆盖。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const promptSrc = readFileSync(join(here, '..', 'src', 'main', 'agent', 'systemPrompt.ts'), 'utf8');
const invDoc = readFileSync(join(repoRoot, 'docs', 'INVARIANTS.md'), 'utf8');

const referenced = [...new Set([...promptSrc.matchAll(/\(?(INV-\d{2})/g)].map((m) => m[1]))].sort();
if (referenced.length === 0) {
  console.error('system prompt 里一个 INV 编号都没有 —— 固化不变量必须可追溯到 INVARIANTS.md');
  process.exit(1);
}

/** 标题形如 `#### INV-21 ...`;退役条目形如 `#### 〔退役 D-30〕INV-24 ...` */
const alive = new Set();
const retired = new Set();
for (const m of invDoc.matchAll(/^#### (〔退役[^〕]*〕)?\s*(INV-\d{2})/gm)) {
  (m[1] ? retired : alive).add(m[2]);
}

const missing = referenced.filter((id) => !alive.has(id) && !retired.has(id));
const dead = referenced.filter((id) => retired.has(id));

console.log(`system prompt 引用不变量:${referenced.join(', ')}`);
if (missing.length > 0) console.error(`✗ INVARIANTS.md 里不存在:${missing.join(', ')}`);
if (dead.length > 0) {
  console.error(`✗ 已退役却仍被 prompt 引用:${dead.join(', ')} —— 规则变了,prompt 必须跟着改`);
}
if (missing.length + dead.length > 0) process.exit(1);
console.log('全部有效 ✓');
