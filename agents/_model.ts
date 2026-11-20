import { ChatOpenAI } from '@langchain/openai';

const DEFAULT_MODEL = '@makers/deepseek-v4-flash';

export interface AgentEnv {
  AI_GATEWAY_API_KEY: string;
  AI_GATEWAY_BASE_URL: string;
  AI_GATEWAY_MODEL: string;
}

export function getAgentEnv(contextEnv: Record<string, string | undefined> | undefined): AgentEnv {
  const source = contextEnv ?? {};
  // 直连模型厂商（绕过 Makers 网关，网关故障时用）：LLM_BASE_URL + LLM_API_KEY 都设置了就优先用。
  // 不能直接改 .env 里的 AI_GATEWAY_*：部署时平台会用自己的同名变量覆盖它们。
  if (source.LLM_BASE_URL?.trim() && source.LLM_API_KEY?.trim()) {
    return {
      AI_GATEWAY_API_KEY: source.LLM_API_KEY.trim(),
      AI_GATEWAY_BASE_URL: source.LLM_BASE_URL.trim(),
      AI_GATEWAY_MODEL: source.LLM_MODEL?.trim() || source.AI_GATEWAY_MODEL?.trim() || DEFAULT_MODEL,
    };
  }
  const required = ['AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL'] as const;
  const missing = required.filter((k) => !source[k]?.trim());
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  return {
    AI_GATEWAY_API_KEY: source.AI_GATEWAY_API_KEY!,
    AI_GATEWAY_BASE_URL: source.AI_GATEWAY_BASE_URL!,
    AI_GATEWAY_MODEL: source.AI_GATEWAY_MODEL?.trim() || DEFAULT_MODEL,
  };
}

// 向量化一句话，用于知识检索。超时或出错就抛出，由调用方退回关键词检索，不能让用户干等
const EMBED_TIMEOUT_MS = 1500;
export function createEmbedder(env: AgentEnv) {
  return async (text: string, signal?: AbortSignal): Promise<{ vector: number[]; tokens: number }> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const resp = await fetch(`${env.AI_GATEWAY_BASE_URL.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_GATEWAY_API_KEY}` },
        body: JSON.stringify({ model: 'embedding-3', input: [text], dimensions: 512 }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`embedding HTTP ${resp.status}`);
      const json = await resp.json() as { data: Array<{ embedding: number[] }>; usage?: { total_tokens?: number } };
      return { vector: json.data[0].embedding, tokens: json.usage?.total_tokens ?? 0 };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

// 三个实例：
// - analyst：低温度（稳定的 JSON）；安全判断、证据、打分依据靠它
// - speaker：心懂本人发言（倾听、追问、总结），高温度；原则相关的分寸靠它
// - seat：会议里的四个角色，高温度
//
// 关于"思考"（thinking）：
// 只要模型认 thinking:{type:'disabled'} 就统一关掉。实测 zai/glm-5.2 跑真实 ANALYZE_PROMPT：
//   开思考 22.2s / 3320 token，关思考 5.1s / 1848 token；JSON 结构一致，
//   风险分级（high / concern / none）在"直接轻生 / 隐晦表达 / 他人风险 / 普通纠结"四类样本上全部判对，
//   发言质量看不出差别。心懂一轮要跑 2~3 次模型调用，开思考用户等不起。
const modelCache = new Map<string, ChatOpenAI>();

const NO_THINKING_MODELS = /deepseek|glm|zai/i; // 目前只有这两家认这个参数

export function createModel(env: AgentEnv, kind: 'analyst' | 'speaker' | 'seat'): ChatOpenAI {
  const cacheKey = `${env.AI_GATEWAY_MODEL}:${env.AI_GATEWAY_BASE_URL}:${kind}`;
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;
  const noThinking = NO_THINKING_MODELS.test(env.AI_GATEWAY_MODEL);
  const model = new ChatOpenAI({
    model: env.AI_GATEWAY_MODEL,
    apiKey: env.AI_GATEWAY_API_KEY,
    configuration: { baseURL: env.AI_GATEWAY_BASE_URL },
    temperature: kind === 'analyst' ? 0.2 : 0.8,
    timeout: 120_000,
    maxRetries: 1,
    ...(noThinking ? { modelKwargs: { thinking: { type: 'disabled' } } } : {}),
  });
  modelCache.set(cacheKey, model);
  return model;
}
