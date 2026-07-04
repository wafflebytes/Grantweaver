import { searchWorkspace, detectSearchMode, expandKeywordQuery } from './rts.js';
import { grantsGov } from '../mcp/grantsgov-client.js';
import { db } from '../services/db.js';
import { syncOpportunityToList } from '../services/lists.js';
import { ensureOppCanvas, refreshOverviewAndRequirements } from '../services/canvas.js';
import { grantCardV2, forecastCard, evidenceCardV2, confirmCard } from '../surfaces/cards.js';
import { stashDraftMarkdown } from './intents.js';
import { assessFitBatch, extractChecklist } from '../prompts/classifiers.js';

// Un-added search results don't have a DB row to cache fit on — a short
// in-process TTL map (same spirit as the grantsgov client's own cache) avoids
// re-running the batched classifier every time the same result re-renders in
// one session.
const fitCache = new Map(); // opp_id -> {at, fit}
const FIT_TTL = 10 * 60 * 1000;

async function fitFor(teamId, org, opps) {
  const out = new Map();
  const uncached = [];
  for (const o of opps) {
    const hit = fitCache.get(o.opp_id);
    if (hit && Date.now() - hit.at < FIT_TTL) out.set(o.opp_id, hit.fit);
    else uncached.push(o);
  }
  if (uncached.length && org) {
    const notRelevant = teamId ? await db.listNotRelevant(teamId) : [];
    const details = await Promise.all(uncached.slice(0, 6).map((o) =>
      grantsGov.fetchOpportunity(o.opp_id).catch(() => null)));
    const forFit = uncached.slice(0, 6).map((o, i) => ({
      opp_id: o.opp_id, title: o.title,
      synopsis: details[i]?.synopsis ?? '', eligibility_desc: details[i]?.eligibility ?? '',
      applicant_types: details[i]?.applicant_types ?? [],
    }));
    const results = await assessFitBatch({ ...org, _notRelevant: notRelevant }, forFit);
    for (const r of results) {
      fitCache.set(r.opp_id, { at: Date.now(), fit: r });
      out.set(r.opp_id, r);
    }
  }
  return out;
}

export const TOOL_SCHEMAS = [
  {
    name: 'search_workspace',
    description:
      "Search this Slack workspace's messages and files in REAL TIME via Slack's Real-Time Search API. Use for impact evidence: program results, metrics, beneficiary stories, testimonials, photos. Returns snippets with author, channel, date, permalink. Results are ephemeral — cite permalinks; never claim to remember content across sessions.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Natural-language question (semantic mode) or keyword query (keyword mode). Examples: 'How did mentee attendance change this spring?' / 'attendance OR GPA OR outcomes OR survey'" },
        content_types: { type: 'string', enum: ['messages', 'files', 'both'], default: 'both', description: "Leave as 'both' unless the user explicitly asks to search only messages or only files — evidence (attendance sheets, board PDFs, testimonial photos) is frequently file-backed." },
        tag_hint: { type: 'string', enum: ['metric', 'story', 'testimonial', 'other'], description: 'Expected evidence kind — labels the rendered cards' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_grants',
    description: 'Search live federal funding opportunities on Grants.gov (via the grantsgov MCP server). Build keywords from org mission/focus + user words. Returns opportunities with id, number, title, agency, close date, status, url.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        opp_statuses: { type: 'string', default: 'posted|forecasted' },
        rows: { type: 'integer', default: 8, maximum: 15 },
        render_cards: { type: 'boolean', default: true },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'get_opportunity_details',
    description: 'Fetch full details for one Grants.gov opportunity (synopsis, eligibility, ceiling/floor, dates, contact) by opportunity id. Always call before drafting for an opportunity or answering eligibility questions.',
    input_schema: { type: 'object', properties: { opp_id: { type: 'string' } }, required: ['opp_id'] },
  },
  {
    name: 'pipeline',
    description: "Read or update the org's grant pipeline. actions: list | add (needs opp object) | move (opp_id + stage: suggested|reviewing|drafting|submitted|awarded|declined).",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'move'] },
        opp: { type: 'object', description: 'For add: {opp_id, opp_number, title, agency, close_date, award_ceiling, url}' },
        opp_id: { type: 'string' },
        stage: { type: 'string', enum: ['suggested', 'reviewing', 'drafting', 'submitted', 'awarded', 'declined'] },
        owner_user_id: { type: 'string', description: 'Assign an owner via chat, e.g. "assign the OJJDP one to @maya" — accepted on add/move.' },
        checklist_done: { type: 'array', items: { type: 'string' }, description: 'Checklist item ids to mark complete (e.g. after the user reports progress like "we registered on SAM.gov").' },
      },
      required: ['action'],
    },
  },
  {
    name: 'evidence_locker',
    description: 'List saved evidence POINTERS (permalinks + tags — never content), or save a new pointer from a search_workspace result. To USE evidence in a draft, re-read content live via search_workspace — the locker stores no text.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'save'] },
        channel_id: { type: 'string' }, message_ts: { type: 'string' },
        permalink: { type: 'string' },
        tag: { type: 'string', enum: ['metric', 'story', 'testimonial', 'other'] },
      },
      required: ['action'],
    },
  },
  {
    name: 'create_draft_canvas',
    description:
      "Write a complete grant document draft (LOI, proposal section, funder report) into the opportunity's persistent canvas (Draft section — the canvas already exists per opportunity and is edited in place, never recreated). markdown must be the FULL document with inline [source](permalink) citations. In interactive contexts this queues a confirmation card instead of writing immediately.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        markdown: { type: 'string' },
        opp_id: { type: 'string' },
      },
      required: ['title', 'markdown'],
    },
  },
  {
    name: 'watch',
    description: 'Create, list, or remove standing watches on Grants.gov. A watch alerts the grants channel when new matches appear or a forecasted opportunity opens. actions: add (kind: query|agency|opp + params) | list | remove (watch_id).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'] },
        kind: { type: 'string', enum: ['query', 'agency', 'opp'] },
        keyword: { type: 'string' }, agency: { type: 'string' }, opp_id: { type: 'string' },
        watch_id: { type: 'integer' },
      },
      required: ['action'],
    },
  },
  {
    name: 'request_changes',
    description: "Open (or point to) the revision thread for an opportunity's existing draft so the team can request changes. Use whenever the user wants edits to a draft that already exists. Returns the thread location; changes are applied after the team confirms scope there.",
    input_schema: { type: 'object', properties: { opp_id: { type: 'string' } }, required: ['opp_id'] },
  },
];

