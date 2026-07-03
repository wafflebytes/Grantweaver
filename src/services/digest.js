import { db } from './db.js';
import { grantsGov } from '../mcp/grantsgov-client.js';
import { grantCard } from '../surfaces/blocks.js';

export async function postDigestNow(client, teamId) {
  const org = await db.getOrg(teamId);
  if (!org?.digest_channel) return { skipped: 'no digest channel' };

  const keyword = org.focus_areas?.[0] ?? org.mission?.split(' ').slice(0, 5).join(' ') ?? 'community';
  const raw = await grantsGov.search({ keyword, oppStatuses: 'posted', rows: 6 }).catch(() => []);
  const known = new Set((await db.listOpportunities(teamId)).map((o) => o.opp_id));
  const fresh = raw.filter((o) => !known.has(String(o.opp_id))).slice(0, 3);

  const opps = await db.listOpportunities(teamId);
  const soon = opps.filter((o) => o.close_date
    && !['awarded', 'declined'].includes(o.stage)
    && (new Date(o.close_date) - Date.now()) / 86400000 <= 14);
  const evid = await db.listEvidence(teamId, 5);

  await client.chat.postMessage({
    channel: org.digest_channel,
    text: `Grantweaver weekly: ${fresh.length} new matches, ${soon.length} deadlines within 14 days`,
    unfurl_links: false,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🧶 Grantweaver weekly' } },
      { type: 'context', elements: [{ type: 'mrkdwn',
        text: `*${fresh.length}* new matches · *${soon.length}* deadlines <14 days · *${evid.length}* recent evidence items` }] },
      ...fresh.flatMap((m) => grantCard(m)),
      ...(soon.length ? [{ type: 'section', text: { type: 'mrkdwn',
        text: '*⏰ Deadlines:*\n' + soon.map((o) => {
          const days = Math.ceil((new Date(o.close_date) - Date.now()) / 86400000);
          return `• ${days < 7 ? '🔴' : '🟡'} *${o.title}* — ${days} days (${o.stage})`;
        }).join('\n') } }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn',
        text: `React :${org.evidence_emoji ?? 'thread'}: on any impactful message to save it as evidence · frequency in ⚙️ Settings` }] },
    ],
  });
  return { posted: true, matches: fresh.length };
}
