import { jsonResponse } from './_shared';

// 前端调用 /stop 时不带 makers-conversation-id 头，只在 body 里传 conversation_id
export async function onRequest(context: any) {
  const conversationId = context.request?.body?.conversation_id;
  if (!conversationId || typeof conversationId !== 'string') {
    return jsonResponse({ error: "'conversation_id' is required" }, 400);
  }
  try {
    await context.utils?.abortActiveRun?.(conversationId);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ ok: false, error: (e as Error).message }, 500);
  }
}