export function buildToolbelt(ctx) {
  const { client, teamId, channelId, threadTs, actionToken, contextChannelId, userId } = ctx;
  const say = (payload) =>
    client.chat.postMessage({ channel: channelId, thread_ts: threadTs, ...payload });
  // One turn can run search_workspace more than once (evidence prefetch +
  // the model's own re-search) — remember what's already been carded so the
  // same hit never posts twice in a thread.
  const cardedPermalinks = new Set();

  return {
    async search_workspace({ query, content_types = 'both', tag_hint = 'story' }) {
      const mode = await detectSearchMode(client, teamId);
      const q = mode === 'keyword' ? expandKeywordQuery(query) : query;
      const rawResults = await searchWorkspace(client, {
        query: q, contentTypes: content_types === 'both' ? ['messages', 'files'] : content_types, actionToken, contextChannelId,
      });
      // Messages that are themselves conversations WITH or FROM the bot
      // (mentions, asks, the bot's own replies) aren't evidence — a channel
      // mention otherwise gets its own question (and the bot's last answer)
      // back as top "hits". Note mentions render as <@ID|name>, so match the
      // prefix, not <@ID>. Transient filter, nothing stored.
      const notSelfTalk = rawResults.filter((r) =>
        r.message_ts !== ctx.messageTs
        && !(ctx.botUserId && (
          r.snippet?.includes(`<@${ctx.botUserId}`)
          || r.author_user_id === ctx.botUserId)));
      // The same text can legitimately exist verbatim in more than one
      // channel (an old channel gets renamed/archived and its content
      // re-posted into a fresh one, a message gets copy-pasted, etc.) — RTS
      // has no concept of that and will happily return every copy as a
      // separate "hit". Without this, one real quote can show up as 3-4
      // duplicate evidence cards for a single query, which reads as broken
      // even though each hit is individually real. Keep the first (highest-
      // ranked) copy only.
      const seenText = new Set();
      const results = notSelfTalk.filter((r) => {
        const key = r.snippet?.trim().toLowerCase();
        if (key && seenText.has(key)) return false;
        if (key) seenText.add(key);
        return true;
      });
      // Cards are always posted when there are hits — the model must not be
      // able to narrate strong evidence in prose only; permalink cards are the
      // demo's "not a wrapper" proof and have to land on screen every time.
      const pipeline = teamId ? await db.listOpportunities(teamId) : [];
      for (const ev of results.slice(0, 4)) {
        if (ev.permalink && cardedPermalinks.has(ev.permalink)) continue;
        if (ev.permalink) cardedPermalinks.add(ev.permalink);
        await say({ text: `Evidence: ${ev.snippet.slice(0, 80)}`, blocks: evidenceCardV2({ ...ev, tag: tag_hint }, { pipeline }) });
      }
      return {
        search_mode: mode,
        count: results.length,
        results: results.map((r) => ({
          snippet: r.snippet, author: r.author, channel_id: r.channel_id,
          date: r.date, permalink: r.permalink, message_ts: r.message_ts,
        })),
        note: results.length === 0
          ? 'No matches. Options: (1) retry ONCE with broader OR-terms, (2) tell the user honestly and suggest which channel to post updates in.'
          : undefined,
      };
    },

    async search_grants({ keyword, opp_statuses = 'posted|forecasted', rows = 8, render_cards = true }) {
      const opps = await grantsGov.search({ keyword, oppStatuses: opp_statuses, rows, eligibilities: '12' });
      const org = teamId ? await db.getOrg(teamId) : null;
      const notRelevant = teamId ? await db.listNotRelevant(teamId) : [];
      const rejectedIds = new Set(notRelevant.map((s) => s.subject));
      const visible = opps.filter((o) => !rejectedIds.has(String(o.opp_id)));
      const scored = visible.map((o) => ({ ...o, ...scoreMatch(o, org) }))
        .sort((a, b) => b.match_score - a.match_score);
      const top = scored.slice(0, 6);
      const fitByOpp = await fitFor(teamId, org, top);
      if (render_cards) {
        for (const o of scored.slice(0, 3)) {
          const fit = fitByOpp.get(o.opp_id);
          const isForecast = o.status === 'forecasted';
          await say({ text: o.title, blocks: (isForecast ? forecastCard : grantCardV2)(o, { fit }) });
        }
      }
      return {
        count: scored.filter((o) => o.status !== 'forecasted').length,
        forecast_count: scored.filter((o) => o.status === 'forecasted').length,
        opportunities: scored.slice(0, rows).map((o) => ({ ...o, fit: fitByOpp.get(o.opp_id) ?? null })),
      };
    },

    async get_opportunity_details({ opp_id }) {
      return grantsGov.fetchOpportunity(opp_id);
    },

    async pipeline({ action, opp, opp_id, stage, owner_user_id, checklist_done }) {
      if (!teamId) return { error: 'No team context' };
      if (action === 'list') return { pipeline: await db.listOpportunities(teamId) };
      if (action === 'add') {
        if (!opp?.opp_id || !opp?.title) return { error: 'add requires opp.opp_id and opp.title' };
        await addOpportunityFull(client, teamId, { ...opp, added_by: userId, owner_user_id });
        return { ok: true, added: opp.title, stage: 'reviewing' };
      }
      if (action === 'move') {
        await db.moveOpportunity(teamId, opp_id, stage);
        if (owner_user_id) await db.setOwner(teamId, opp_id, owner_user_id);
        if (checklist_done?.length) {
          for (const id of checklist_done) await db.toggleChecklistItem(teamId, opp_id, id, true);
        }
        const moved = (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(opp_id));
        if (moved) {
          syncOpportunityToList(client, teamId, moved).catch(() => {});
          if (owner_user_id || checklist_done?.length) refreshOverviewAndRequirements(client, teamId, moved).catch(() => {});
        }
        return { ok: true, opp_id, stage };
      }
      return { error: `unknown action ${action}` };
    },

    async watch({ action, kind, keyword, agency, opp_id: watchOppId, watch_id }) {
      if (!teamId) return { error: 'No team context' };
      if (action === 'list') return { watches: await db.listWatches(teamId) };
      if (action === 'remove') {
        await db.removeWatch(teamId, watch_id);
        return { ok: true };
      }
      const params = kind === 'agency' ? { agency } : kind === 'opp' ? { opp_id: watchOppId } : { keyword };
      const watch = await db.addWatch(teamId, { kind: kind ?? 'query', params, created_by: userId });
      return { ok: true, watch };
    },

    async request_changes({ opp_id: revId }) {
      if (!teamId) return { error: 'No team context' };
      const opp = (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(revId));
      if (!opp) return { error: 'Unknown opportunity' };
      const { openRevisionThread } = await import('./revise.js');
      await openRevisionThread(client, { teamId, channel: channelId, thread_ts: threadTs, opp });
      return { ok: true, note: 'Revision thread opened in this conversation — tell the user to describe what should change there.' };
    },

    async evidence_locker({ action, channel_id, message_ts, permalink, tag = 'story' }) {
      if (!teamId) return { error: 'No team context' };
      if (action === 'list') return { pointers: await db.listEvidence(teamId) };
      if (!channel_id || !message_ts) return { error: 'save requires channel_id and message_ts' };
      await db.saveEvidence(teamId, { channel_id, message_ts, permalink: permalink ?? '', tag, saved_by: userId });
      return { ok: true, note: 'Pointer saved (permalink + tag only — no content stored).' };
    },

    // Confirm-before-generate: the model has
    // already written the full draft as this tool call's argument — what's
    // deferred is publishing it. The actual canvas write happens in
    // agent/intents.js's draft executor once the user confirms.
    async create_draft_canvas({ title, markdown, opp_id }) {
      if (!teamId) return { error: 'No team context' };
      const citations = (markdown.match(/\]\(https?:\/\/[^)]*archives[^)]*\)/g) ?? []).length;
      const opp = opp_id ? (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(opp_id)) : null;
      // Class-A guard: the generated markdown can contain verbatim quoted
      // Slack content (citations copy source text exactly) — it must never
      // reach a persisted column. Only opp_id (no message content) goes into
      // the DB row; the actual draft text is stashed in-process (intents.js)
      // for the confirmed executor to pick up.
      const intent = await db.createIntent(teamId, {
        kind: 'draft',
        params: { opp_id: opp_id ?? null },
        requested_by: userId,
        channel_id: channelId,
      });
      stashDraftMarkdown(intent.id, { title, markdown });
      const summary = `${title}${citations ? ` using **${citations} cited workspace source${citations === 1 ? '' : 's'}**` : ''}. I'll write it into ${opp ? `the *${opp.title}*` : 'a new'} opportunity's canvas.`;
      const posted = await say({ text: `Ready to weave: ${title}`, blocks: confirmCard(intent, { summary, etaSeconds: 15 }) });
      await db.setIntentMessage(intent.id, posted.ts);
      return {
        ok: true, queued: true,
        note: 'A confirmation card was posted in this thread. Tell the user in ONE short line that you have lined up the draft and they should confirm on the card above (button or a ✅ reaction) before you continue — do not describe or repeat the draft contents yet.',
      };
    },
  };
}

