// Shared OpenAI-compat client (provider-agnostic, swapped via LLM_* env). Split out of
// loop.js so intent executors (agent/intents.js, services/exportpack.js,
// prompts/classifiers.js) can run one-shot completions without importing
// loop.js — loop.js imports tools.js, and tools.js needs to import intents.js
// for the confirm-before-generate stash, which would otherwise cycle back to
// loop.js and break `TOOL_SCHEMAS`'s top-level evaluation order.
import OpenAI from 'openai';

// Lazy client: constructing OpenAI() eagerly would require LLM_API_KEY at
// import time, which breaks pure-function unit tests (chunkMarkdown, etc.)
// that never call the LLM.
let llm;
export function getLlm() {
  llm ??= new OpenAI({
    apiKey: process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL, // Gemini compat / NVIDIA NIM / OpenRouter / Ollama
    // Without this the SDK's own default (10 minutes) applies — live-caught:
    // a hung upstream call left a Slack stream open ("streaming_state:
    // in_progress", empty text) with no error surfaced for over 5 minutes,
    // since nothing downstream ever got a chance to react. 120s covers the
    // slowest known-good reasoning-model turns (60-90s) with headroom.
    timeout: 120_000,
  });
  return llm;
}
export const MODEL = process.env.LLM_MODEL ?? 'gemini-2.5-flash';
export const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 4000);

export async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const status = e?.status ?? e?.response?.status;
      const code = e?.code ?? e?.cause?.code; // network errors nest under .cause on the openai SDK
      const timedOut = code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED';
      const retriable = status === 429 || (status >= 500 && status < 600) || timedOut;
      if (!retriable || i === attempts - 1) throw e;
      const retryAfter = Number(e?.headers?.['retry-after']) * 1000;
      const delay = retryAfter > 0 ? retryAfter : 800 * 2 ** i + Math.random() * 400;
      console.warn(`[llm] ${status} — retry ${i + 1} in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last;
}

/** Deterministic intent executors and classifiers run OUTSIDE
 * the tool loop: one completion, no tools, same retry/model config. */
export async function completeOnce(messages, { maxTokens = MAX_TOKENS, temperature = 0.2 } = {}) {
  let response = await withRetry(() =>
    getLlm().chat.completions.create({ model: MODEL, max_tokens: maxTokens, temperature, messages })
  );
  // Reasoning models burn a non-deterministic share of max_tokens on internal
  // chain-of-thought before the answer — a length-truncated completion here
  // means a silently partial draft/answer, not an error. One retry with real
  // headroom recovers almost all of these.
  if (response.choices[0].finish_reason === 'length') {
    console.warn('[llm] completion truncated by reasoning budget — retrying with headroom');
    response = await withRetry(() =>
      getLlm().chat.completions.create({ model: MODEL, max_tokens: Math.max(maxTokens * 2, 14000), temperature, messages })
    );
  }
  return response.choices[0].message.content ?? '';
}
