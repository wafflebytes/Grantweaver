// Revision threads: humans discuss changes as plain thread replies (the
// agent is NOT invoked per message — zero LLM burn while a team argues about
// wording); "Apply changes" reads the whole thread once and runs ONE
// completion. Registers the 'revise' intent executor.
import { db } from '../services/db.js';
import { editSections, appendActivity } from '../services/canvas.js';
import { syncOpportunityToList } from '../services/lists.js';
import { completeOnce } from './llm.js';
import { registerIntentExecutor } from './intents.js';

function revisePrompt({ current, requests }) {
  return `You are revising an existing grant draft. Apply the team's change requests
FAITHFULLY — do not rewrite sections nobody asked about.

CURRENT DRAFT (the canvas Draft section):
${current}

CHANGE REQUESTS (from the revision thread, oldest first, speakers tagged):
${requests}

Rules unchanged from your system prompt: citations for every org fact,
numbers copied exactly, [TEAM TO CONFIRM] for anything missing, human-review
footer stays. Output the COMPLETE revised Draft section markdown, then on a
final line after "---DIFF---" list 3-6 bullets of what changed (these are
posted to the team).`;
}

function parseRevision(text) {
  const marker = '---DIFF---';
  const idx = text.indexOf(marker);
  if (idx === -1) return { draft: text.trim(), diff: null };
  return { draft: text.slice(0, idx).trim(), diff: text.slice(idx + marker.length).trim() };
}

function countUnconfirmed(md) {
  return (md.match(/\[TEAM TO CONFIRM\]/g) ?? []).length;
}

/** Posts the revision-thread opener in the given thread. Shared by gw:draft:revise and the request_changes tool. */
export async function openRevisionThread(client, { teamId, channel, thread_ts, opp }) {
  await client.chat.postMessage({
    channel, thread_ts,
    text: "What should change? Tell me here — everyone in this thread can pile on requests. When you're done, hit *Apply changes* and I'll confirm the scope before I touch the draft.",
    blocks: [
      { type: 'section', text: { type: 'mrkdwn',
        text: "What should change? Tell me here — everyone in this thread can pile on requests. When you're done, hit *Apply changes* and I'll confirm the scope before I touch the draft." } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', action_id: 'gw:draft:revise:apply', value: JSON.stringify({ o: String(opp.opp_id) }),
          text: { type: 'plain_text', text: 'Apply changes' }, accessibility_label: `Apply the requested changes to ${opp.title}` },
        { type: 'button', action_id: 'gw:draft:revise:nevermind', value: JSON.stringify({ o: String(opp.opp_id) }),
          text: { type: 'plain_text', text: 'Nevermind' }, accessibility_label: 'Cancel this revision' },
      ] },
    ],
  });
}

registerIntentExecutor('revise', async (client, intent) => {
  const teamId = intent.team_id;
  const { opp_id, thread_channel, thread_ts } = intent.params;
  const post = (text) => client.chat.postMessage({ channel: intent.channel_id, thread_ts: intent.message_ts, text });
  const opp = (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(opp_id));
  if (!opp?.canvas_id) { await post("There's no draft yet for this opportunity to revise."); return; }

  await post('_Reading the thread…_');
  const { messages = [] } = await client.conversations.replies({ channel: thread_channel, ts: thread_ts, limit: 50 });
  const requests = messages
    .filter((m) => !m.subtype && m.text)
    .map((m) => `<@${m.user}>: ${m.text}`)
    .join('\n');

  // Branch B (docs/12 §5): no live read-back of the current Draft section —
  // we ask the model to revise from the LAST version we ourselves wrote,
  // never a version we can't verify; a human-hand-edited Draft since our
  // last write is preserved as-is unless the thread explicitly asks to
  // change what's already there (same caution the branch decision calls for).
  const lastKnownDraft = intent.params.lastDraft
    ?? '_(no cached copy of the current draft — treat the change requests as instructions for a fresh rewrite of the Draft section.)_';

  await post('_Weaving in the changes…_');
  const text = await completeOnce([
    { role: 'user', content: revisePrompt({ current: lastKnownDraft, requests }) },
  ], { maxTokens: 3000 });
  const { draft, diff } = parseRevision(text);

  await editSections(client, opp.canvas_id, { Draft: draft });
  await db.setCanvasWritten(teamId, opp_id);
  await db.logActivity(teamId, opp_id, { actor: intent.requested_by, kind: 'revision', summary: 'Draft revised from thread requests' });
  await appendActivity(client, opp.canvas_id, teamId, opp_id).catch(() => {});
  const updated = (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(opp_id));
  if (updated) syncOpportunityToList(client, teamId, updated).catch(() => {});

  const unconfirmed = countUnconfirmed(draft);
  await client.chat.postMessage({
    channel: intent.channel_id, thread_ts: intent.message_ts,
    text: `🧶 Draft updated — here's what changed:\n${diff ?? '(no summary returned)'}`
      + (unconfirmed ? `\n\n⚠️ ${unconfirmed} spot${unconfirmed === 1 ? '' : 's'} still need${unconfirmed === 1 ? 's' : ''} the team's numbers — reply here with them and hit Apply again.` : ''),
  });
});
