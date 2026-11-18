import { KNOWLEDGE, type KnowledgeEntry } from './_knowledge';

// 知识检索：词命中 + 字面重合度打分。纯本地计算，不调模型、不联网，不拖慢分析员

export interface Hit { entry: KnowledgeEntry; score: number }

const clean = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

function bigrams(s: string): Set<string> {
  const t = clean(s);
  const out = new Set<string>();
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

// 正文只取定义部分：回应建议和"不要误判"里写的是别的情况，参与匹配会把不相干的话召回来
// 这段文字也会显示给用户，所以去掉 Markdown 粗体和"（E23）"这样的内部编号
export const definition = (e: KnowledgeEntry) => e.body.split('\n')
  .filter((l) => !/^(可能在意|回应|不要误判)/.test(l))
  .join('')
  .replace(/\*\*/g, '')
  .replace(/（[A-Z]\d{2,3}）/g, '');

const docs = KNOWLEDGE.map((entry) => ({
  entry,
  names: [entry.title, ...entry.aliases].map(clean),
  keywords: entry.keywords.map(clean),
  grams: bigrams([entry.title, ...entry.aliases, ...entry.keywords, definition(entry)].join(' ')),
}));

// 越少条目包含的两字组合越有区分度
const docFreq = new Map<string, number>();
for (const d of docs) for (const g of d.grams) docFreq.set(g, (docFreq.get(g) ?? 0) + 1);
const idf = (g: string) => Math.log(1 + docs.length / (docFreq.get(g) ?? 1));

// 单字词（怕、累、酸）容易撞上不相干的话，权重压低
const wordScore = (query: string, words: string[], weight: number) =>
  words.reduce((sum, w) => (w && query.includes(w) ? sum + (w.length >= 2 ? weight : weight / 6) : sum), 0);

export function retrieve(text: string, kind: string, k: number): Hit[] {
  const query = clean(text);
  const queryGrams = [...bigrams(text)];
  const total = queryGrams.reduce((sum, g) => sum + idf(g), 0) || 1;
  return docs
    .filter((d) => d.entry.kind === kind)
    .map((d) => {
      const overlap = queryGrams.reduce((sum, g) => (d.grams.has(g) ? sum + idf(g) : sum), 0) / total;
      return { entry: d.entry, score: wordScore(query, d.names, 3) + wordScore(query, d.keywords, 2) + overlap * 3 };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
