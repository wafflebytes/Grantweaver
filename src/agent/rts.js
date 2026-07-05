// COMPLIANCE: results from this module are NEVER persisted. Render + reason only.
// If you find yourself writing these results to db.js, stop — that breaks the
// product's zero-retention guarantee for workspace content.

const capabilityCache = new Map(); // teamId -> 'semantic' | 'keyword'

// assistant.search.context has no "exclude archived" param and happily
// returns hits from archived channels (e.g. clean-slate's renamed
// "#general-old-jul4") — those are dead history, never real evidence.
// Cache each team's archived-channel set briefly rather than calling
// conversations.list on every search.
const archivedCache = new Map(); // teamId -> { ids: Set<string>, at: number }
const ARCHIVED_TTL_MS = 5 * 60 * 1000;

async function getArchivedChannelIds(client, teamId) {
  if (!teamId) return new Set();
  const cached = archivedCache.get(teamId);
  if (cached && Date.now() - cached.at < ARCHIVED_TTL_MS) return cached.ids;
  const ids = new Set();
  try {
    let cursor;
    do {
      const res = await client.conversations.list({
        types: 'public_channel', exclude_archived: false, limit: 200, cursor,
      });
      for (const c of res.channels ?? []) if (c.is_archived) ids.add(c.id);
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
  } catch (e) {
    console.warn('[rts] failed to list archived channels:', e?.data?.error ?? e?.message);
  }
  archivedCache.set(teamId, { ids, at: Date.now() });
  return ids;
}

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

/** Maps the real assistant.search.context response shape into our card shape. */
export function normalizeRtsResult(res) {
  const messages = res?.results?.messages ?? [];
  const files = res?.results?.files ?? [];
  const fromMessages = messages.map((m) => ({
    kind: 'message',
    snippet: String(m.content ?? '').slice(0, 400),
    author: m.author_name ?? 'teammate',
    author_user_id: m.author_user_id ?? '',
    author_is_bot: !!m.is_author_bot,
    channel_id: m.channel_id ?? '',
    channel_name: m.channel_name ?? '',
    date: m.message_ts ? new Date(Number(String(m.message_ts).split('.')[0]) * 1000).toISOString().slice(0, 10) : '',
    permalink: m.permalink ?? '',
    message_ts: m.message_ts ?? '',
  }));
  // Slack represents Lists and Canvases as file-type objects too — they are
  // structural workspace artifacts, never raw program evidence, so exclude
  // them before they can get card-ified as if they were a saved quote/photo.
  const NON_EVIDENCE_FILETYPES = new Set(['list', 'canvas', 'quip']);
  const fromFiles = files
    .filter((f) => !NON_EVIDENCE_FILETYPES.has(f.filetype))
    .map((f) => ({
      kind: 'file',
      // f.content (extracted file text) isn't always populated by Slack's
      // search index — when it's missing, say so explicitly rather than
      // silently substituting the filename as if it were a quoted excerpt.
      snippet: f.content ? String(f.content).slice(0, 400) : `📎 ${f.title || 'file'} (no extracted text available — open the file to review)`,
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
  query, contentTypes = ['messages', 'files'], actionToken, contextChannelId, limit = 10, teamId,
}) {
  const params = {
    query,
    // live API: array, not string — search both messages and files by
    // default in one call, since nothing upstream reliably asks for files
    // on its own and file-backed evidence (attendance sheets, board PDFs)
    // would otherwise never surface.
    content_types: Array.isArray(contentTypes) ? contentTypes : [contentTypes],
    channel_types: ['public_channel'],   // live API: array; MVP scope = bot-token public channels
    include_bots: true,                  // demo seed messages are bot-authored
    limit: Math.min(limit, 20),          // live API caps at 20
    ...(actionToken ? { action_token: actionToken } : {}),
    ...(contextChannelId ? { context_channel_id: contextChannelId } : {}),
  };
  let res;
  const callStart = Date.now();
  try {
    res = await client.apiCall('assistant.search.context', params);
    console.log(`[diag] search.context ok in ${Date.now() - callStart}ms`);
  } catch (e) {
    console.log(`[diag] search.context threw after ${Date.now() - callStart}ms`);
    const err = e?.data?.error ?? e?.message;
    console.error('[rts] search.context failed:', err);
    throw new Error(`Workspace search unavailable (${err}). Tell the user you couldn't search just now and offer to retry.`);
  }
  const results = normalizeRtsResult(res);
  const archived = await getArchivedChannelIds(client, teamId);
  return archived.size ? results.filter((r) => !r.channel_id || !archived.has(r.channel_id)) : results;
}
