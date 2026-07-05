import { db } from './db.js';
import { MODEL } from '../agent/llm.js';

function configuredPricing() {
  const input = Number(process.env.LLM_INPUT_COST_PER_1M ?? process.env.MINIMAX_INPUT_COST_PER_1M);
  const output = Number(process.env.LLM_OUTPUT_COST_PER_1M ?? process.env.MINIMAX_OUTPUT_COST_PER_1M);
  if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
    return { input: input / 1_000_000, output: output / 1_000_000 };
  }
  return null;
}

function pricingFor(model) {
  const configured = configuredPricing();
  if (configured) return configured;
  const key = String(model ?? '').toLowerCase();
  // Keep costs null unless pricing is explicitly configured. This app is run
  // against OpenAI-compatible providers, including MiniMax; provider pricing
  // changes too often to bake in guesses.
  if (key.includes('minimax') || key.includes('mini-max')) return null;
  return null;
}

export function estimateCostUsd(model, inputTokens, outputTokens) {
  const p = pricingFor(model);
  if (!p || inputTokens == null || outputTokens == null) return null;
  return Number((inputTokens * p.input + outputTokens * p.output).toFixed(6));
}

export function classifyError(e) {
  const msg = String(e?.data?.error ?? e?.code ?? e?.message ?? e ?? '').toLowerCase();
  if (/timeout|timed? out|etimedout/.test(msg)) return 'timeout';
  if (/slack|channel_not_found|invalid_auth|not_in_channel/.test(msg)) return 'slack_api_error';
  if (/tool/.test(msg)) return 'tool_error';
  if (/validation|invalid|schema/.test(msg)) return 'validation_error';
  if (/openai|model|llm|rate_limit/.test(msg)) return 'llm_error';
  return 'unknown';
}

export function sanitizeErrorMessage(e) {
  return String(e?.data?.error ?? e?.message ?? e ?? 'unknown')
    .replace(/https:\/\/[^\s)]+\/archives\/[^\s)]+/g, '[slack-link]')
    .replace(/<@[A-Z0-9]+>/g, '<@user>')
    .slice(0, 300);
}

export async function createRunTracker(ctx, agentId) {
  const started = Date.now();
  const tools = [];
  const channels = new Set();
  const artifacts = [];
  let input = 0, output = 0, retries = 0;
  const row = await db.startAgentRun({
    teamId: ctx.teamId, userId: ctx.userId, channelId: ctx.channelId,
    threadTs: ctx.surface === 'dm' ? '' : (ctx.threadTs ?? ctx.messageTs ?? ''),
    surface: ctx.surface, agentId, requestMessageTs: ctx.messageTs, model: MODEL,
  });
  const tracker = {
    id: row.id,
    recordToolCall(name) { if (name) tools.push(name); },
    recordChannelsAccessed(ids = []) { ids.filter(Boolean).forEach((id) => channels.add(id)); },
    recordArtifact(a) { if (a) artifacts.push(a); },
    recordUsage(usage = {}) {
      input += usage.prompt_tokens ?? usage.input_tokens ?? 0;
      output += usage.completion_tokens ?? usage.output_tokens ?? 0;
      retries += usage.retry_attempts ?? 0;
    },
    async finishSuccess(extra = {}) { await finish('success', extra); },
    async finishPartial(extra = {}) { await finish('partial', extra); },
    async finishFailure(e, extra = {}) { await finish('failure', { ...extra, error_type: classifyError(e), error_message: sanitizeErrorMessage(e) }); },
  };
  async function finish(status, extra = {}) {
    const latency = Date.now() - started;
    const total = input + output || null;
    const cost = estimateCostUsd(MODEL, input || null, output || null);
    await db.finishAgentRun(row.id, {
      status, total_latency_ms: latency, tools_called: tools, retry_attempts: retries,
      input_tokens: input || null, output_tokens: output || null, total_tokens: total,
      estimated_cost_usd: cost, token_efficiency: input && output ? output / input : null,
      channels_accessed: [...channels], artifacts, ...extra,
    });
    await maybeWarn({ ctx, runId: row.id, latency, total, cost, tools: tools.length });
  }
  return tracker;
}

async function maybeWarn({ ctx, runId, latency, total, cost, tools }) {
  const warnMs = Number(process.env.RUNAWAY_TURN_MS_WARN ?? 120000);
  const warnTokens = Number(process.env.RUNAWAY_TOTAL_TOKENS_WARN ?? 50000);
  const warnCost = Number(process.env.RUNAWAY_EST_COST_WARN_USD ?? 1);
  const warnTools = Number(process.env.RUNAWAY_TOOL_CALLS_WARN ?? 12);
  const reasons = [];
  if (latency > warnMs) reasons.push('latency');
  if (total && total > warnTokens) reasons.push('tokens');
  if (cost && cost > warnCost) reasons.push('cost');
  if (tools > warnTools) reasons.push('tool_calls');
  if (!reasons.length) return;
  await db.logAuditEvent({
    teamId: ctx.teamId, userId: ctx.userId, runId, eventType: 'runaway_warning',
    subjectType: 'agent_run', subjectId: String(runId), metadata: { reasons, latency, total, cost, tools },
  }).catch(() => {});
  if (process.env.OPS_ALERT_CHANNEL && ctx.client) {
    await ctx.client.chat.postMessage({
      channel: process.env.OPS_ALERT_CHANNEL,
      text: `Grantweaver run ${runId} crossed warning threshold: ${reasons.join(', ')}`,
    }).catch(() => {});
  }
}
