import { db } from './db.js';
import { grantsGov } from '../mcp/grantsgov-client.js';
import { grantCardV2, forecastCard } from '../surfaces/cards.js';
import { assessFitBatch } from '../prompts/classifiers.js';

async function sweepOne(w) {
  const { kind, params } = w;
  if (kind === 'query') {
    return grantsGov.search({ keyword: params.keyword, oppStatuses: 'posted|forecasted', rows: 10 }).catch(() => []);
  }
  if (kind === 'agency') {
    return grantsGov.search({ keyword: '', agencies: params.agency, oppStatuses: 'posted|forecasted', rows: 10 }).catch(() => []);
  }
  if (kind === 'opp') {
    const d = await grantsGov.fetchOpportunity(params.opp_id).catch(() => null);
    // A watched forecasted opp "fires" once Grants.gov flips it to open —
    // fetchOpportunity doesn't carry oppStatus directly, so treat a
    // resolvable close_date as the open signal (forecast rows lack one).
    if (d?.close_date) return [{ opp_id: params.opp_id, title: d.title, agency: d.agency, close_date: d.close_date, status: 'posted', url: `https://grants.gov/search-results-detail/${params.opp_id}` }];
    return [];
  }
  return [];
}

/** Runs every org's watches (or one org's, when teamId is given) against fresh Grants.gov results and posts new hits. Best-effort per watch — one bad watch never blocks the rest. */
export async function runWatchSweep(client, teamId = null) {
  const orgs = teamId ? [await db.getOrg(teamId)].filter(Boolean) : await db.allOrgs();
  for (const org of orgs) {
    const watches = await db.listWatches(org.team_id).catch(() => []);
    for (const w of watches) {
      try {
        // Throttle: skip if we already nudged for this exact watch <20h ago
        // (simulate bypasses this — it calls sweepOne directly via a caller
        // that doesn't check signals, see /grantweaver simulate).
        const recent = await db.countSignalsSince(org.team_id, 'nudge_posted', String(w.id), 20);
        if (recent > 0) continue;

        const hits = await sweepOne(w);
        const seen = new Set(w.last_seen_ids ?? []);
        const fresh = hits.filter((h) => !seen.has(String(h.opp_id)));

        if (fresh.length && org.post_channels?.length) {
          const fitByOpp = await assessFitBatch(org, fresh.slice(0, 6).map((o) => ({ opp_id: o.opp_id, title: o.title })))
            .then((rows) => new Map(rows.map((r) => [r.opp_id, r])))
            .catch(() => new Map());
          const channel = org.post_channels[0];
          await client.chat.postMessage({
            channel,
            text: `🧶 Fresh matches on your watch — ${fresh.length} new since I last looked:`,
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `🧶 Fresh matches on your watch — ${fresh.length} new since I last looked:` } }],
          }).catch(() => {});
          for (const o of fresh.slice(0, 3)) {
            const fit = fitByOpp.get(String(o.opp_id));
            const blocks = o.status === 'forecasted' ? forecastCard(o, { fit }) : grantCardV2(o, { fit });
            await client.chat.postMessage({ channel, text: o.title, blocks }).catch(() => {});
          }
          await db.addSignal(org.team_id, { kind: 'nudge_posted', subject: String(w.id) });
        }

        const merged = [...seen, ...fresh.map((h) => String(h.opp_id))].slice(-200);
        await db.updateWatchSeen(w.id, { last_run_at: new Date(), last_seen_ids: merged });
      } catch (e) {
        console.warn(`[watches:${w.id}]`, e?.message ?? e);
      }
    }
  }
}
