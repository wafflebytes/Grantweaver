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

// 3 attempts x 120s timeout meant a truly slow backend could take ~6min to
// surface an error on ONE completion call — and a tool turn can make two of
// these (see loop.js's truncation retry) across up to MAX_TURNS turns, so a
// single Slack reply could legitimately sit for the better part of an hour
// before failing. Live-observed worst case: ~9.5min on a single turn. 2
// attempts halves the worst case per call without giving up retries
// altogether (a 5xx/429 blip still gets one retry).
export async function withRetry(fn, attempts = 2) {
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

// completeOnce's own worst case (2 truncation attempts x withRetry's 2
// attempts x 120s timeout) is ~8 minutes on a single call — fine for the
// main tool-calling loop (no fallback exists there), but classifiers
// (classifyThemes, assessFitBatch, extractChecklist) are all explicitly
// "never throws, degrade to a heuristic" by design, so there's no reason
// one slow/stuck LLM call should block the caller anywhere near that long.
// Live-caught: a stuck classifyThemes call during the onboarding scan left
// a Slack live stream open with no updates for 6-8+ minutes, which Slack's
// client eventually surfaced as an errored/expired stream — the fallback
// path existed, it just never got a chance to run in time. Race a hard
// deadline against the real call; the loser is abandoned (its eventual
// result/rejection is swallowed), never awaited by the caller.
export async function completeWithDeadline(fn, ms) {
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), ms); });
  try {
    return await Promise.race([fn().catch((e) => { console.warn('[llm] deadline race: call failed —', e?.message ?? e); return undefined; }), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
