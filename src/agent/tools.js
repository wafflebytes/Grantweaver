import { searchWorkspace, detectSearchMode, expandKeywordQuery } from './rts.js';
import { grantsGov } from '../mcp/grantsgov-client.js';
import { db } from '../services/db.js';
import { createDraftCanvas } from '../services/canvas.js';
import { syncOpportunityToList } from '../services/lists.js';
import { grantCard, evidenceCard, draftReadyBlocks } from '../surfaces/blocks.js';

export const TOOL_SCHEMAS = [
  {
    name: 'search_workspace',
    description:
      "Search this Slack workspace's messages and files in REAL TIME via Slack's Real-Time Search API. Use for impact evidence: program results, metrics, beneficiary stories, testimonials, photos. Returns snippets with author, channel, date, permalink. Results are ephemeral — cite permalinks; never claim to remember content across sessions.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Natural-language question (semantic mode) or keyword query (keyword mode). Examples: 'How did mentee attendance change this spring?' / 'attendance OR GPA OR outcomes OR survey'" },
        content_types: { type: 'string', enum: ['messages', 'files'], default: 'messages' },
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
    description: 'Create a Slack Canvas with a complete grant document draft (LOI, proposal section, funder report) and share it into this thread. markdown must be the FULL document with inline [source](permalink) citations, following the drafting skeleton. Links canvas to a pipeline opportunity when opp_id given.',
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
];

export function buildToolbelt(ctx) {
  const { client, teamId, channelId, threadTs, actionToken, contextChannelId, userId } = ctx;
  const say = (payload) =>
    client.chat.postMessage({ channel: channelId, thread_ts: threadTs, ...payload });

  return {
    async search_workspace({ query, content_types = 'messages', tag_hint = 'story' }) {
      const mode = await detectSearchMode(client, teamId);
      const q = mode === 'keyword' ? expandKeywordQuery(query) : query;
      const results = await searchWorkspace(client, {
        query: q, contentTypes: content_types, actionToken, contextChannelId,
      });
      // Cards are always posted when there are hits — F5: the model must not be
      // able to narrate strong evidence in prose only; permalink cards are the
      // demo's "not a wrapper" proof and have to land on screen every time.
      for (const ev of results.slice(0, 4)) {
        await say({ text: `Evidence: ${ev.snippet.slice(0, 80)}`, blocks: evidenceCard({ ...ev, tag: tag_hint }) });
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
      const scored = opps.map((o) => ({ ...o, ...scoreMatch(o, org) }))
        .sort((a, b) => b.match_score - a.match_score);
      if (render_cards) {
        for (const o of scored.slice(0, 3)) await say({ text: o.title, blocks: grantCard(o) });
      }
      return { count: scored.length, opportunities: scored.slice(0, rows) };
    },

    async get_opportunity_details({ opp_id }) {
      return grantsGov.fetchOpportunity(opp_id);
    },

    async pipeline({ action, opp, opp_id, stage }) {
      if (!teamId) return { error: 'No team context' };
      if (action === 'list') return { pipeline: await db.listOpportunities(teamId) };
      if (action === 'add') {
        if (!opp?.opp_id || !opp?.title) return { error: 'add requires opp.opp_id and opp.title' };
        await db.addOpportunity(teamId, { ...opp, added_by: userId });
        syncOpportunityToList(client, teamId, { ...opp, stage: 'reviewing' }).catch(() => {});
        return { ok: true, added: opp.title, stage: 'reviewing' };
      }
      if (action === 'move') {
        await db.moveOpportunity(teamId, opp_id, stage);
        const moved = (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(opp_id));
        if (moved) syncOpportunityToList(client, teamId, moved).catch(() => {});
        return { ok: true, opp_id, stage };
      }
      return { error: `unknown action ${action}` };
    },

    async evidence_locker({ action, channel_id, message_ts, permalink, tag = 'story' }) {
      if (!teamId) return { error: 'No team context' };
      if (action === 'list') return { pointers: await db.listEvidence(teamId) };
      if (!channel_id || !message_ts) return { error: 'save requires channel_id and message_ts' };
      await db.saveEvidence(teamId, { channel_id, message_ts, permalink: permalink ?? '', tag, saved_by: userId });
      return { ok: true, note: 'Pointer saved (permalink + tag only — no content stored).' };
    },

    async create_draft_canvas({ title, markdown, opp_id }) {
      const citations = (markdown.match(/\]\(https?:\/\/[^)]*archives[^)]*\)/g) ?? []).length;
      const { canvasId, canvasUrl } = await createDraftCanvas(client, { title, markdown, channelId, userId });
      if (opp_id && teamId) await db.attachCanvas(teamId, opp_id, canvasId);
      await say({ text: `📄 Draft ready: ${title}`, blocks: draftReadyBlocks({ title, canvasUrl, citations }) });
      return { ok: true, canvas_url: canvasUrl, cited_sources: citations };
    },
  };
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
