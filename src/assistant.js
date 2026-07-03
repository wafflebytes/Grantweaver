// Built on Slack's agent messaging experience (agent_view), not the legacy
// Assistant class / assistant_view. Under agent_view there is no
// assistant_thread_started event and no thread_ts — conversations are plain
// DMs in the app's Messages tab.
import { runAgentTurn } from './agent/loop.js';
import { db } from './services/db.js';

const LOADING = [
  'Searching your workspace threads…',
  'Checking Grants.gov for fresh matches…',
  'Cross-referencing deadlines…',
  'Citing sources — no vibes, only evidence…',
  'Weaving it all together…',
];

const SUGGESTED = [
  { title: 'Find matching grants',   message: 'Find new grants that fit our mission and programs.' },
  { title: 'Gather impact evidence', message: 'What impact evidence do we have from the last 90 days?' },
  { title: "What's due soon?",       message: "What's due in the next 30 days across our grant pipeline?" },
  { title: 'Draft an LOI',           message: 'Draft a letter of intent for our top pipeline opportunity.' },
];

// Per-process de-dupe so a repeat DM-open doesn't re-greet every time.
// onboarding.js owns the real first-touch/org-aware welcome flow.
const greeted = new Set();

export function registerAssistant(app) {
  app.event('app_home_opened', async ({ event, client, context }) => {
    if (event.tab !== 'messages') return;
    try {
      await client.assistant.threads.setSuggestedPrompts({
        channel_id: event.channel,
        title: 'How can I help today?',
        prompts: SUGGESTED,
      });

      if (greeted.has(event.user)) return;
      greeted.add(event.user);

      const org = context.teamId ? await db.getOrg(context.teamId) : null;
      await client.chat.postMessage({
        channel: event.channel,
        text: org?.mission
          ? `Hey! I'm *Grantweaver* 🧶 — grants agent for *${org.org_name ?? 'your org'}*. I find funding, gather cited evidence from this workspace, and draft proposals you can trust. I never copy your data outside Slack.`
          : `Hey! I'm *Grantweaver* 🧶. Quick start: run \`/grantweaver setup\` (60 seconds) so I can match grants to your mission — or just ask me anything below.`,
      });
    } catch (e) { console.error('[app_home_opened]', e); }
  });

  app.message(async ({ message, client, say, sayStream, setStatus, context }) => {
    if (message.channel_type !== 'im' || message.subtype || message.bot_id) return;
    const { channel } = message;
    const t0 = Date.now();
    const eventAgeMs = message.ts ? t0 - Number(message.ts) * 1000 : null;
    console.log(`[diag] handler start, event age ${eventAgeMs}ms (message.ts=${message.ts})`);
    try {
      // Fire-and-forget: setStatus is a Slack API round-trip purely for the
      // loading-indicator UX. Awaiting it here would burn into the
      // action_token's short TTL before the turn (and its evidence prefetch)
      // even starts.
      setStatus({ status: 'Weaving…', loading_messages: LOADING }).catch(() => {});

      // action_token for bot-token RTS calls — top-level on the message event
      // under agent_view (confirmed against a live sandbox message).
      const actionToken = message.action_token;
      if (!actionToken) console.warn('[rts] no action_token on event — RTS bot calls may fail');

      const result = await runAgentTurn({
        client,
        teamId: message.team ?? context.teamId,
        userId: message.user,
        channelId: channel,
        threadTs: undefined,
        contextChannelId: undefined,
        actionToken,
        userText: message.text ?? '',
        makeStreamer: () => sayStream(),
      });

      console.log(`[turn] ${Date.now() - t0}ms tools=${result?.toolCalls ?? 0}`);
    } catch (e) {
      console.error('[userMessage]', e);
      await say({
        text: "Something snagged on my end 🧶 I couldn't finish that. Try again in a moment, or `/grantweaver help`. If it keeps happening, hit Support from my Home tab.",
      });
    } finally {
      await setStatus({ status: '' }).catch(() => {});
    }
  });

  app.action('feedback', async ({ ack, body, client }) => {
    await ack();
    const value = body.actions?.[0]?.value; // 'good-feedback' | 'bad-feedback'
    await db.saveFeedback({
      teamId: body.team?.id, userId: body.user?.id,
      messageTs: body.message?.ts, value,
    }).catch((e) => console.error('[feedback:db]', e));
    await client.chat.postEphemeral({
      channel: body.channel.id, user: body.user.id, thread_ts: body.message?.thread_ts,
      text: value === 'good-feedback'
        ? 'Glad that helped! 🎉 Your feedback tunes my drafting.'
        : 'Thanks — noted. Tip: tell me what was off ("too formal", "wrong program") and I\'ll redo it.',
    }).catch(() => {});
  });
}
