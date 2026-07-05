// The onboarding workspace scan. Zero message content is ever
// persisted here — snippets live only inside this call frame, feed the theme
// classifier's eyes, and die when the function returns. Only labels, counts,
// and permalinks reach db.upsertIndexRow.
import { db } from './db.js';
import { searchWorkspace, detectSearchMode, expandKeywordQuery } from '../agent/rts.js';
import { classifyThemes } from '../prompts/classifiers.js';

const FIXED_PROBES = [
  { label: 'attendance numbers or program metrics', query: 'attendance numbers or program metrics', content_types: ['messages', 'files'] },
  { label: 'testimonial or thank-you from a parent, teacher, or partner', query: 'testimonial or thank-you from a parent, teacher, or partner', content_types: ['messages', 'files'] },
  { label: 'photos or documents from recent program events', query: 'photos or documents from recent program events', content_types: ['messages', 'files'] },
  { label: 'budget or funding discussions', query: 'budget or funding discussions', content_types: 'messages' },
];

/** Deterministic — same org profile always yields the same ≤8 queries, in the same order. */
export function scanQueries(org) {
  const focusAreas = (org?.focus_areas ?? []).slice(0, 4);
  const focusQueries = focusAreas.map((f) => ({
    label: `${f} evidence`,
    query: `What results, numbers, or stories show our ${f} work is working?`,
    content_types: ['messages', 'files'],
  }));
  return [...focusQueries, ...FIXED_PROBES].slice(0, 8);
}

function heuristicStrength(hits) {
  if (hits >= 5) return 'star';
  if (hits >= 2) return 'solid';
  return 'weak';
}

const EVIDENCE_HINT = /\b(\d+[%/ ]|\bpercent\b|\battendance\b|\bgpa\b|\bgrade\b|\baccepted\b|\bcollege\b|\bsurvey\b|\btestimonial\b|\bthank|thanks|grateful|quote|story|impact|outcome|improved|increase|decrease|served|hours|mentees|students|participants|volunteers)\b/i;
const FILE_EVIDENCE_HINT = /\.(pdf|png|jpe?g|csv|xlsx?|docx?)\b/i;

function classifyLocalHit(text, hasFile) {
  const t = String(text ?? '').toLowerCase();
  if (/\b(testimonial|thank|thanks|grateful|quote|parent|teacher)\b/.test(t)) return 'testimonial';
  if (/\b(\d+|percent|attendance|gpa|grade|accepted|survey|served|hours|mentees|students|participants|volunteers|budget|funding)\b/.test(t)) return 'metric';
  if (hasFile) return 'story';
  return 'story';
}

function localQueryLabel(tag, hasFile) {
  if (tag === 'testimonial') return 'testimonial or thank-you from a parent, teacher, or partner';
  if (tag === 'metric') return 'attendance numbers or program metrics';
  if (hasFile) return 'photos or documents from recent program events';
  return 'program stories and impact updates';
}

async function channelName(client, channelId) {
  const info = await client.conversations.info({ channel: channelId }).catch(() => null);
  return info?.channel?.name ?? null;
}

async function permalinkFor(client, channelId, ts) {
  const res = await client.chat.getPermalink({ channel: channelId, message_ts: ts }).catch(() => null);
  return res?.permalink ?? '';
}

