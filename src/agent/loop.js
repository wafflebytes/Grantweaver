import OpenAI from 'openai';
import { buildToolbelt, TOOL_SCHEMAS } from './tools.js';
import { SYSTEM_PROMPT, renderOrgContext } from '../prompts/system.js';
import { buildFeedbackBlocks } from '../surfaces/blocks.js';
import { db } from '../services/db.js';

// Lazy client: constructing OpenAI() eagerly would require LLM_API_KEY at
// import time, which breaks pure-function unit tests (chunkMarkdown, etc.)
// that never call the LLM.
let llm;
function getLlm() {
  llm ??= new OpenAI({
    apiKey: process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL, // Gemini compat / NVIDIA NIM / OpenRouter / Ollama
  });
  return llm;
}
const MODEL = process.env.LLM_MODEL ?? 'gemini-2.5-flash';
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 4000);
const MAX_TURNS = 8;

// TOOL_SCHEMAS stay in our internal {name, description, input_schema} shape;
// adapt once here to the OpenAI function-tool wire format.
const OPENAI_TOOLS = TOOL_SCHEMAS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

export async function runAgentTurn(ctx) {
  const org = ctx.teamId ? await db.getOrg(ctx.teamId) : null;
  const pipeline = ctx.teamId ? await db.listOpportunities(ctx.teamId) : [];
  const evidenceCount = ctx.teamId ? await db.countEvidence(ctx.teamId) : 0;

  const toolbelt = buildToolbelt(ctx);
  const system = SYSTEM_PROMPT + renderOrgContext({ org, pipeline, evidenceCount, contextChannelId: ctx.contextChannelId });
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: ctx.userText },
  ];

  let toolCalls = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await withRetry(() =>
      getLlm().chat.completions.create({
        model: MODEL, max_tokens: MAX_TOKENS, temperature: 0.2,
        tools: OPENAI_TOOLS, messages,
      })
    );

    const msg = response.choices[0].message;
    const toolUses = msg.tool_calls ?? [];

    if (toolUses.length === 0) {
      const finalText = (msg.content ?? '').trim()
        || 'Done! Anything else I can weave for you? 🧶';
      const streamer = ctx.makeStreamer();
      for (const chunk of chunkMarkdown(finalText, 400)) {
        await streamer.append({ markdown_text: chunk });
      }
      await streamer.stop({ blocks: buildFeedbackBlocks() });
      return { title: inferTitle(ctx.userText), toolCalls };
    }

    messages.push(msg);
    for (const tu of toolUses) {
      toolCalls++;
      let result;
      try {
        const exec = toolbelt[tu.function.name];
        const input = JSON.parse(tu.function.arguments || '{}');
        result = exec ? await exec(input) : { error: `Unknown tool ${tu.function.name}` };
      } catch (e) {
        console.error(`[tool:${tu.function?.name}]`, e?.message ?? e);
        result = { error: `Tool "${tu.function?.name}" failed: ${e?.message ?? 'unknown error'}. Explain this gracefully to the user and offer a retry or an alternative path.` };
      }
      messages.push({
        role: 'tool',
        tool_call_id: tu.id,
        content: safeJson(result, 30000),
      });
    }
  }

  const streamer = ctx.makeStreamer();
  await streamer.append({ markdown_text: "That one took more steps than I allow myself 🧶 — here's where I got to. Say *continue* and I'll pick it right up." });
  await streamer.stop({ blocks: buildFeedbackBlocks() });
  return { title: inferTitle(ctx.userText), toolCalls };
}

async function withRetry(fn, attempts = 3) {
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

function safeJson(obj, cap) {
  try { const s = JSON.stringify(obj); return s.length > cap ? s.slice(0, cap) + '…(truncated)' : s; }
  catch { return String(obj).slice(0, cap); }
}

export function chunkMarkdown(text, size) {
  const out = []; let buf = '';
  for (const line of text.split('\n')) {
    if (buf && (buf + line).length > size) { out.push(buf); buf = ''; }
    buf += line + '\n';
  }
  if (buf.trim()) out.push(buf);
  return out.length ? out : [text];
}

export function inferTitle(text) {
  const t = (text ?? '').trim().replace(/\s+/g, ' ');
  return t.length > 48 ? `${t.slice(0, 45)}…` : t || 'Grantweaver chat';
}
