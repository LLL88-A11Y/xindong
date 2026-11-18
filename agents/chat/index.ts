import { createLogger, createSSEResponse, jsonResponse, sseEvent } from '../_shared';
import { createModel, getAgentEnv } from '../_model';
import { buildGraph, friendlyError, type Rejection } from './_graph';

const logger = createLogger('chat');

// 图按 checkpointer 实例缓存，避免每个请求都重新编译
const graphCache = new WeakMap<object, ReturnType<typeof buildGraph>>();

// 用户在打分表里调过的权重：{ 方面名: 0~5 }
function parseWeights(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 6)) {
    const n = Number(v);
    if (k.length <= 30 && Number.isFinite(n)) out[k] = Math.min(5, Math.max(0, Math.round(n)));
  }
  return Object.keys(out).length ? out : null;
}

// 用户点了「不准」的解读
function parseRejected(raw: unknown): Rejection[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap((r: any) => {
    if (!r || (r.kind !== 'emotion' && r.kind !== 'distortion') || typeof r.label !== 'string' || !r.label.trim()) return [];
    return [{ kind: r.kind, label: r.label.slice(0, 20), quote: typeof r.quote === 'string' ? r.quote.slice(0, 200) : '' }];
  });
}

// 限流：每台设备每小时最多 DEVICE_HOURLY 条；同一个 IP 再兜一层（清掉本地数据就能换设备号，IP 换不了；
// 一家人或一个宿舍可能共用 IP，所以放宽到 IP_HOURLY）。按整点小时计，存在平台 store 里，每个 key 只留一条记录。
const DEVICE_HOURLY = 20;
const IP_HOURLY = 60;

function header(request: any, name: string): string {
  const h = request?.headers;
  if (!h) return '';
  const v = typeof h.get === 'function' ? h.get(name) : h[name];
  return String(v ?? '').split(',')[0].trim();
}

function clientIp(request: any): string {
  for (const name of ['eo-connecting-ip', 'x-real-ip', 'x-forwarded-for']) {
    const v = header(request, name);
    if (v && v.length <= 64) return v;
  }
  return '';
}

// 超限时返回提示文案；没超限就记一笔并返回 null。store 出错时放行，不能因为限流挂了就让人用不了
async function checkRateLimit(lgStore: any, keys: Array<[string, number]>): Promise<string | null> {
  const now = new Date();
  const hour = now.toISOString().slice(0, 13);
  try {
    const items = await Promise.all(keys.map(([k]) => lgStore.get(['ratelimit'], k)));
    const counts = items.map((it: any) => (it?.value?.hour === hour ? Number(it.value.count) || 0 : 0));
    if (keys.some(([, limit], i) => counts[i] >= limit)) {
      const mins = 60 - now.getUTCMinutes();
      return `这个小时发的消息有点多了，休息一下，大约 ${mins} 分钟后再来。如果情况危急，请直接打 **12356**（心理援助）或 **110** / **120**。`;
    }
    await Promise.all(keys.map(([k], i) => lgStore.put(['ratelimit'], k, { hour, count: counts[i] + 1 })));
  } catch (e) {
    logger.error('rate limit store failed', e);
  }
  return null;
}

interface TurnInput { message: string; modeHint: string; userWeights: Record<string, number> | null; rejected: Rejection[] }

