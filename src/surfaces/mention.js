import { runAgentTurn } from '../agent/loop.js';
import { fetchThreadHistory } from '../agent/memory.js';
import { makeThreadStreamer } from '../agent/streamer.js';

const COPY_ERROR_GENERIC = 'Something snagged on my end 🧶 — try that again in a moment, or ask me in a DM.';

// event_id LRU dedupe — Slack event retries must not double-run a turn
// (docs/17 B14). Trimmed at 500 so it never grows unbounded.
const seen = new Set();
function markSeen(id) {
  seen.add(id);
  if (seen.size > 500) {
    const oldest = seen.values().next().value;
    seen.delete(oldest);
  }
}

export function registerMention(app) {
  app.event('app_mention', async ({ event, client, context }) => {
    const eventKey = event.event_id ?? event.ts;
    if (event.user === context.botUserId || seen.has(eventKey)) return;
    markSeen(eventKey);

    const threadTs = event.thread_ts ?? event.ts;
    const userText = (event.text ?? '')
      .replace(new RegExp(`<@${context.botUserId}>\\s*`, 'g'), '')
      .trim();

    try {
      const history = await fetchThreadHistory(client, event.channel, threadTs, context.botUserId, event.ts);
      await runAgentTurn({
        client,
        surface: 'channel',
        teamId: event.team ?? context.teamId,
        userId: event.user,
        channelId: event.channel,
        threadTs,
        contextChannelId: event.channel, // bias evidence search to where the mention happened
        // VERIFY-FIRST (docs/12 §5): unconfirmed whether action_token rides on
        // app_mention the way it does on message.im — if absent, RTS runs in
        // keyword mode without it and the evidence prefetch is skipped
        // (toolbelt.search_workspace tolerates a missing actionToken).
        actionToken: event.action_token,
        messageTs: event.ts,
        botUserId: context.botUserId,
        userText: userText || 'The user mentioned you without a request — read the thread and offer the most useful next step.',
        history,
        makeStreamer: () => makeThreadStreamer({
          client, channel: event.channel, thread_ts: threadTs,
          userId: event.user, teamId: event.team ?? context.teamId,
        }),
      });
    } catch (e) {
      console.error('[mention]', e?.message ?? e);
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: COPY_ERROR_GENERIC })
        .catch(() => {});
    }
  });
}
