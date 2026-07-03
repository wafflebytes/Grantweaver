// link_shared → chat.unfurl (docs/23 §9). We only unfurl our own domain
// (APP_BASE_URL) — grants.gov unfurls are out, we don't own that domain
// (docs/22 §7). Failures are swallowed; never unfurl in DMs with other apps.
import { verifyOrgToken } from '../services/weblink.js';
import { db } from '../services/db.js';

export function parseOrgToken(url) {
  try {
    const base = new URL(process.env.APP_BASE_URL || 'http://localhost');
    const u = new URL(url);
    if (u.host !== base.host) return null;
    const m = u.pathname.match(/^\/org\/([^/]+)\/?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function registerUnfurl(app) {
  app.event('link_shared', async ({ event, client }) => {
    const unfurls = {};
    for (const link of event.links ?? []) {
      const token = parseOrgToken(link.url);
      if (!token) continue; // unknown path on our domain, or a foreign domain — skip silently
      const verified = verifyOrgToken(token);
      if (!verified) continue;
      try {
        const [org, pipeline] = await Promise.all([db.getOrg(verified.teamId), db.listOpportunities(verified.teamId)]);
        const themeCount = (await db.listIndex(verified.teamId)).length;
        unfurls[link.url] = {
          blocks: [
            { type: 'section', text: { type: 'mrkdwn',
              text: `🧶 *${org?.org_name ?? 'Grantweaver'} — Evidence Index*\n${themeCount} theme${themeCount === 1 ? '' : 's'} indexed · ${pipeline.length} opportunit${pipeline.length === 1 ? 'y' : 'ies'} in the pipeline` } },
            { type: 'context', elements: [{ type: 'mrkdwn', text: 'Ask Grantweaver in Slack to see more.' }] },
          ],
        };
      } catch (e) {
        console.warn('[unfurl]', e?.message ?? e);
      }
    }
    if (Object.keys(unfurls).length) {
      await client.chat.unfurl({ channel: event.channel, ts: event.message_ts, unfurls }).catch((e) => console.warn('[unfurl]', e?.data?.error ?? e.message));
    }
  });
}
