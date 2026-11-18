// 把 knowledge/*.md 转成 agents/chat/_knowledge.ts，顺带检查格式。有任何错误就不生成。
// 改完知识库后运行：node scripts/build-knowledge.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = 'agents/chat/_knowledge.ts';
const FILES = { 思维陷阱: 'T', 情绪: 'E', 非暴力沟通: 'N', 帮助他人: 'H' };
const errors = [];
const list = (s) => (s ?? '').split('、').map((x) => x.trim()).filter(Boolean);

function parseEntry(chunk, kind, prefix) {
  const [heading, ...lines] = chunk.split('\n');
  const m = heading.trim().match(/^([A-Z])(\d{2,3}) (\S+)$/);
  if (!m) { errors.push(`${kind}：标题格式不对："## ${heading}"`); return null; }
  const id = m[1] + m[2];
  const where = `${kind} ${id}`;
  if (m[1] !== prefix) errors.push(`${where}：这个文件的编号应以 ${prefix} 开头`);

  const fields = {};
  const body = [];
  for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
    const f = !body.length && line.match(/^- ([^：]+)：(.*)$/);
    if (f) fields[f[1]] = f[2].trim();
    else body.push(line);
  }

  const keywords = list(fields['关键词']);
  if (!keywords.length) errors.push(`${where}：缺关键词`);
  const source = fields['出处'] ?? '';
  if (!source) errors.push(`${where}：缺出处`);
  // 没审过的条目（待核）不能进知识库
  const check = (fields['核对'] ?? '').match(/^(\d{4}-\d{2}-\d{2}) (通过|部分|待补)/);
  if (!check) errors.push(`${where}：核对一栏要写成"日期 通过/部分/待补"，现在是"${fields['核对'] ?? ''}"`);
  else if ((check[2] === '待补') !== source.startsWith('待补')) errors.push(`${where}：核对和出处对不上，只有出处待补时核对才能写待补`);
  if (!body.length) errors.push(`${where}：缺正文`);
  if (!body.some((l) => l.startsWith('不要误判：'))) errors.push(`${where}：正文缺"不要误判"`);

  const aliases = list(fields['近义']);
  if (prefix === 'E') {
    if (!aliases.length) errors.push(`${where}：缺近义`);
    for (const label of ['可能在意：', '回应：']) if (!body.some((l) => l.startsWith(label))) errors.push(`${where}：正文缺"${label.slice(0, -1)}"`);
  }
  return { id, kind, title: m[3], aliases, keywords, source, status: check?.[2] ?? '', checked: check?.[1] ?? '', body: body.join('\n') };
}

const entries = [];
for (const [kind, prefix] of Object.entries(FILES)) {
  const path = `knowledge/${kind}.md`;
  if (!existsSync(path)) continue; // 还没写的类别先跳过
  for (const chunk of readFileSync(path, 'utf8').replace(/\r/g, '').split(/^## /m).slice(1)) {
    const entry = parseEntry(chunk, kind, prefix);
    if (entry) entries.push(entry);
  }
}

function noDuplicates(values, label) {
  const seen = new Map();
  for (const [value, owner] of values) {
    if (seen.has(value)) errors.push(`${label}"${value}"重复：${seen.get(value)} 和 ${owner}`);
    else seen.set(value, owner);
  }
}
noDuplicates(entries.map((e) => [e.id, e.title]), '编号');
// 情绪名要能唯一归到一条：标题和近义放在一起不能重复
noDuplicates(entries.filter((e) => e.kind === '情绪').flatMap((e) => [e.title, ...e.aliases].map((w) => [w, e.id])), '情绪词');

// 思维陷阱的标题必须和分析员提示词里的类型一一对应，否则卡片引用不到条目
const prompts = readFileSync('agents/chat/_prompts.ts', 'utf8');
const types = list(prompts.match(/类型从这里选：([^。]+)。/)?.[1]);
if (!types.length) errors.push('提示词里找不到"类型从这里选"');
const titles = entries.filter((e) => e.kind === '思维陷阱').map((e) => e.title);
for (const t of types) if (!titles.includes(t)) errors.push(`提示词里的类型"${t}"在知识库里没有条目`);
for (const t of titles) if (!types.includes(t)) errors.push(`知识库的"${t}"不在提示词的类型里`);

if (errors.length) {
  console.error(`知识库有 ${errors.length} 个问题，没有生成 ${OUT}：\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

writeFileSync(OUT, `// 由 scripts/build-knowledge.mjs 从 knowledge/*.md 生成，不要手改
export interface KnowledgeEntry {
  id: string;
  kind: string;
  title: string;
  aliases: string[];
  keywords: string[];
  source: string;
  status: string; // 通过 / 部分 / 待补，待补的条目对外不报出处
  checked: string;
  body: string;
}

export const KNOWLEDGE: KnowledgeEntry[] = ${JSON.stringify(entries, null, 2)};
`);
const count = (k) => entries.filter((e) => e.kind === k).length;
console.log(`生成 ${OUT}：共 ${entries.length} 条（${Object.keys(FILES).filter(count).map((k) => `${k} ${count(k)}`).join('，')}）`);