async function* eventStream(graph: any, input: TurnInput, conversationId: string, startedAt: number, signal?: AbortSignal) {
  const { message, modeHint, userWeights, rejected } = input;
  // 计量：图里每次模型调用发一个 usage 事件，在这里收起来；首字时间 = 第一段回复文字推给前端的时刻
  const calls: Record<string, unknown>[] = [];
  let firstTextMs = 0;
  try {
    const stream = await graph.stream(
      { messages: [{ role: 'user', content: message }], modeHint, turn: null, userWeights, rejected },
      { streamMode: 'custom', signal, configurable: { thread_id: conversationId }, recursionLimit: 20 },
    );
    for await (const chunk of stream) {
      if (signal?.aborted) break;
      if (!chunk || typeof chunk !== 'object') continue;
      const ev = chunk as Record<string, unknown>;
      if (ev.type === 'usage') { calls.push(ev); continue; }
      if (!firstTextMs && ev.type === 'ai_response' && ev.content) firstTextMs = Date.now() - startedAt;
      yield sseEvent(ev);
    }
  } catch (e) {
    const err = e as Error;
    if (err.name === 'MemoryCorruptError') {
      yield sseEvent({ type: 'error_message', code: 'AGENT_STATE_CORRUPT', content: '这段对话的记录损坏了，请点「新对话」重新开始。' });
    } else if (err.name !== 'AbortError' && !signal?.aborted) {
      logger.error('stream failed', err);
      yield sseEvent({ type: 'error_message', content: friendlyError(err) });
    }
  }
  if (!signal?.aborted) {
    const metrics = { type: 'metrics', total_ms: Date.now() - startedAt, first_text_ms: firstTextMs || null, calls };
    logger.log('metrics', JSON.stringify(metrics));
    yield sseEvent(metrics);
  }
  yield 'data: [DONE]\n\n';
}

export async function onRequest(context: any) {
  const startedAt = Date.now();
  const { request, env, conversation_id: conversationId, store } = context;

  // 只读 messages；历史由 checkpointer 保存，所以只取最新一条用户消息
  const messages = Array.isArray(request?.body?.messages) ? request.body.messages : [];
  const latest = [...messages].reverse().find(
    (m: any) => m?.role === 'user' && typeof m?.content === 'string' && m.content.trim(),
  );
  if (!latest) return jsonResponse({ error: "'messages' is required" }, 400);
  if (!conversationId) return jsonResponse({ error: "'makers-conversation-id' header is required" }, 400);

  const rawMode = request?.body?.mode;
  const input: TurnInput = {
    message: String(latest.content).slice(0, 4000),
    modeHint: rawMode === 'decision' || rawMode === 'vent' || rawMode === 'relation' ? rawMode : '',
    userWeights: parseWeights(request?.body?.weights),
    rejected: parseRejected(request?.body?.rejected),
  };
  const signal = request?.signal as AbortSignal | undefined;

  const rawDevice = request?.body?.device;
  const device = typeof rawDevice === 'string' && /^[\w-]{8,64}$/.test(rawDevice) ? rawDevice : '';
  const ip = clientIp(request);
  const limits: Array<[string, number]> = [];
  if (device) limits.push([`d:${device}`, DEVICE_HOURLY]);
  if (ip) limits.push([`ip:${ip}`, IP_HOURLY]);
  if (!limits.length) limits.push([`c:${conversationId}`, DEVICE_HOURLY]);
  // 评测请求（evals/run.mjs）带 x-eval-token，口令对上就不计入限流；口令只在 .env 里，至少 16 位才生效
  const evalToken = String(env?.XD_EVAL_TOKEN ?? '').trim();
  const isEval = evalToken.length >= 16 && header(request, 'x-eval-token') === evalToken;
  const limited = isEval ? null : await checkRateLimit(store.langgraphStore, limits);
  if (limited) {
    return createSSEResponse(async function* () {
      yield sseEvent({ type: 'error_message', code: 'RATE_LIMITED', content: limited });
      yield 'data: [DONE]\n\n';
    }, signal);
  }

  const agentEnv = getAgentEnv(env);
  const checkpointer = store.langgraphCheckpointer;
  const lgStore = store.langgraphStore;

  let graph = graphCache.get(checkpointer);
  if (!graph) {
    graph = buildGraph(createModel(agentEnv, 'analyst'), createModel(agentEnv, 'speaker'), checkpointer, lgStore, createModel(agentEnv, 'seat'));
    graphCache.set(checkpointer, graph);
  }

  return createSSEResponse((sig) => eventStream(graph, input, conversationId, startedAt, sig), signal);
}
