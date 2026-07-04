import cron from 'node-cron';
import { db } from './db.js';
import { postDigestNow } from './digest.js';
import { reconcileListEdits } from './lists.js';
import { runWatchSweep } from './watches.js';

export function startScheduler(app) {
  // Weekly digest — Monday 9:00 server time (per-org cron is a v2 nicety;
  // org.digest_cron column already exists for it).
  cron.schedule('0 9 * * 1', async () => {
    for (const org of await db.allOrgs()) {
      try { await postDigestNow(app.client, org.team_id); }
      catch (e) { console.error(`[digest:${org.team_id}]`, e?.message ?? e); }
    }
  });

  // Daily deadline nudges — 9:15, T-14 / T-7 / T-2
  cron.schedule('15 9 * * *', async () => {
    for (const org of await db.allOrgs()) {
      if (!org.digest_channel) continue;
      const opps = await db.listOpportunities(org.team_id);
      for (const o of opps) {
        if (!o.close_date || ['submitted', 'awarded', 'declined'].includes(o.stage)) continue;
        const days = Math.ceil((new Date(o.close_date) - Date.now()) / 86400000);
        if (![14, 7, 2].includes(days)) continue;
        await app.client.chat.postMessage({
          channel: org.digest_channel,
          text: `⏰ *${o.title}* is due in *${days} days*. Stage: ${o.stage}. Open my agent panel and ask me to draft or finalize.`,
        }).catch((e) => console.error('[reminder]', e?.data?.error ?? e?.message));
      }
    }
  });

  // Intent expiry: a confirm card nobody ever clicked shouldn't
  // stay "pending" forever — sweep hourly.
  cron.schedule('0 * * * *', async () => {
    const n = await db.expireStaleIntents(24).catch((e) => { console.error('[intents:expire]', e?.message ?? e); return 0; });
    if (n) console.log(`[intents] expired ${n} stale pending intent(s)`);
  });

  // Two-way Lists reconcile: pipeline-tool triggers cover the interactive
  // path, this hourly sweep catches edits nobody's turn happened to touch.
  cron.schedule('30 * * * *', async () => {
    for (const org of await db.allOrgs()) {
      if (org.pipeline_list_id) await reconcileListEdits(app.client, org.team_id).catch(() => {});
    }
  });

  // Watch sweep: fresh Grants.gov matches/forecast-opens against standing
  // watches, three times a day.
  cron.schedule('0 8,13,18 * * *', async () => {
    await runWatchSweep(app.client).catch((e) => console.error('[watches]', e?.message ?? e));
  });

  console.log('[scheduler] weekly digest (Mon 9:00) + daily deadline nudges (9:15) + hourly intent-expiry + hourly list-reconcile + 3x/day watch-sweep armed');
}

/** Exported for tests & manual runs. */
export async function runDeadlineSweepOnce(client) {
  for (const org of await db.allOrgs()) {
    if (!org.digest_channel) continue;
    const opps = await db.listOpportunities(org.team_id);
    for (const o of opps) {
      if (!o.close_date) continue;
      const days = Math.ceil((new Date(o.close_date) - Date.now()) / 86400000);
      if ([14, 7, 2].includes(days)) {
        await client.chat.postMessage({ channel: org.digest_channel,
          text: `⏰ *${o.title}* is due in *${days} days*.` });
      }
    }
  }
}
