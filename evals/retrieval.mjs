// 检索召回率：node evals/retrieval.mjs。纯本地计算，不调模型，也不访问线上
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

const { outputFiles } = buildSync({ entryPoints: ['agents/chat/_retrieve.ts'], bundle: true, format: 'esm', write: false });
const { retrieve } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

const { cases } = JSON.parse(readFileSync('evals/retrieval.json', 'utf8'));
const CUTOFFS = { 情绪: [1, 3, 5, 8], 思维陷阱: [1, 2, 3] };

const hitAt = (c, k) => retrieve(c.q, c.kind, k).some((h) => c.expect.includes(h.entry.id));

for (const [kind, cutoffs] of Object.entries(CUTOFFS)) {
  console.log(`\n## ${kind}\n\n| 分组 | 条数 | ${cutoffs.map((k) => `前 ${k}`).join(' | ')} |\n|---|---|${cutoffs.map(() => '---').join('|')}|`);
  for (const style of ['直白', '隐晦']) {
    const group = cases.filter((c) => c.kind === kind && c.style === style);
    const cells = cutoffs.map((k) => `${group.filter((c) => hitAt(c, k)).length}/${group.length}`);
    console.log(`| ${style} | ${group.length} | ${cells.join(' | ')} |`);
  }
  const k = cutoffs.at(-1);
  const misses = cases.filter((c) => c.kind === kind && !hitAt(c, k));
  if (misses.length) console.log(`\n前 ${k} 仍没找到：`);
  for (const c of misses) console.log(`- [${c.style}] ${c.q}（应为 ${c.expect.join('/')}，实际 ${retrieve(c.q, c.kind, 3).map((h) => h.entry.title).join('、') || '无'}）`);
}

const started = performance.now();
for (const c of cases) retrieve(c.q, c.kind, 8);
console.log(`\n平均每次检索 ${((performance.now() - started) / cases.length).toFixed(2)} ms`);
