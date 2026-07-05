import { NON_CONTENT_SUBTYPES } from '../services/scan.js';

// Agent turns are otherwise stateless: a follow-up like "the OJJDP one
// please, draft it now" arrives with zero memory of what a prior turn found.
// Both fns pull a short window of history transiently, in-prompt, for one
// turn only — nothing here is ever written to our DB; it's re-fetched from
// Slack fresh on every turn.
const HISTORY_TURNS = 6;

// Our own grant/pipeline cards (grantCardV2, pipelineCard, etc.) are posted
// with a bare `text: o.title` and the real content — synopsis, stage,
// crucially the opp_id — living only in `blocks`. Reading `m.text` alone
// meant a card's own history entry was just its title, so a reply like
// "move this to submitted" in that thread gave the model no opp_id to act
// on at all (live-reported: threads under a surfaced grant seemed
// "context-blind"). Pull the section/context text back out of blocks, and
// surface any opp_id embedded in button/select/overflow values so the model
// can resolve "this one" to a real record.
function extractOppIds(blocks) {
  const ids = new Set();
  for (const b of blocks ?? []) {
    for (const el of b.elements ?? []) {
      for (const src of [el, ...(el.options ?? [])]) {
        if (!src.value) continue;
        try { const v = JSON.parse(src.value); if (v.o) ids.add(String(v.o)); } catch { /* not JSON */ }
      }
    }
  }
  return [...ids];
}

function fullText(m) {
  const bits = [];
  for (const b of m.blocks ?? []) {
    if (b.text?.text) bits.push(b.text.text);
    for (const el of b.elements ?? []) if (el.type !== 'button' && el.type !== 'overflow' && el.text?.text) bits.push(el.text.text);
  }
  const text = bits.join('\n') || m.text || '';
  const oppIds = extractOppIds(m.blocks);
  return oppIds.length ? `${text}\n[opportunity id(s) in this card: ${oppIds.join(', ')} — use these with the pipeline tool if the user refers to "this one"]` : text;
}
const hasContent = (m) => Boolean(m.text) || Boolean(m.blocks?.length);

// Live-caught (same root cause as scan.js's collectChannelEvidence): every
// message a persona-seeder app posts (username/icon_url override) arrives
// with subtype:'bot_message' — blanket-excluding ANY subtyped message made
// entire seeded/relayed conversations invisible as agent context, not just
// genuine system noise (channel_join, topic changes, etc).
const isNoise = (m) => m.subtype && NON_CONTENT_SUBTYPES.has(m.subtype);

export async function fetchRecentHistory(client, channelId, botUserId, currentTs) {
  const { messages = [] } = await client.conversations.history({
    channel: channelId,
    limit: HISTORY_TURNS + 1,
  });
  return messages
    .filter((m) => !isNoise(m) && hasContent(m) && m.ts !== currentTs) // drop the just-arrived message itself
    .slice(0, HISTORY_TURNS) // Slack returns newest-first
    .reverse()
    .map((m) => ({ role: botUserId && m.user === botUserId ? 'assistant' : 'user', content: fullText(m) }));
}

// Thread history for app_mention turns. Multiple people can speak in one
// thread, so user messages are prefixed <@id>: so the model can track who
// asked what.
export async function fetchThreadHistory(client, channelId, threadTs, botUserId, currentTs, cap = 12) {
  const { messages = [] } = await client.conversations.replies({
    channel: channelId, ts: threadTs, limit: cap + 1,
  });
  return messages
    .filter((m) => !isNoise(m) && hasContent(m) && m.ts !== currentTs)
    .slice(-cap) // conversations.replies returns oldest-first
    .map((m) => ({
      role: m.user === botUserId ? 'assistant' : 'user',
      // Persona-seeded messages (bot_message subtype) have no m.user —
      // fall back to the username override so the speaker is still
      // attributed instead of rendering as "<@undefined>:".
      content: m.user === botUserId ? fullText(m) : `${m.user ? `<@${m.user}>` : (m.username ?? 'teammate')}: ${m.text ?? ''}`,
    }));
}
