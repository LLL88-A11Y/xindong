import { Annotation, MessagesAnnotation, StateGraph, START, END } from '@langchain/langgraph';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { AIMessage, HumanMessage, SystemMessage, type AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import type { ChatOpenAI } from '@langchain/openai';
import * as P from './_prompts';
import { KNOWLEDGE, type KnowledgeEntry } from './_knowledge';
import { definition, searchKnowledge, type Embedder } from './_retrieve';

// ---------- 类型 ----------

export interface Criterion { name: string; weight: number }
export interface Decision { question: string; options: string[]; criteria: Criterion[]; facts: string[] }
// basis：said = 依据用户说过的具体事实；guess = 按常识估计
export interface Score { option: string; criterion: string; score: number; reason: string; basis: 'said' | 'guess' }
// 用户点了「不准」的解读。只在这次对话里有效，只用来少说，从不交给模型、不用来推测任何东西
export interface Rejection { kind: 'emotion' | 'distortion'; label: string; quote: string }
// 解读依据的知识条目。source 为空表示这条没有可靠出处，不对外显示
export interface Citation { id: string; status: string; source: string; definition: string }
export interface Emotion { name: string; intensity: number; evidence: string; knowledge?: Citation }
export interface Distortion { type: string; quote: string; explain: string; reframe: string; knowledge?: Citation }

export interface Analysis {
  risk: 'none' | 'concern' | 'high';
  at_risk: 'self' | 'other' | ''; // 有危险的是谁：用户本人，还是用户转述的别人
  mode: 'decision' | 'vent' | 'relation' | 'chat';
  action: 'clarify' | 'debate' | 'followup' | 'listen' | 'offer';
  emotions: Emotion[];
  distortions: Distortion[];
  decision: Decision | null;
  missing: string;
}

// 发言角色：前端按 role 渲染头像和颜色
export type Role = 'host' | 'rational' | 'emotional' | 'tenth' | 'premortem' | 'guide';
const ROLE_LABEL: Record<Role, string> = {
  host: '心懂', rational: '理性派', emotional: '感性派', tenth: '第十人', premortem: '验尸官', guide: '心懂',
};

// ---------- 状态 ----------
// 持久化（checkpointer）的只有：对话消息、决策信息（选项/在乎的方面/事实）、打分、是否开过会。
// ⭐ 底层原则：情绪与思维陷阱的解读 *不* 跨轮保存，每一轮都从零开始，只依据用户这一次说的话。
//   它们放在 `turn` 里：每轮开头被 analyze 覆盖，每轮结束的节点把它清空为 null（不留存档），
//   也从不作为输入喂回分析员。

const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  decision: Annotation<Decision | null>({ reducer: (_a, b) => b, default: () => null }),
  scores: Annotation<Score[]>({ reducer: (_a, b) => b, default: () => [] }),
  debatedKey: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  // 上一轮问过"要现在开会吗"：用户回"好/开吧"就开
  offeredMeeting: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  turn: Annotation<Analysis | null>({ reducer: (_a, b) => b, default: () => null }),
  modeHint: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  recentCrisis: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  // 「不准」：这次对话里被用户否定的解读（新对话 = 新 thread，自然清零）
  rejected: Annotation<Rejection[]>({ reducer: mergeRejections, default: () => [] }),
  // 用户在打分表里亲手调过的权重，覆盖分析员的估计
  userWeights: Annotation<Record<string, number> | null>({ reducer: (_a, b) => b, default: () => null }),
});
type S = typeof State.State;

// ---------- 工具函数 ----------

const CRISIS_WORDS = [
  '自杀', '轻生', '不想活', '活不下去', '想死', '去死', '结束生命', '结束自己', '了结', '割腕', '跳楼', '跳河',
  '安眠药', '吃药死', '烧炭', '遗书', '没有活下去', '活着没意思', '活着没有意义', '伤害自己', '自残', '杀了他', '杀了她',
  // 隐晦的说法：换成 GLM 后分析员三次里有两次只判成 concern（评测 crisis-burden / crisis-vanish），代码兜住
  '没有我会更', '想消失', '不用醒来', '不想醒来', '不要醒来',
];

// 给用户看的错误说明：网关的英文报错换成大白话
export function friendlyError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  if (/quota|insufficient/i.test(msg)) return '心懂现在的 AI 额度用完了，暂时没法回答，抱歉。如果情况危急，请直接打 **12356**（心理援助）或 **110** / **120**。';
  if (/429|rate.?limit|too many/i.test(msg)) return '现在用的人有点多，等一会儿再试试。';
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return 'AI 回应太慢，超时了，再发一次试试。';
  return 'AI 暂时出了点问题，等一会儿再试试。';
}

