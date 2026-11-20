import { KNOWLEDGE, type KnowledgeEntry } from './_knowledge';
import { VECTORS } from './_vectors';

// 知识检索：关键词（最长词优先）+ 向量，两边的排名融合。向量接口失败时只用关键词

export interface Hit { entry: KnowledgeEntry; score: number; matched: boolean } // matched：命中了关键词，不只是字面有重合
export type Embedder = (text: string) => Promise<{ vector: number[]; tokens: number }>;
export interface Found { entries: KnowledgeEntry[]; urgent: boolean; vector: boolean; tokens: number }

// 只有这个类别需要现场检索，分析员用的两类全量放在提示词里
export const VECTOR_KINDS = ['非暴力沟通'];
// 命中就排在最前面，不参与打分
const URGENT_IDS = new Set(['N23']);

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

export const vectorText = (e: KnowledgeEntry) => `${e.title}：${definition(e)} 常见说法：${[...e.aliases, ...e.keywords].join('、')}`;

// 向量是提前算好的；条目改过后哈希对不上，这条就不参与向量排名
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

const docs = KNOWLEDGE.map((entry) => ({
  entry,
  names: [entry.title, ...entry.aliases].map(clean).filter(Boolean),
  keywords: entry.keywords.map(clean).filter(Boolean),
  grams: bigrams([entry.title, ...entry.aliases, ...entry.keywords, definition(entry)].join(' ')),
}));
const byId = new Map(KNOWLEDGE.map((e) => [e.id, e]));

// 越少条目包含的两字组合越有区分度
const docFreq = new Map<string, number>();
for (const d of docs) for (const g of d.grams) docFreq.set(g, (docFreq.get(g) ?? 0) + 1);
const idf = (g: string) => Math.log(1 + docs.length / (docFreq.get(g) ?? 1));

const vocabularies = new Map<string, string[]>();
function vocabulary(kind: string): string[] {
  let words = vocabularies.get(kind);
  if (!words) {
    words = [...new Set(docs.filter((d) => d.entry.kind === kind).flatMap((d) => [...d.names, ...d.keywords]))].sort((a, b) => b.length - a.length);
    vocabularies.set(kind, words);
  }
  return words;
}

// 最长词优先：一段文字被长词占了，就不再算里面的短词（"威胁我"不会同时算成"威胁"）
function matchedWords(query: string, kind: string): Set<string> {
  const taken = new Array<boolean>(query.length).fill(false);
  const found = new Set<string>();
  for (const word of vocabulary(kind)) {
    for (let i = query.indexOf(word); i >= 0; i = query.indexOf(word, i + 1)) {
      if (taken.slice(i, i + word.length).some(Boolean)) continue;
      taken.fill(true, i, i + word.length);
      found.add(word);
    }
  }
  return found;
}

// 单字词（怕、累、酸）容易撞上不相干的话，权重压低
const wordScore = (found: Set<string>, words: string[], weight: number) =>
  words.reduce((sum, w) => (found.has(w) ? sum + (w.length >= 2 ? weight : weight / 6) : sum), 0);

export function retrieve(text: string, kind: string, k: number): Hit[] {
  const found = matchedWords(clean(text), kind);
  const queryGrams = [...bigrams(text)];
  const total = queryGrams.reduce((sum, g) => sum + idf(g), 0) || 1;
  return docs
    .filter((d) => d.entry.kind === kind)
    .map((d) => {
      const overlap = queryGrams.reduce((sum, g) => (d.grams.has(g) ? sum + idf(g) : sum), 0) / total;
      const words = wordScore(found, d.names, 3) + wordScore(found, d.keywords, 2);
      return { entry: d.entry, score: words + overlap * 3, matched: words > 0 };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// 参与融合的关键词排名只留真正命中词的条目：字面重合的排名几乎是噪音，会把向量找对的结果挤下去
export const wordRank = (text: string, kind: string) => retrieve(text, kind, 99).filter((h) => h.matched).map((h) => h.entry.id);

export function urgentEntries(text: string, kind: string): KnowledgeEntry[] {
  const found = matchedWords(clean(text), kind);
  return docs.filter((d) => d.entry.kind === kind && URGENT_IDS.has(d.entry.id) && [...d.names, ...d.keywords].some((w) => found.has(w))).map((d) => d.entry);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na * nb) || 1);
}

// 多路排名按倒数排名融合，不用调各路分数的比例
export function fuse(ranks: string[][]): string[] {
  const score = new Map<string, number>();
  for (const rank of ranks) rank.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + i)));
  return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

function vectorRank(vector: number[], kind: string): string[] {
  return docs
    .filter((d) => d.entry.kind === kind && VECTORS[d.entry.id]?.hash === hashText(vectorText(d.entry)))
    .map((d) => ({ id: d.entry.id, score: cosine(vector, VECTORS[d.entry.id].vector) }))
    .sort((a, b) => b.score - a.score)
    .map((d) => d.id);
}

// query 用来排序；fullText 是用户的完整消息，只用来查紧急条目（对方说的威胁也要算）
export async function searchKnowledge(query: string, fullText: string, kind: string, k: number, embed?: Embedder): Promise<Found> {
  const urgent = urgentEntries(fullText, kind);
  let ids = retrieve(query, kind, 99).map((h) => h.entry.id);
  let vector = false;
  let tokens = 0;
  if (embed) {
    try {
      const res = await embed(query.slice(0, 1000));
      tokens = res.tokens;
      const rank = vectorRank(res.vector, kind);
      if (rank.length) { ids = fuse([wordRank(query, kind), rank]); vector = true; }
    } catch { /* 向量接口失败或超时：只用关键词 */ }
  }
  // 紧急条目只由硬命中带入，不参与排序：否则普通问题也可能被向量排到"先问是否安全"
  const rest = ids.filter((id) => !URGENT_IDS.has(id)).map((id) => byId.get(id)!);
  return { entries: [...urgent, ...rest].slice(0, k), urgent: urgent.length > 0, vector, tokens };
}