/**
 * Shared add-to-pipeline path (tools.js `pipeline` add AND actions.js's
 * gw:grant:add button both call this — one place owns fit/checklist/canvas
 * so neither entry point can drift). Never throws — classifier/canvas
 * failures degrade the add, they don't block it.
 */
export async function addOpportunityFull(client, teamId, opp) {
  await db.addOpportunity(teamId, opp);
  if (opp.owner_user_id) await db.setOwner(teamId, opp.opp_id, opp.owner_user_id);
  const org = await db.getOrg(teamId);
  const [details] = await Promise.all([grantsGov.fetchOpportunity(opp.opp_id).catch(() => null)]);
  await Promise.all([
    (async () => {
      const fitByOpp = await fitFor(teamId, org, [{ opp_id: opp.opp_id, title: opp.title }]);
      const fit = fitByOpp.get(opp.opp_id);
      if (fit) await db.setFit(teamId, opp.opp_id, fit);
    })().catch(() => {}),
    (async () => {
      if (!details) return;
      const checklist = await extractChecklist(details);
      if (checklist.length) await db.setChecklist(teamId, opp.opp_id, checklist);
    })().catch(() => {}),
  ]);
  const saved = (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(opp.opp_id));
  await ensureOppCanvas(client, teamId, { ...(saved ?? opp), channelId: opp.channelId, userId: opp.added_by }).catch(() => {});
  const withCanvas = (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(opp.opp_id));
  await syncOpportunityToList(client, teamId, withCanvas ?? saved ?? opp).catch(() => {});
  await db.logActivity(teamId, opp.opp_id, { actor: opp.added_by ?? 'agent', kind: 'note', summary: `Added to pipeline: ${opp.title}` });
  return withCanvas ?? saved;
}

export function scoreMatch(o, org) {
  if (!org?.mission) return { match_score: 0.5, match_reason: 'set up your org profile for sharper matching (`/grantweaver setup`)' };
  const hay = `${o.title} ${o.synopsis ?? ''}`.toLowerCase();
  const focusHits = (org.focus_areas ?? []).filter((f) => hay.includes(f.toLowerCase()));
  const missionWords = (org.mission ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 4);
  const mHits = missionWords.filter((w) => hay.includes(w)).length;
  const score = Math.min(1, 0.3 + focusHits.length * 0.2 + mHits * 0.05);
  return {
    match_score: score,
    match_reason: focusHits.length
      ? `aligns with ${focusHits.map((h) => `\`${h}\``).join(', ')}`
      : 'general fit — review eligibility',
  };
}
