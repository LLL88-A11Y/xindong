// 检索召回率
//   node evals/retrieval.mjs            关键词检索，纯本地，不调模型
//   node evals/retrieval.mjs --vector   再比较向量检索和混合检索（调智谱 embedding-3，用 .env 里的 LLM_*）
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

const { outputFiles } = buildSync({
  stdin: { contents: "export * from './agents/chat/_retrieve'; export { KNOWLEDGE } from './agents/chat/_knowledge';", resolveDir: '.', loader: 'ts' },
  bundle: true, format: 'esm', write: false,
});
const { retrieve, definition, KNOWLEDGE } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

const { cases } = JSON.parse(readFileSync('evals/retrieval.json', 'utf8'));
const CUTOFFS = { 情绪: [1, 3, 5, 8], 思维陷阱: [1, 2, 3] };
const STYLES = ['直白', '隐晦'];
const keywordRank = (c) => retrieve(c.q, c.kind, 99).map((h) => h.entry.id);
const methods = { 关键词: keywordRank };

const latencies = [];
if (process.argv.includes('--vector')) {
  const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => l.startsWith('LLM_')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
  }));
  let tokens = 0;
  async function embed(input) {
    const resp = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({ model: 'embedding-3', input, dimensions: 512 }),
    });
    if (!resp.ok) throw new Error(`embedding HTTP ${resp.status}`);
    const json = await resp.json();
    tokens += json.usage?.total_tokens ?? 0;
    return json.data.map((d) => d.embedding);
  }
  const cosine = (a, b) => {
    let dot = 0, na = 0, nb = 0;
    a.forEach((x, i) => { dot += x * b[i]; na += x * x; nb += b[i] * b[i]; });
    return dot / Math.sqrt(na * nb);
  };

  const docs = [];
  for (let i = 0; i < KNOWLEDGE.length; i += 32) {
    const batch = KNOWLEDGE.slice(i, i + 32);
    const vectors = await embed(batch.map((e) => `${e.title}（${e.aliases.join('、')}）：${definition(e)}`));
    batch.forEach((entry, j) => docs.push({ entry, vector: vectors[j] }));
  }
  const docTokens = tokens;

  // 一条一条发，顺便量出线上每轮要多等多久
  const queryVectors = new Map();
  for (const c of cases) {
    const started = performance.now();
    queryVectors.set(c, (await embed([c.q]))[0]);
    latencies.push(performance.now() - started);
  }
  const vectorRank = (c) => docs.filter((d) => d.entry.kind === c.kind)
    .map((d) => ({ id: d.entry.id, score: cosine(queryVectors.get(c), d.vector) }))
    .sort((a, b) => b.score - a.score)
    .map((d) => d.id);
  // 混合：两种排名按倒数排名融合，不用调两边分数的比例
  const hybridRank = (c) => {
    const score = new Map();
    for (const rank of [keywordRank(c), vectorRank(c)]) rank.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + i)));
    return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  };
  methods.向量 = vectorRank;
  methods.混合 = hybridRank;
  console.log(`向量化：知识库 ${KNOWLEDGE.length} 条共 ${docTokens} token；测试句 ${cases.length} 条共 ${tokens - docTokens} token`);
}

const hitAt = (rank, c, k) => rank(c).slice(0, k).some((id) => c.expect.includes(id));
const title = (id) => KNOWLEDGE.find((e) => e.id === id)?.title;

for (const [kind, cutoffs] of Object.entries(CUTOFFS)) {
  console.log(`\n## ${kind}\n\n| 方法 | 说法 | ${cutoffs.map((k) => `前 ${k}`).join(' | ')} |\n|---|---|${cutoffs.map(() => '---').join('|')}|`);
  for (const [name, rank] of Object.entries(methods)) {
    for (const style of STYLES) {
      const group = cases.filter((c) => c.kind === kind && c.style === style);
      console.log(`| ${name} | ${style} | ${cutoffs.map((k) => `${group.filter((c) => hitAt(rank, c, k)).length}/${group.length}`).join(' | ')} |`);
    }
  }
  const k = kind === '情绪' ? 5 : 3;
  const [name, rank] = Object.entries(methods).at(-1);
  const misses = cases.filter((c) => c.kind === kind && !hitAt(rank, c, k));
  if (misses.length) console.log(`\n${name}检索前 ${k} 没找到：`);
  for (const c of misses) console.log(`- [${c.style}] ${c.q}（应为 ${c.expect.map(title).join('/')}，实际 ${rank(c).slice(0, 3).map(title).join('、')}）`);
}

const started = performance.now();
for (const c of cases) retrieve(c.q, c.kind, 8);
console.log(`\n关键词检索平均 ${((performance.now() - started) / cases.length).toFixed(2)} ms`);
if (latencies.length) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const at = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
  console.log(`向量化一句话的接口耗时：p50 ${at(0.5)} ms，p95 ${at(0.95)} ms`);
}
