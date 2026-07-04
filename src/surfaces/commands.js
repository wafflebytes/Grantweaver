import { helpBlocks } from './blocks.js';
import { setupModal } from './onboarding.js';
import { db } from '../services/db.js';
import { postDigestNow } from '../services/digest.js';
import { orgLinkUrl } from '../services/weblink.js';
import { runWatchSweep } from '../services/watches.js';
import { runHarvestSimulate, runUpdateRequestSweep } from './proactive.js';
import { runDeadlineSweepOnce } from '../services/scheduler.js';

function simulateAllowed(userId) {
  const allowed = (process.env.SIMULATE_ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(userId);
}

export function registerCommands(app) {
  app.command('/grantweaver', async ({ ack, command, respond, client, body }) => {
    await ack(); // <3000ms rule
    const parts = (command.text ?? '').trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? 'help').toLowerCase();

    if (sub === 'setup') {
      const org = await db.getOrg(command.team_id);
      await client.views.open({ trigger_id: body.trigger_id, view: setupModal(org) });
      return;
    }

    if (sub === 'digest') {
      const org = await db.getOrg(command.team_id);
      if (!org?.digest_channel) {
        return respond({ response_type: 'ephemeral',
          text: 'No digest channel configured yet — run `/grantweaver setup` and pick one. 🧶' });
      }
      await postDigestNow(client, command.team_id);
      return respond({ response_type: 'ephemeral', text: `📬 Digest posted to <#${org.digest_channel}>.` });
    }

    if (sub === 'reset') {
      const [opps, evidence] = await Promise.all([
        db.listOpportunities(command.team_id), db.countEvidence(command.team_id),
      ]);
      return respond({
        response_type: 'ephemeral',
        text: `This wipes your profile, ${opps.length} pipeline opportunities, ${evidence} evidence pointers, watches, and the index.`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn',
            text: `This wipes your profile, *${opps.length}* pipeline opportunities, *${evidence}* evidence pointers, watches, and the index. Canvases and Lists stay in Slack as orphans. Sure?` } },
          { type: 'actions', elements: [
            { type: 'button', style: 'danger', action_id: 'gw:onb:reset-confirm', text: { type: 'plain_text', text: 'Reset everything' } },
            { type: 'button', action_id: 'gw:onb:reset-keep', text: { type: 'plain_text', text: 'Keep it' } },
          ] },
        ],
      });
    }

    if (sub === 'index') {
      const org = await db.getOrg(command.team_id);
      if (!org) return respond({ response_type: 'ephemeral', text: 'Run `/grantweaver setup` first. 🧶' });
      return respond({ response_type: 'ephemeral', text: `🧶 Your evidence index: ${orgLinkUrl(command.team_id)}` });
    }

    if (sub === 'watch') {
      const action = (parts[1] ?? 'list').toLowerCase();
      if (action === 'list') {
        const watches = await db.listWatches(command.team_id);
        const lines = watches.map((w) => `• #${w.id} — ${w.kind}: ${JSON.stringify(w.params)}`).join('\n') || '_No watches yet._';
        return respond({ response_type: 'ephemeral', text: `Your watches:\n${lines}` });
      }
      if (action === 'remove') {
        const id = Number(parts[2]);
        if (!id) return respond({ response_type: 'ephemeral', text: 'Usage: `/grantweaver watch remove <id>`' });
        await db.removeWatch(command.team_id, id);
        return respond({ response_type: 'ephemeral', text: `Removed watch #${id}. 🧶` });
      }
      return respond({ response_type: 'ephemeral', text: 'Usage: `/grantweaver watch [list|remove <id>]`' });
    }

    if (sub === 'simulate') {
      if (!simulateAllowed(command.user_id)) {
        return respond({ response_type: 'ephemeral', text: "You're not on the simulate allowlist. 🧶" });
      }
      const target = (parts[1] ?? '').toLowerCase();
      if (target === 'match-drop') {
        await runWatchSweep(client, command.team_id);
        return respond({ response_type: 'ephemeral', text: '🧶 Ran a match-drop sweep — check your post channel.' });
      }
      if (target === 'harvest') {
        const result = await runHarvestSimulate(client, command.team_id);
        return respond({ response_type: 'ephemeral', text: result.ok ? '🧶 Harvest fired — check the thread on the most recent watched-channel message.' : `Harvest didn't fire: ${result.reason ?? result.dropped}` });
      }
      if (target === 'update-request') {
        const result = await runUpdateRequestSweep(client, command.team_id, { bypassThrottle: true, dmOverride: command.user_id });
        return respond({ response_type: 'ephemeral', text: result?.picked ? `🧶 Update-request DM sent for opp ${result.picked}.` : 'No drafting opportunities to nudge on.' });
      }
      if (target === 'deadline') {
        await runDeadlineSweepOnce(client);
        return respond({ response_type: 'ephemeral', text: '🧶 Ran the deadline sweep.' });
      }
      if (target === 'digest') {
        await postDigestNow(client, command.team_id);
        return respond({ response_type: 'ephemeral', text: '🧶 Digest posted.' });
      }
      return respond({ response_type: 'ephemeral', text: 'Usage: `/grantweaver simulate <match-drop|harvest|update-request|deadline|digest>`' });
    }

    // help + anything unknown → same friendly card (never an error dump)
    return respond({ response_type: 'ephemeral',
      text: 'Grantweaver help', blocks: helpBlocks() });
  });
}