async function collectChannelEvidence(client, channelId, limit = 200) {
  const name = await channelName(client, channelId);
  const out = [];
  let cursor;
  do {
    const res = await client.conversations.history({ channel: channelId, limit: Math.min(limit, 200), cursor })
      .catch((e) => {
        console.warn(`[scan] channel history skipped for ${channelId}:`, e?.data?.error ?? e?.message);
        return null;
      });
    if (!res) break;
    for (const m of res.messages ?? []) {
      if (m.subtype && m.subtype !== 'file_share') continue;
      const files = m.files ?? [];
      const fileText = files.map((f) => `${f.title ?? ''} ${f.name ?? ''} ${f.filetype ?? ''}`).join(' ');
      const text = `${m.text ?? ''} ${fileText}`.trim();
      const hasEvidenceFile = files.some((f) => FILE_EVIDENCE_HINT.test(`${f.name ?? ''}.${f.filetype ?? ''}`) || FILE_EVIDENCE_HINT.test(f.title ?? ''));
      if (!EVIDENCE_HINT.test(text) && !hasEvidenceFile) continue;
      const permalink = await permalinkFor(client, channelId, m.ts);
      const tag = classifyLocalHit(text, hasEvidenceFile);
      out.push({
        query_label: localQueryLabel(tag, hasEvidenceFile),
        channel_id: channelId,
        channel_name: name,
        message_ts: m.ts,
        permalink,
        // Transient classifier input only. Never persisted.
        snippet: text.slice(0, 400),
        is_file: hasEvidenceFile,
      });
      for (const f of files) {
        const fileLink = f.permalink ?? permalink;
        if (!fileLink || !hasEvidenceFile) continue;
        out.push({
          query_label: 'photos or documents from recent program events',
          channel_id: channelId,
          channel_name: name,
          message_ts: `${m.ts}:${f.id ?? f.name ?? fileLink}`,
          permalink: fileLink,
          snippet: `${f.title ?? f.name ?? 'file'} ${m.text ?? ''}`.slice(0, 400),
          is_file: true,
        });
      }
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor && out.length < limit);
  return out;
}

/**
 * Runs the ≤8 scan queries against RTS, ≥6.5s apart (RTS rate-limit budget),
 * classifies the transient results into funder-recognizable themes with ONE
 * LLM call, and persists ONLY the index (theme/channel/strength/count/links).
 * Never throws — a classifier failure degrades to a heuristic grouping
 * (theme = query label, strength by hit count) rather than failing the scan.
 */
export async function runWorkspaceScan(client, teamId, streamer, { actionToken } = {}) {
  const org = await db.getOrg(teamId);
  const queries = scanQueries(org);
  const watched = new Set(org?.watched_channels ?? []);
  const excluded = new Set(org?.ai_excluded_channels ?? []);
  const collected = []; // transient: {query_label, channel_id, channel_name, permalink, snippet, is_file}
  const mode = await detectSearchMode(client, teamId);

  if (watched.size) {
    await streamer?.task('Reading selected channels for evidence');
    for (const channelId of watched) {
      if (excluded.has(channelId)) continue;
      collected.push(...await collectChannelEvidence(client, channelId));
    }
  }

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    await streamer?.task(`Scanning for ${q.label}`);
    try {
      const searchQuery = mode === 'keyword' ? expandKeywordQuery(q.query) : q.query;
      const results = await searchWorkspace(client, {
        query: searchQuery, contentTypes: q.content_types, actionToken, limit: 20, teamId,
      });
      const scoped = watched.size
        ? results.filter((r) => !r.channel_id || watched.has(r.channel_id))
        : results;
      for (const r of scoped.filter((r) => !r.channel_id || !excluded.has(r.channel_id))) {
        collected.push({
          query_label: q.label, channel_id: r.channel_id || '', channel_name: r.channel_name || null,
          message_ts: r.message_ts || '', permalink: r.permalink, snippet: r.snippet, is_file: r.kind === 'file',
        });
      }
    } catch (e) {
      console.warn(`[scan] query "${q.label}" failed:`, e?.message ?? e);
    }
    // RTS budget: space calls ≥6.5s apart so a fast run never 429s. Skip the
    // wait after the very last query.
    if (i < queries.length - 1) await new Promise((r) => setTimeout(r, 6500));
  }

  // Same de-dup rationale as search_workspace (tools.js): identical text can
  // legitimately live in more than one channel and RTS returns every copy —
  // without this the evidence index double/triple-counts strength for what
  // is really one piece of evidence.
  const seenSnippets = new Set();
  const deduped = collected.filter((c) => {
    const key = c.permalink || c.snippet?.trim().toLowerCase();
    if (key && seenSnippets.has(key)) return false;
    if (key) seenSnippets.add(key);
    return true;
  });

  let themeRows = await classifyThemes(deduped);
  if (!themeRows || (deduped.length && !themeRows.length)) {
    // Classifier down (or empty) — degrade to a deterministic heuristic
    // grouping so the scan NEVER fails outright.
    const byKey = new Map();
    for (const c of deduped) {
      const key = `${c.query_label}::${c.channel_id}`;
      if (!byKey.has(key)) byKey.set(key, { theme: c.query_label, channel_id: c.channel_id, channel_name: c.channel_name, permalinks: [], has_files: false });
      const row = byKey.get(key);
      if (c.permalink && row.permalinks.length < 5) row.permalinks.push(c.permalink);
      if (c.is_file) row.has_files = true;
      row._hits = (row._hits ?? 0) + 1;
    }
    themeRows = [...byKey.values()].map((r) => ({ ...r, strength: heuristicStrength(r._hits) }));
  }

  await db.clearIndex(teamId);
  const byTheme = new Map();
  for (const row of themeRows) {
    const rowPermalinks = new Set(row.permalinks ?? []);
    const hits = deduped.filter((c) =>
      c.channel_id === row.channel_id
      && (rowPermalinks.has(c.permalink) || c.query_label === row.theme || row.theme === c.query_label)
    ).length
      || rowPermalinks.size
      || 1;
    await db.upsertIndexRow(teamId, {
      theme: row.theme, channel_id: row.channel_id, channel_name: row.channel_name,
      strength: row.strength, hits, permalinks: row.permalinks, has_files: row.has_files,
    });
    if (!byTheme.has(row.theme)) byTheme.set(row.theme, 0);
    byTheme.set(row.theme, byTheme.get(row.theme) + hits);
  }
  await db.markIndexBuilt(teamId);

  return {
    themes: [...byTheme.entries()].map(([theme, hits]) => ({ theme, hits })),
    totalHits: deduped.length,
    channelsCovered: new Set(deduped.map((c) => c.channel_id)).size,
    fileCount: deduped.filter((c) => c.is_file).length,
    pointers: deduped.map((c) => ({
      channel_id: c.channel_id, message_ts: c.message_ts, permalink: c.permalink,
      is_file: c.is_file, tag: scanTag(c.query_label),
    })),
  };
}

function scanTag(label) {
  const l = label.toLowerCase();
  if (l.includes('testimonial') || l.includes('thank-you')) return 'testimonial';
  if (l.includes('metric') || l.includes('attendance') || l.includes('budget') || l.includes('funding')) return 'metric';
  return 'story';
}
