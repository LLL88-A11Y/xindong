// 给需要现场检索的知识条目算向量，写到 agents/chat/_vectors.ts。没改过的条目沿用旧向量。
// 改完知识库后运行：node scripts/build-knowledge.mjs && node scripts/build-vectors.mjs
// 只检查是否过期：node scripts/build-vectors.mjs --check
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

const OUT = 'agents/chat/_vectors.ts';
const header = '// 由 scripts/build-vectors.mjs 生成，不要手改\nexport const VECTORS: Record<string, { hash: string; vector: number[] }> = ';
if (!existsSync(OUT)) writeFileSync(OUT, `${header}{};\n`);

const { outputFiles } = buildSync({
  stdin: { contents: "export * from './agents/chat/_retrieve'; export { KNOWLEDGE } from './agents/chat/_knowledge'; export { VECTORS } from './agents/chat/_vectors';", resolveDir: '.', loader: 'ts' },
  bundle: true, format: 'esm', write: false,
});
const { KNOWLEDGE, VECTORS, VECTOR_KINDS, vectorText, hashText } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

const entries = KNOWLEDGE.filter((e) => VECTOR_KINDS.includes(e.kind));
const stale = entries.filter((e) => VECTORS[e.id]?.hash !== hashText(vectorText(e)));
const removed = Object.keys(VECTORS).filter((id) => !entries.some((e) => e.id === id));

if (process.argv.includes('--check')) {
  if (stale.length || removed.length) {
    console.error(`向量过期：${[...stale.map((e) => e.id), ...removed].join('、')}，请运行 node scripts/build-vectors.mjs`);
    process.exit(1);
  }
  console.log(`向量是最新的：${entries.length} 条`);
  process.exit(0);
}

const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => l.startsWith('LLM_')).map((l) => {
  const i = l.indexOf('=');
  return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
}));

const next = {};
for (const e of entries) if (!stale.includes(e)) next[e.id] = VECTORS[e.id];
let tokens = 0;
for (let i = 0; i < stale.length; i += 32) {
  const batch = stale.slice(i, i + 32);
  const resp = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
    body: JSON.stringify({ model: 'embedding-3', input: batch.map(vectorText), dimensions: 512 }),
  });
  if (!resp.ok) throw new Error(`embedding HTTP ${resp.status}`);
  const json = await resp.json();
  tokens += json.usage?.total_tokens ?? 0;
  batch.forEach((e, j) => { next[e.id] = { hash: hashText(vectorText(e)), vector: json.data[j].embedding.map((x) => Number(x.toFixed(5))) }; });
}
const ordered = Object.fromEntries(entries.map((e) => [e.id, next[e.id]]));
writeFileSync(OUT, `${header}${JSON.stringify(ordered)};\n`);
console.log(`生成 ${OUT}：共 ${entries.length} 条，本次新算 ${stale.length} 条，${tokens} token`);