function hasCrisisWord(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  return CRISIS_WORDS.some((w) => t.includes(w));
}

function textOf(m: BaseMessage): string {
  return typeof m.content === 'string' ? m.content : m.content.map((c: any) => c?.text ?? '').join('');
}

// 用户贴进来的聊天记录里，"对方："开头的行是别人说的话：不能当作用户本人情绪的依据，也不触发用户的危机关键词
function ownWords(text: string): string {
  return text.split('\n').filter((l) => !/^\s*对方\s*[：:]/.test(l)).join('\n');
}

// 图中途出错时（多半是对话存储读写失败）的危机兜底：这一轮是危机就返回要发给前端的事件，不是则返回 null。
// 不依赖存储和模型。insight 是这一轮已经发出的分析结果，还没发出时为 null
export function crisisFallback(message: string, insight: Record<string, unknown> | null): Record<string, unknown>[] | null {
  if (insight?.risk !== 'high' && !hasCrisisWord(ownWords(message))) return null;
  const atRisk = insight?.at_risk === 'other' ? 'other' : 'self';
  return [
    ...(insight ? [] : [{ type: 'insight', unavailable: true, risk: 'high', at_risk: atRisk, mode: 'vent', emotions: [], distortions: [] }]),
    { type: 'speaker', role: 'guide' },
    { type: 'ai_response', role: 'guide', content: atRisk === 'other' ? P.CRISIS_OTHER_MESSAGE : P.CRISIS_MESSAGE },
    { type: 'speaker_end', role: 'guide' },
  ];
}

function latestUserText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]._getType() === 'human') return textOf(messages[i]);
  return '';
}

// 发言开头的角色标记（"【心懂】""理性派："）。模型偶尔会模仿，统一去掉
const LEAD_TAG = /^\s*(?:【[^】\n]{1,8}】|(?:心懂|理性派|感性派|第十人|验尸官|主持人)\s*[：:])\s*/;
// 会议角色发言的第一行："倾向：选项" / "检查：选项"
const STANCE_LINE = /^\s*(倾向|检查)\s*[：:]\s*(.+?)\s*$/;

// 对话记录：最近若干条，供各节点理解上下文。
// 角色名只在这里拼（来自 message.name），消息正文里不存任何标记，否则模型会学着在回复里写"【心懂】"
function transcript(messages: BaseMessage[], limit = 16): string {
  return messages.slice(-limit).map((m) => {
    if (m._getType() === 'human') return `用户：${textOf(m)}`;
    const stance = (m as AIMessage).additional_kwargs?.stance;
    const who = (ROLE_LABEL[m.name as Role] ?? '心懂') + (typeof stance === 'string' && stance ? `（${stance}）` : '');
    return `${who}：${textOf(m).replace(LEAD_TAG, '')}`; // replace：兼容旧存档里带标记的正文
  }).join('\n');
}

// "这句我没说过"只用来否认被安到心懂头上的话。用户只是自己下结论、问"对吧"时，模型还是会习惯性地先来这一句：
// 发言开头出现这句、而用户这一轮并没有说"你刚才说/你说过"，就把这一句去掉（提示词管不住，代码兜底）
const DENIAL_START = /^\s*(?:这句|这话|这个)?我(?:也|可|并|从来)?(?:没有?|从没)(?:说过|这么说)/;
const ATTRIBUTION = /你(?:刚才|刚刚|之前|前面|上次|一开始|不是)?\s*(?:说过|讲过|提过)|你(?:刚才|刚刚|之前|前面|上次|一开始|不是)\s*(?:说|讲|提)|你说我|你说的/;

function latestUserTurn(context: string): string {
  const log = context.split('\n\n【决策信息】')[0];
  const i = log.lastIndexOf('用户：');
  return i < 0 ? '' : log.slice(i + 3);
}

function leadingOption(d: Decision | null, scores: Score[]): string {
  if (!d || !scores.length) return '';
  let best = '', bestVal = -1;
  for (const o of d.options) {
    let sum = 0, w = 0;
    for (const c of d.criteria) {
      const sc = scores.find((x) => x.option === o && x.criterion === c.name);
      if (sc) { sum += sc.score * c.weight; w += c.weight; }
    }
    const v = w ? sum / w : 0;
    if (v > bestVal) { bestVal = v; best = o; }
  }
  return best;
}

