// 检索测试
//   node evals/retrieval.mjs            关键词召回率 + 安全硬命中 + 向量失败兜底，纯本地，不调模型
//   node evals/retrieval.mjs --vector   再比较向量和混合检索（调智谱 embedding-3，用 .env 里的 LLM_*）
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

const { outputFiles } = buildSync({
  stdin: { contents: "export * from './agents/chat/_retrieve'; export { KNOWLEDGE } from './agents/chat/_knowledge';", resolveDir: '.', loader: 'ts' },
  bundle: true, format: 'esm', write: false,
});
const { retrieve, wordRank, urgentEntries, searchKnowledge, vectorText, cosine, fuse, KNOWLEDGE } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

const { cases, urgent } = JSON.parse(readFileSync('evals/retrieval.json', 'utf8'));
const CUTOFFS = { 情绪: [1, 3, 5, 8], 思维陷阱: [1, 2, 3], 非暴力沟通: [1, 3, 4, 6] };
const MISS_AT = { 情绪: 5, 思维陷阱: 3, 非暴力沟通: 4 };
const STYLES = ['直白', '隐晦'];
const withEmotions = (c) => [c.q, ...(c.emotions ?? [])].join(' ');
const keywordRank = (text, kind) => retrieve(text, kind, 99).map((h) => h.entry.id);
const methods = { 关键词: (c) => keywordRank(c.q, c.kind) };

const latencies = [];
if (process.argv.includes('--vector')) {
  const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => l.startsWith('LLM_')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
  }));
  async function embed(input) {
    const resp = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({ model: 'embedding-3', input, dimensions: 512 }),
    });
    if (!resp.ok) throw new Error(`embedding HTTP ${resp.status}`);
    return (await resp.json()).data.map((d) => d.embedding);
  }

  const docs = [];
  for (let i = 0; i < KNOWLEDGE.length; i += 32) {
    const batch = KNOWLEDGE.slice(i, i + 32);
    const vectors = await embed(batch.map(vectorText));
    batch.forEach((entry, j) => docs.push({ entry, vector: vectors[j] }));
  }
  const queryVectors = new Map();
  for (const text of new Set(cases.flatMap((c) => [c.q, withEmotions(c)]))) {
    const started = performance.now();
    queryVectors.set(text, (await embed([text]))[0]);
    latencies.push(performance.now() - started);
  }
  const vectorRank = (text, kind) => docs.filter((d) => d.entry.kind === kind)
    .map((d) => ({ id: d.entry.id, score: cosine(queryVectors.get(text), d.vector) }))
    .sort((a, b) => b.score - a.score)
    .map((d) => d.id);
  const hybrid = (text, kind) => fuse([wordRank(text, kind), vectorRank(text, kind)]);
  methods.向量 = (c) => vectorRank(c.q, c.kind);
  methods.混合 = (c) => hybrid(c.q, c.kind);
  methods['混合 + 情绪词'] = (c) => hybrid(withEmotions(c), c.kind);
}

const hitAt = (rank, c, k) => rank(c).slice(0, k).some((id) => c.expect.includes(id));
const title = (id) => KNOWLEDGE.find((e) => e.id === id)?.title;

for (const [kind, cutoffs] of Object.entries(CUTOFFS)) {
  console.log(`\n## ${kind}\n\n| 方法 | 说法 | ${cutoffs.map((k) => `前 ${k}`).join(' | ')} |\n|---|---|${cutoffs.map(() => '---').join('|')}|`);
  for (const [name, rank] of Object.entries(methods)) {
    if (name === '混合 + 情绪词' && kind !== '非暴力沟通') continue;
    for (const style of STYLES) {
      const group = cases.filter((c) => c.kind === kind && c.style === style);
      console.log(`| ${name} | ${style} | ${cutoffs.map((k) => `${group.filter((c) => hitAt(rank, c, k)).length}/${group.length}`).join(' | ')} |`);
    }
  }
  const name = methods.混合 ? '混合' : '关键词';
  const k = MISS_AT[kind];
  const misses = cases.filter((c) => c.kind === kind && !hitAt(methods[name], c, k));
  if (misses.length) console.log(`\n${name}检索前 ${k} 没找到：`);
  for (const c of misses) console.log(`- [${c.style}] ${c.q}（应为 ${c.expect.map(title).join('/')}，实际 ${methods[name](c).slice(0, 3).map(title).join('、')}）`);
}

// 这两项是硬性要求，不过就退出码 1
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `　${detail}`}`); };
console.log('\n## 安全硬命中和兜底\n');
for (const c of urgent) {
  const hit = urgentEntries(c.q, '非暴力沟通').some((e) => e.id === 'N23');
  const first = (await searchKnowledge(c.q, c.q, '非暴力沟通', 4)).entries[0]?.id;
  check(`${c.q} → ${c.hit ? '排第一的是 N23' : '不触发 N23'}`, c.hit ? hit && first === 'N23' : !hit, `实际第一条 ${first}`);
}
const down = await searchKnowledge('他总是不回我消息', '他总是不回我消息', '非暴力沟通', 4, async () => { throw new Error('接口挂了'); });
const ordinary = await searchKnowledge('我妈总是不敲门就进我房间', '我妈总是不敲门就进我房间', '非暴力沟通', 27, async () => ({ vector: new Array(512).fill(1), tokens: 0 }));
check('普通问题不会把 N23 排进来', !ordinary.urgent && !ordinary.entries.some((e) => e.id === 'N23'));
check('向量接口失败时用关键词继续', !down.vector && down.entries.length > 0, JSON.stringify(down));

const started = performance.now();
for (const c of cases) retrieve(c.q, c.kind, 8);
console.log(`\n关键词检索平均 ${((performance.now() - started) / cases.length).toFixed(2)} ms`);
if (latencies.length) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const at = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
  console.log(`向量化一句话的接口耗时：p50 ${at(0.5)} ms，p95 ${at(0.95)} ms`);
}
process.exit(failed ? 1 : 0);
