// COMPLIANCE: results from this module are NEVER persisted. Render + reason only.
// If you find yourself writing these results to db.js, stop — that breaks the
// product's zero-retention guarantee for workspace content.

const capabilityCache = new Map(); // teamId -> 'semantic' | 'keyword'

export async function detectSearchMode(client, teamId) {
  if (!teamId) return 'keyword';
  if (capabilityCache.has(teamId)) return capabilityCache.get(teamId);
  try {
    const info = await client.apiCall('assistant.search.info', {});
    const mode = info?.is_ai_search_enabled ? 'semantic' : 'keyword';
    capabilityCache.set(teamId, mode);
    console.log(`[rts] team ${teamId} search mode: ${mode}`);
    return mode;
  } catch (e) {
    console.warn('[rts] search.info failed, assuming keyword:', e?.data?.error ?? e?.message);
    return 'keyword';
  }
}

/** Keyword-mode helper: expand a natural question into OR'd keyword groups. */
const SYNONYMS = {
  attendance: ['attendance', 'showed up', 'show-up', 'absent'],
  outcomes:   ['outcomes', 'results', 'improved', 'impact', 'wins'],
  metrics:    ['metrics', 'numbers', 'data', 'survey', '%', 'percent'],
  testimonial:['testimonial', 'quote', 'said', 'told us', 'thank'],
  students:   ['students', 'mentees', 'kids', 'youth', 'participants'],
  grades:     ['GPA', 'grades', 'honor roll', 'report card'],
};

export function expandKeywordQuery(query) {
  const q = query.toLowerCase();
  const groups = new Set();
  for (const [key, words] of Object.entries(SYNONYMS)) {
    if (words.some((w) => q.includes(w.toLowerCase())) || q.includes(key)) {
      words.slice(0, 3).forEach((w) => groups.add(w));
    }
  }
  // Always keep the 3 most meaningful original words
  q.split(/\W+/).filter((w) => w.length > 4).slice(0, 3).forEach((w) => groups.add(w));
  return [...groups].join(' OR ') || query;
}

/** Maps the real assistant.search.context response shape (12 §5) into our card shape. */
export function normalizeRtsResult(res) {
  const messages = res?.results?.messages ?? [];
  const files = res?.results?.files ?? [];
  const fromMessages = messages.map((m) => ({
    kind: 'message',
    snippet: String(m.content ?? '').slice(0, 400),
    author: m.author_name ?? 'teammate',
    author_is_bot: !!m.is_author_bot,
    channel_id: m.channel_id ?? '',
    channel_name: m.channel_name ?? '',
    date: m.message_ts ? new Date(Number(String(m.message_ts).split('.')[0]) * 1000).toISOString().slice(0, 10) : '',
    permalink: m.permalink ?? '',
    message_ts: m.message_ts ?? '',
  }));
  const fromFiles = files.map((f) => ({
    kind: 'file',
    snippet: String(f.content ?? f.title ?? '').slice(0, 400),
    author: f.title ?? 'file',
    author_is_bot: false,
    channel_id: '',
    channel_name: '',
    date: '',
    permalink: f.permalink ?? '',
    message_ts: '',
  }));
  return [...fromMessages, ...fromFiles].filter((r) => r.snippet);
}

export async function searchWorkspace(client, {
  query, contentTypes = 'messages', actionToken, contextChannelId, limit = 10,
}) {
  const params = {
    query,
    content_types: [contentTypes],       // live API: array, not string
    channel_types: ['public_channel'],   // live API: array; MVP scope = bot-token public channels
    include_bots: true,                  // seed messages are bot-authored (08 §3)
    limit: Math.min(limit, 20),          // live API caps at 20
    ...(actionToken ? { action_token: actionToken } : {}),
    ...(contextChannelId ? { context_channel_id: contextChannelId } : {}),
  };
  let res;
  try {
    res = await client.apiCall('assistant.search.context', params);
  } catch (e) {
    const err = e?.data?.error ?? e?.message;
    console.error('[rts] search.context failed:', err);
    throw new Error(`Workspace search unavailable (${err}). Tell the user you couldn't search just now and offer to retry.`);
  }
  return normalizeRtsResult(res);
}