function parseJSON<T>(raw: string): T | null {
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(raw.slice(s, e + 1)) as T; } catch { return null; }
}

const norm = (s: string) => s.replace(/[\s，。！？、,.!?…~～"“”'‘’]/g, '');

function mergeRejections(a: Rejection[], b: Rejection[]): Rejection[] {
  const out = [...a];
  for (const r of b ?? []) {
    if (!out.some((x) => x.kind === r.kind && x.label === r.label && norm(x.quote) === norm(r.quote))) out.push(r);
  }
  return out.slice(-50);
}

// 情绪按标题或近义查条目，思维陷阱按标题查
const EMOTION_ENTRIES = new Map(KNOWLEDGE.filter((e) => e.kind === '情绪').flatMap((e) => [e.title, ...e.aliases].map((w) => [w, e] as const)));
const DISTORTION_ENTRIES = new Map(KNOWLEDGE.filter((e) => e.kind === '思维陷阱').map((e) => [e.title, e] as const));
const citation = (e: KnowledgeEntry): Citation => ({ id: e.id, status: e.status, source: e.status === '待补' ? '' : e.source, definition: definition(e) });

/**
 * ⭐ 底层原则的代码级保障（不依赖模型自觉）：
 * 任何情绪 / 思维陷阱的解读，都必须能在用户「这一次」的原话里找到依据，否则直接丢弃。
 * - 依据不是用户最新消息里的原文 → 丢弃（防止拿过去的话、别人的话、或凭空推测）
 * - 依据太短（少于 2 个字）→ 丢弃（依据不足）
 * - 情绪名 / 思维陷阱类型在知识库里查不到 → 丢弃；查到的由代码附上条目编号和出处，不让模型自己填
 * - 用户点过「不准」的 → 丢弃：思维陷阱按类型（这次对话里不再提）；情绪只按"同一句话上的同一个情绪"（情绪本来就会变）
 * - 数量封顶，强度限定在 1~5
 */
export function enforceEvidence(a: Analysis, latest: string, rejected: Rejection[] = []): Analysis {
  const src = norm(latest);
  const grounded = (q: unknown) => typeof q === 'string' && norm(q).length >= 2 && src.includes(norm(q));
  const noType = new Set(rejected.filter((r) => r.kind === 'distortion').map((r) => r.label));
  const noEmotion = new Set(rejected.filter((r) => r.kind === 'emotion').map((r) => `${r.label}|${norm(r.quote)}`));
  const seen = new Set<string>(); // 近义词归并后，同一种情绪只留一条
  return {
    ...a,
    emotions: (Array.isArray(a.emotions) ? a.emotions : [])
      .flatMap((e) => {
        const entry = typeof e?.name === 'string' ? EMOTION_ENTRIES.get(e.name.trim()) : undefined;
        if (!entry || seen.has(entry.title) || !grounded(e.evidence) || noEmotion.has(`${entry.title}|${norm(e.evidence)}`)) return [];
        seen.add(entry.title);
        return [{ ...e, name: entry.title, knowledge: citation(entry) }];
      })
      .slice(0, 3)
      .map((e) => ({ ...e, intensity: Math.min(5, Math.max(1, Math.round(Number(e.intensity) || 3))) })),
    distortions: (Array.isArray(a.distortions) ? a.distortions : [])
      .flatMap((d) => {
        const entry = typeof d?.type === 'string' ? DISTORTION_ENTRIES.get(d.type.trim()) : undefined;
        if (!entry || !grounded(d.quote) || noType.has(entry.title)) return [];
        return [{ ...d, type: entry.title, knowledge: citation(entry) }];
      })
      .slice(0, 2),
  };
}

const GUESS_HINT = /信息不足|估计|常识|不确定|未知/;

function cleanDecision(d: any): Decision | null {
  if (!d || typeof d !== 'object') return null;
  const options = (Array.isArray(d.options) ? d.options : []).filter((x: any) => typeof x === 'string' && x.trim()).slice(0, 4);
  const criteria = (Array.isArray(d.criteria) ? d.criteria : [])
    .filter((c: any) => c && typeof c.name === 'string' && c.name.trim())
    .slice(0, 6)
    .map((c: any) => ({ name: c.name.trim(), weight: Math.min(5, Math.max(1, Math.round(Number(c.weight) || 3))) }));
  return {
    question: typeof d.question === 'string' ? d.question : '',
    options,
    criteria,
    facts: (Array.isArray(d.facts) ? d.facts : []).filter((x: any) => typeof x === 'string').slice(0, 12),
  };
}

// 用户亲手调的权重（0~5）优先于分析员的估计
function applyUserWeights(d: Decision, w: Record<string, number> | null): Decision {
  if (!w) return d;
  return {
    ...d,
    criteria: d.criteria.map((c) => {
      const n = Number(w[c.name]);
      return Number.isFinite(n) ? { ...c, weight: Math.min(5, Math.max(0, Math.round(n))) } : c;
    }),
  };
}

const decisionKey = (d: Decision | null) => (d ? JSON.stringify([d.options, d.criteria.map((c) => c.name)]) : '');

// 倾向徽章只认决策信息里真实存在的选项：对不上就算"中立"（检查对不上就不显示）
function matchOption(value: string, options: string[]): string | null {
  const v = norm(value.replace(/\*/g, ''));
  if (!v) return null;
  const exact = options.find((o) => norm(o) === v);
  if (exact) return exact;
  const loose = options.filter((o) => v.includes(norm(o)) || norm(o).includes(v));
  return loose.length === 1 ? loose[0] : null;
}

// 第一行是"倾向：……"就拆出来（不给用户看这一行），否则返回 null
function splitStance(head: string, options: string[]): { stance: string; rest: string } | null {
  const nl = head.indexOf('\n');
  const first = (nl < 0 ? head : head.slice(0, nl)).replace(LEAD_TAG, '').replace(/\*/g, '');
  const m = first.match(STANCE_LINE);
  if (!m) return null;
  const opt = matchOption(m[2], options);
  const stance = m[1] === '检查' ? (opt ? `检查：${opt}` : '') : `倾向：${opt ?? '中立'}`;
  return { stance, rest: nl < 0 ? '' : head.slice(nl + 1).replace(/^\s+/, '').replace(LEAD_TAG, '') };
}

function decisionText(d: Decision | null, scores: Score[]): string {
  if (!d) return '（暂无）';
  const lines = [
    `问题：${d.question}`,
    `选项：${d.options.join(' / ')}`,
    `在乎的方面（括号里是用户有多看重，1~5，发言里不要说数字，也不要说“权重”）：${d.criteria.map((c) => `${c.name}(${c.weight})`).join('、')}`,
  ];
  if (d.facts.length) lines.push(`用户提到的事实：${d.facts.join('；')}`);
  if (scores.length) {
    lines.push('打分表（1-10 分，帮你理解各选项的长短，发言里不要报数字）：');
    for (const o of d.options) {
      lines.push(`  ${o}：`);
      for (const s of scores.filter((x) => x.option === o)) {
        lines.push(`    - ${s.criterion} ${s.score}${s.basis === 'guess' ? '（按常识估计，不是用户说的）' : ''}：${s.reason || '没有理由'}`);
      }
    }
  }
  return lines.join('\n');
}

// 只把「本轮」的分析笔记交给发言角色
function notesText(a: Analysis | null): string {
  if (!a) return '（无）';
  const parts: string[] = [];
  if (a.emotions.length) parts.push('用户这次的话里可能流露的情绪：' + a.emotions.map((e) => `${e.name}（依据："${e.evidence}"）`).join('；'));
  if (a.distortions.length) parts.push('这次的话里可能的思维陷阱：' + a.distortions.map((d) => `"${d.quote}"——${d.explain}`).join('；'));
  if (a.missing) parts.push('还缺的信息：' + a.missing);
  return parts.join('\n') || '（无）';
}

// 计量：每次模型调用记一笔耗时和 token，作为 usage 事件交给 index.ts 汇总（前端不显示）。调用失败时 token 记 0
function usageEvent(node: string, started: number, u?: { input_tokens?: number; output_tokens?: number; input_token_details?: { cache_read?: number } } | null) {
  return { type: 'usage', node, ms: Date.now() - started, input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cached: u?.input_token_details?.cache_read ?? 0 };
}

// ---------- 构图 ----------

export function buildGraph(analyst: ChatOpenAI, speaker: ChatOpenAI, checkpointer: any, store: any, seatModel: ChatOpenAI = speaker, embedder?: (text: string, signal?: AbortSignal) => ReturnType<Embedder>) {
  // 让某个角色发言：流式推送给前端，并把完整发言存进对话历史。
  // options：会议角色传入决策选项，第一行的"倾向：……"会被拆成 stance 事件（徽章）；model：会议角色用 seatModel
  // tail：发言结束后由代码补上的文字，模型出错时也会发
  async function speak(role: Role, system: string, context: string, config: LangGraphRunnableConfig, options?: string[], model: ChatOpenAI = speaker, tail?: (text: string) => string): Promise<AIMessage> {
    const write = config.writer ?? (() => {});
    write({ type: 'speaker', role });
    let full = '';
    let stance = '';
    // 开头先攒一小段（要倾向的角色攒到第一行结束），确认没有角色标记再推给前端
    let head: string | null = '';
    const emit = (t: string) => {
      if (!t) return;
      full += t;
      write({ type: 'ai_response', role, content: t });
    };
    const denyOff = !ATTRIBUTION.test(latestUserTurn(context));
    const flushHead = (h: string) => {
      if (denyOff && DENIAL_START.test(h)) h = h.replace(/^[^。！!？?\n]*[。！!？?\n]?\s*/, '');
      const s = options?.length ? splitStance(h, options) : null;
      if (s) {
        stance = s.stance;
        if (stance) write({ type: 'stance', role, stance });
        emit(s.rest);
      } else emit(h.replace(LEAD_TAG, ''));
    };
    const started = Date.now();
    let usage: AIMessageChunk['usage_metadata'] = undefined; // 流式时用量在最后一段数据里
    try {
      const stream = await model.stream(
        [new SystemMessage(system), new HumanMessage(context)],
        { signal: config.signal },
      );
      for await (const chunk of stream) {
        if (chunk.usage_metadata) usage = chunk.usage_metadata;
        const t = typeof chunk.content === 'string' ? chunk.content : '';
        if (!t) continue;
        if (head === null) { emit(t); continue; }
        head += t;
        const denial = denyOff && DENIAL_START.test(head) && !/[。！!？?\n]/.test(head) && head.length < 80; // 等这句说完再决定删不删
        const enough = !denial && (options?.length ? head.includes('\n') || head.length >= 80 : head.length >= 12 || head.includes('\n'));
        if (!enough) continue;
        flushHead(head);
        head = null;
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError' || config.signal?.aborted) throw e;
      write({ type: 'error_message', role, content: friendlyError(e) });
    }
    if (head) flushHead(head);
    if (tail) emit(tail(full));
    write(usageEvent(role, started, usage));
    write({ type: 'speaker_end', role });
    return new AIMessage({ content: full, name: role, additional_kwargs: stance ? { stance } : {} });
  }

  // 低落时的语气提示；热线一段对话只提一次
  function concernSuffix(state: S): string {
    if (state.turn?.risk !== 'concern') return '';
    const hinted = state.messages.some((m) => m._getType() === 'ai' && textOf(m).includes('12356'));
    return hinted ? P.CONCERN_SUFFIX_SOFT : P.CONCERN_SUFFIX;
  }

  function ctx(state: S, extra = ''): string {
    return [
      `【对话记录】\n${transcript(state.messages)}`,
      `【决策信息】\n${decisionText(state.decision, state.scores)}`,
      `【分析员笔记（仅限本轮）】\n${notesText(state.turn)}`,
      extra,
    ].filter(Boolean).join('\n\n');
  }

  // 1. 分析：安全 + 模式 + 情绪 + 决策信息
  async function analyze(state: S, config: LangGraphRunnableConfig) {
    const write = config.writer ?? (() => {});
    write({ type: 'status', content: '正在理解你的话…' });
    const latest = latestUserText(state.messages);
    // 只给分析员：对话记录 + 上一轮的「决策事实」。不给任何以往的情绪/心理解读。
    const input = [
      `【对话记录】\n${transcript(state.messages, 12)}`,
      `【上一轮的决策信息】\n${state.decision ? JSON.stringify(state.decision) : 'null'}`,
      `【之前是否已针对当前选项开过会】${state.debatedKey && state.debatedKey === decisionKey(state.decision) ? '是' : '否'}`,
      state.modeHint ? `【用户手动选择的模式】${state.modeHint}` : '',
      state.recentCrisis ? P.RECENT_CRISIS_NOTE : '',
      `【用户最新一条消息】\n${latest}`,
    ].filter(Boolean).join('\n\n');

    let parsed: Analysis | null = null;
    let analystDown = false; // 分析员没回应（额度用完、超时……）：前端要说"这次没法分析"，不能装作"没听出情绪"
    const started = Date.now();
    try {
      const res = await analyst.invoke([new SystemMessage(P.ANALYZE_PROMPT), new HumanMessage(input)], { signal: config.signal });
      write(usageEvent('analyze', started, res.usage_metadata));
      parsed = parseJSON<Analysis>(textOf(res as BaseMessage));
    } catch (e) {
      if ((e as Error).name === 'AbortError' || config.signal?.aborted) throw e;
      write(usageEvent('analyze', started));
      analystDown = true;
    }
    const base: Analysis = {
      risk: 'none', at_risk: '', mode: 'chat', action: 'listen', emotions: [], distortions: [], decision: null, missing: '',
      ...(parsed ?? {}),
    } as Analysis;
    if (!['none', 'concern', 'high'].includes(base.risk)) base.risk = 'none';
    if (base.at_risk !== 'self' && base.at_risk !== 'other') base.at_risk = '';
    const own = ownWords(latest);
    if (hasCrisisWord(own)) base.risk = 'high';   // 关键词兜底：宁可误判，不可漏判

    // 手动模式优先
    if (state.modeHint === 'vent') { base.mode = 'vent'; base.action = 'listen'; }
    if (state.modeHint === 'relation') { base.mode = 'relation'; base.action = 'listen'; }
    if (state.modeHint === 'decision' && base.mode !== 'decision') base.mode = 'decision';

    const turn = enforceEvidence(base, own, state.rejected);
    // 安全优先：危机时不做任何情绪 / 思维解读；情绪低落时不做"换个角度"式的认知纠偏
    if (turn.risk === 'high') { turn.emotions = []; turn.distortions = []; }
    else if (turn.risk === 'concern') turn.distortions = [];
    let decision = cleanDecision(base.decision) ?? state.decision;
    if (decision) decision = applyUserWeights(decision, state.userWeights);
    if (turn.mode === 'decision' && turn.action === 'listen') turn.action = 'clarify';
    if (turn.action === 'debate' && (!decision || decision.options.length < 2 || decision.criteria.length < 1)) turn.action = 'clarify';
    // 选项 ≥2、在乎的方面 ≥2，又还没针对这组选项开过会 → 一定开会。
    // 这个判断不交给模型：同一句话不能这次开会、下次只反问
    const ready = !!decision && decision.options.length >= 2 && decision.criteria.length >= 2;
    if (turn.mode === 'decision' && turn.action === 'clarify' && ready && state.debatedKey !== decisionKey(decision)) turn.action = 'debate';
    // 同一组选项刚开过会：不重开一整场（会把同样的话再说一遍），除非用户明确说"重新开会"
    if (turn.action === 'debate' && decision && state.debatedKey === decisionKey(decision) && !/重新开|再开一次|重开|再开个会/.test(latest)) turn.action = 'followup';
    if (turn.action === 'followup' && !state.debatedKey) turn.action = decision && decision.options.length >= 2 ? 'debate' : 'clarify';
    // 开会之前先问一句（固定文字，不花额度）：一下子出来四段发言加打分表，对刚说完心事的人太多了。
    // 用户明确要开会，或者上一轮刚问过、他回"好/开吧"，才真的开
    const wantsMeeting = /开会|开始吧|分析一下|帮我分析|直接分析|重新开/.test(latest)
      || (state.offeredMeeting && /^\s*(好|行|可以|开|来|嗯|是|要|ok)/i.test(latest));
    if (turn.action === 'debate' && !wantsMeeting) turn.action = 'offer';

    write({ type: 'insight', unavailable: analystDown, risk: turn.risk, at_risk: turn.at_risk, mode: turn.mode, emotions: turn.emotions, distortions: turn.distortions });
    if (decision && JSON.stringify(decision) !== JSON.stringify(state.decision)) write({ type: 'decision', decision });
    return { turn, decision };
  }

  async function crisis(_state: S, config: LangGraphRunnableConfig) {
    const write = config.writer ?? (() => {});
    write({ type: 'speaker', role: 'guide' });
    write({ type: 'ai_response', role: 'guide', content: P.CRISIS_MESSAGE });
    write({ type: 'speaker_end', role: 'guide' });
    return { messages: [new AIMessage({ content: P.CRISIS_MESSAGE, name: 'guide' })], turn: null };
  }

  // 用户转述的别人有危险：固定文字，教用户怎么帮对方（不交给模型临场发挥）
  async function crisisOther(state: S, config: LangGraphRunnableConfig) {
    const write = config.writer ?? (() => {});
    // 开头说"其实/说实话"再提朋友，常常是在借朋友说自己：先把门留开
    const hint = /^\s*(其实|说实话|老实说|实话说)/.test(latestUserText(state.messages)) ? P.CRISIS_OTHER_HINT : '';
    const text = hint + P.CRISIS_OTHER_MESSAGE;
    write({ type: 'speaker', role: 'guide' });
    write({ type: 'ai_response', role: 'guide', content: text });
    write({ type: 'speaker_end', role: 'guide' });
    return { messages: [new AIMessage({ content: text, name: 'guide' })], turn: null };
  }

  async function listen(state: S, config: LangGraphRunnableConfig) {
    const sys = P.LISTEN_PROMPT + concernSuffix(state);
    return { messages: [await speak('host', sys, ctx(state), config)], turn: null };
  }

  // 关系模式：我听到的 → 换到对方那边看看 → 可以这样说（非暴力沟通的回复草稿）
  async function relation(state: S, config: LangGraphRunnableConfig) {
    const write = config.writer ?? (() => {});
    const latest = latestUserText(state.messages);
    // 排序只用用户自己的话；紧急条目看完整消息，对方说的威胁也算
    const started = Date.now();
    const found = await searchKnowledge(ownWords(latest), latest, '非暴力沟通', 4, embedder && ((text) => embedder(text, config.signal)));
    write({ ...usageEvent('embed', started, { input_tokens: found.tokens }), vector: found.vector });
    if (found.entries.length) write({ type: 'knowledge', urgent: found.urgent, items: found.entries.map((e) => ({ ...citation(e), title: e.title })) });
    const sys = P.RELATION_PROMPT + concernSuffix(state) + P.relationKnowledge(found.entries, found.urgent);
    // 提示词不能保证模型照做，涉及人身安全时求助方式由代码兜底
    const tail = found.urgent ? (text: string) => (text.includes('110') ? '' : `${text ? '\n\n' : ''}${P.RELATION_SAFETY_TAIL}`) : undefined;
    return { messages: [await speak('host', sys, ctx(state), config, undefined, speaker, tail)], turn: null };
  }

  // 信息够开会了：先问一句。固定文字，列出选项和在乎的方面，前端在下面放一个「现在开会」按钮
  async function offer(state: S, config: LangGraphRunnableConfig) {
    const write = config.writer ?? (() => {});
    // 上一轮已经问过、用户又补充了：让心懂接住补充的话，按钮照旧给
    if (state.offeredMeeting) {
      const msg = await speak('host', P.OFFER_AGAIN_PROMPT + concernSuffix(state), ctx(state), config);
      write({ type: 'offer_meeting' });
      return { messages: [msg], turn: null, offeredMeeting: true };
    }
    const d = state.decision!;
    const text = `信息差不多够了：\n- 选项：${d.options.join(' / ')}\n- 你在乎的：${d.criteria.map((c) => c.name).join('、')}\n\n要现在请理性派、感性派、第十人和验尸官一起帮你分析吗？也可以先再补充一点。`;
    write({ type: 'speaker', role: 'host' });
    write({ type: 'ai_response', role: 'host', content: text });
    write({ type: 'speaker_end', role: 'host' });
    write({ type: 'offer_meeting' });
    return { messages: [new AIMessage({ content: text, name: 'host' })], turn: null, offeredMeeting: true };
  }

  async function clarify(state: S, config: LangGraphRunnableConfig) {
    const sys = P.CLARIFY_PROMPT + concernSuffix(state);
    return { messages: [await speak('host', sys, ctx(state), config)], turn: null };
  }

  async function followup(state: S, config: LangGraphRunnableConfig) {
    const sys = P.FOLLOWUP_PROMPT + concernSuffix(state);
    return { messages: [await speak('host', sys, ctx(state), config)], turn: null };
  }

  // 2. 开会：打分 → 理性派 → 感性派 → 第十人 → 验尸官 → 主持人总结
  async function score(state: S, config: LangGraphRunnableConfig) {
    const write = config.writer ?? (() => {});
    const d = state.decision!;
    write({ type: 'status', content: '正在给各个选项打分…' });
    let scores: Score[] = [];
    const started = Date.now();
    try {
      const res = await analyst.invoke(
        [new SystemMessage(P.SCORE_PROMPT), new HumanMessage(`【决策信息】\n${JSON.stringify(d)}\n\n【对话记录】\n${transcript(state.messages, 12)}`)],
        { signal: config.signal },
      );
      write(usageEvent('score', started, res.usage_metadata));
      const parsed = parseJSON<{ scores: Score[] }>(textOf(res as BaseMessage));
      scores = (parsed?.scores ?? [])
        .filter((s) => d.options.includes(s.option) && d.criteria.some((c) => c.name === s.criterion))
        // 模型说 said 但理由里写着"估计/信息不足"，以理由为准
        .map((s) => ({ ...s, basis: (s.basis === 'said' && !GUESS_HINT.test(s.reason ?? '') ? 'said' : 'guess') as Score['basis'] }));
    } catch (e) {
      if ((e as Error).name === 'AbortError' || config.signal?.aborted) throw e;
      write(usageEvent('score', started));
    }
    // 缺的组合补中间分，保证表格完整（标记为估计）
    for (const o of d.options) for (const c of d.criteria) {
      if (!scores.some((s) => s.option === o && s.criterion === c.name)) scores.push({ option: o, criterion: c.name, score: 5, reason: '信息不足', basis: 'guess' });
    }
    scores = scores.map((s) => {
      const n = Math.min(10, Math.max(1, Math.round(Number(s.score) || 5)));
      // 估的分只能是中间分：没依据的猜测不该左右结果
      return { ...s, score: s.basis === 'guess' ? Math.min(6, Math.max(5, n)) : n };
    });
    write({ type: 'scores', decision: d, scores });
    write({ type: 'status', content: '内心会议室开会中…' });
    return { scores, offeredMeeting: false };
  }

  const seat = (role: Role, prompt: string) => async (s: S, c: LangGraphRunnableConfig) =>
    ({ messages: [await speak(role, prompt, ctx(s), c, s.decision?.options ?? [], seatModel)] });
  const rational = seat('rational', P.RATIONAL_PROMPT);
  const emotional = seat('emotional', P.EMOTIONAL_PROMPT);
  const tenth = seat('tenth', P.TENTH_PROMPT);
  // 验尸对象由代码定：按用户的轻重算出的领先选项（和页面上「领先」是同一个），不让模型每次随手挑
  const premortem = async (s: S, c: LangGraphRunnableConfig) => {
    const lead = leadingOption(s.decision, s.scores);
    const extra = lead ? `【验尸对象】${lead}` : '';
    return { messages: [await speak('premortem', P.PREMORTEM_PROMPT, ctx(s, extra), c, s.decision?.options ?? [], seatModel)] };
  };
  const summary = async (s: S, c: LangGraphRunnableConfig) => ({
    messages: [await speak('host', P.SUMMARY_PROMPT, ctx(s), c)],
    debatedKey: decisionKey(s.decision),
    turn: null,
  });

  function route(state: S): string {
    const t = state.turn!;
    // 危机关键词兜底只管"有没有危险"；是谁有危险，看分析员。被说成"别人"的，回复末尾也会提醒"如果其实是你自己"
    if (t.risk === 'high') return t.at_risk === 'other' ? 'crisis_other' : 'crisis';
    if (t.action === 'debate') return 'score';
    if (t.action === 'offer') return 'offer';
    if (t.action === 'clarify') return 'clarify';
    if (t.action === 'followup') return 'followup';
    if (t.mode === 'relation') return 'relation';
    return 'listen';
  }

  return new StateGraph(State)
    .addNode('analyze', analyze)
    .addNode('crisis', crisis)
    .addNode('crisis_other', crisisOther)
    .addNode('listen', listen)
    .addNode('relation', relation)
    .addNode('clarify', clarify)
    .addNode('followup', followup)
    .addNode('score', score)
    .addNode('offer', offer)
    .addNode('rational', rational)
    .addNode('emotional', emotional)
    .addNode('tenth', tenth)
    .addNode('premortem', premortem)
    .addNode('summary', summary)
    .addEdge(START, 'analyze')
    .addConditionalEdges('analyze', route, ['crisis', 'crisis_other', 'listen', 'relation', 'clarify', 'followup', 'score', 'offer'])
    .addEdge('score', 'rational')
    .addEdge('rational', 'emotional')
    .addEdge('emotional', 'tenth')
    .addEdge('tenth', 'premortem')
    .addEdge('premortem', 'summary')
    .addEdge('crisis', END)
    .addEdge('crisis_other', END)
    .addEdge('listen', END)
    .addEdge('relation', END)
    .addEdge('clarify', END)
    .addEdge('followup', END)
    .addEdge('offer', END)
    .addEdge('summary', END)
    .compile({ checkpointer, store });
}
