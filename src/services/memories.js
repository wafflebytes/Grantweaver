// Weekly "memories" recap — a #memories channel gets a narrative highlight
// reel of what the agent actually did, distinct from the digest (new
// matches) and deadline nudges (what's due). This is the "the agent has
// been alive and working all week" surface: a human reads it and feels the
// pipeline moving even on weeks they didn't touch Slack themselves.
import { db } from './db.js';

const KIND_VERBS = {
  stage_move: (a) => `moved *${a.title ?? a.opp_id}* → _${a.summary.match(/→ ([a-z]+)/i)?.[1] ?? 'a new stage'}_`,
  draft: (a) => `wrote a fresh draft for *${a.title ?? a.opp_id}* (${a.summary})`,
  revision: (a) => `revised *${a.title ?? a.opp_id}*'s draft from thread feedback`,
  list_edit: (a) => `picked up a manual List edit on *${a.title ?? a.opp_id}*`,
};

function narrateActivity(rows) {
  return rows
    .filter((a) => KIND_VERBS[a.kind])
    .slice(0, 12)
    .map((a) => `• ${KIND_VERBS[a.kind](a)}`);
}

export async function buildMemoriesRecap(teamId, sinceDays = 7) {
  const [activity, evidenceCount, pipeline] = await Promise.all([
    db.listRecentActivity(teamId, sinceDays),
    db.countEvidenceSince(teamId, sinceDays),
    db.listOpportunities(teamId),
  ]);
  const lines = narrateActivity(activity);
  const upcoming = pipeline
    .filter((o) => o.close_date && !['submitted', 'awarded', 'declined'].includes(o.stage))
    .filter((o) => { const days = Math.ceil((new Date(o.close_date) - Date.now()) / 86400000); return days >= 0 && days <= 14; });

  const header = `🧶 *This week's memories*`;
  const body = lines.length
    ? lines.join('\n')
    : "_A quiet week on the pipeline — no stage moves or drafts. I'm still watching for new grants and evidence in the background._";
  const evidenceLine = evidenceCount > 0
    ? `📌 ${evidenceCount} new evidence pointer${evidenceCount === 1 ? '' : 's'} saved this week.`
    : null;
  const upcomingLine = upcoming.length
    ? `⏰ Coming up in the next 2 weeks: ${upcoming.map((o) => `*${o.title}* (${o.close_date instanceof Date ? o.close_date.toISOString().slice(0, 10) : o.close_date})`).join(', ')}.`
    : null;

  return {
    text: `${header}\n${body}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${header}\n${body}` } },
      ...(evidenceLine || upcomingLine
        ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: [evidenceLine, upcomingLine].filter(Boolean).join('  ·  ') }] }]
        : []),
    ],
  };
}

export async function postMemoriesRecap(client, teamId) {
  const org = await db.getOrg(teamId);
  if (!org?.memories_channel) return { posted: false, reason: 'no_channel' };
  const recap = await buildMemoriesRecap(teamId);
  await client.chat.postMessage({ channel: org.memories_channel, text: recap.text, blocks: recap.blocks });
  return { posted: true };
}
