// Agent turns are otherwise stateless: a follow-up like "the OJJDP one
// please, draft it now" arrives with zero memory of what a prior turn found.
// Both fns pull a short window of history transiently, in-prompt, for one
// turn only — nothing here is written to our DB (Class A guard, docs/03
// §3b); it's re-fetched from Slack fresh on every turn.
const HISTORY_TURNS = 6;

export async function fetchRecentHistory(client, channelId, botUserId, currentTs) {
  const { messages = [] } = await client.conversations.history({
    channel: channelId,
    limit: HISTORY_TURNS + 1,
  });
  return messages
    .filter((m) => !m.subtype && m.text && m.ts !== currentTs) // drop the just-arrived message itself
    .slice(0, HISTORY_TURNS) // Slack returns newest-first
    .reverse()
    .map((m) => ({ role: botUserId && m.user === botUserId ? 'assistant' : 'user', content: m.text }));
}

// Thread history for app_mention turns. Multiple people can speak in one
// thread, so user messages are prefixed <@id>: so the model can track who
// asked what (required for the multi-persona demo, docs/27 §1.1).
export async function fetchThreadHistory(client, channelId, threadTs, botUserId, currentTs, cap = 12) {
  const { messages = [] } = await client.conversations.replies({
    channel: channelId, ts: threadTs, limit: cap + 1,
  });
  return messages
    .filter((m) => !m.subtype && m.text && m.ts !== currentTs)
    .slice(-cap) // conversations.replies returns oldest-first
    .map((m) => ({
      role: m.user === botUserId ? 'assistant' : 'user',
      content: m.user === botUserId ? m.text : `<@${m.user}>: ${m.text}`,
    }));
}
