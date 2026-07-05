import { helpBlocks } from './blocks.js';
import { setupModal } from './onboarding.js';
import { db } from '../services/db.js';
import { postDigestNow } from '../services/digest.js';
import { orgLinkUrl } from '../services/weblink.js';
import { runWatchSweep } from '../services/watches.js';
import { runHarvestSimulate, runUpdateRequestSweep, runReviewingStaleSweep } from './proactive.js';
import { runDeadlineSweepOnce } from '../services/scheduler.js';
import { reconcileListEdits, reconcileEvidenceListEdits } from '../services/lists.js';
import { postMemoriesRecap } from '../services/memories.js';

function stateBlocks(state) {
  if (!state) return [{ type: 'section', text: { type: 'mrkdwn', text: '_No saved agent state for this conversation yet._' } }];
  const latest = (items, render) => (items ?? []).slice(-3).reverse().map(render).join('\n') || '_None_';
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Agent state' } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Goal:* ${state.goal ?? 'unknown'}\n*Summary:* ${state.summary ?? '_None_'}\n*Source pointers:* ${(state.sources ?? []).length}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Recent decisions*\n${latest(state.decisions, (d) => `• ${d.summary}`)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Artifacts*\n${latest(state.artifacts, (a) => `• ${a.summary ?? a.type}${a.url ? ` · <${a.url}|open>` : ''}`)}` } },
  ];
}

function logsBlocks(runs) {
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Recent Grantweaver runs' } },
    ...(runs.length ? runs.map((r) => ({ type: 'section', text: { type: 'mrkdwn',
      text: `*${new Date(r.started_at).toLocaleString('en-US')}* · ${r.surface} · *${r.status}* · ${r.total_latency_ms ?? '—'}ms\n${(r.tools_called ?? []).join(', ') || '_No tools_'} · ${r.model ?? 'model unknown'}${r.error_type ? ` · ${r.error_type}` : ''}` } }))
      : [{ type: 'section', text: { type: 'mrkdwn', text: '_No runs logged yet._' } }]),
  ];
}

function settingsModal(org) {
  const excluded = org?.ai_excluded_channels ?? [];
  return {
    type: 'modal',
    callback_id: 'gw_settings_submit',
    title: { type: 'plain_text', text: 'Grantweaver settings' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'input', block_id: 'excluded', optional: true,
        label: { type: 'plain_text', text: 'AI excluded channels' },
        element: { type: 'multi_conversations_select', action_id: 'value',
          initial_conversations: excluded, placeholder: { type: 'plain_text', text: 'Pick channels to exclude' },
          filter: { include: ['public', 'private'], exclude_bot_users: true } } },
      { type: 'input', block_id: 'proactive', optional: true,
        label: { type: 'plain_text', text: 'Proactive workflows' },
        element: { type: 'checkboxes', action_id: 'value',
          initial_options: org?.proactive_enabled === false ? [] : [{ text: { type: 'plain_text', text: 'Enable watches and proactive nudges' }, value: 'enabled' }],
          options: [{ text: { type: 'plain_text', text: 'Enable watches and proactive nudges' }, value: 'enabled' }] } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '<https://grantweaver.app/privacy|Privacy> · <https://grantweaver.app/support|Support>' }] },
    ],
  };
}

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

    if (sub === 'state') {
      const threadTs = command.thread_ts ?? '';
      const state = await db.getAgentState(command.team_id, command.channel_id, threadTs)
        ?? await db.getAgentState(command.team_id, command.channel_id, '');
      return respond({ response_type: 'ephemeral', text: 'Agent state', blocks: stateBlocks(state) });
    }

    if (sub === 'logs') {
      const runs = await db.listAgentRuns(command.team_id, 10);
      return respond({ response_type: 'ephemeral', text: 'Recent Grantweaver runs', blocks: logsBlocks(runs) });
    }

    if (sub === 'settings') {
      const org = await db.getOrg(command.team_id);
      await client.views.open({ trigger_id: body.trigger_id, view: settingsModal(org) });
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
      if (target === 'reviewing-stale') {
        const result = await runReviewingStaleSweep(client, command.team_id, { bypassThrottle: true, channelOverride: command.channel_id });
        return respond({ response_type: 'ephemeral', text: result.nudged.length ? `🧶 Nudged on opp ${result.nudged[0]}.` : 'No suggested/reviewing opportunities are stale enough yet.' });
      }
      if (target === 'memories') {
        const result = await postMemoriesRecap(client, command.team_id);
        return respond({ response_type: 'ephemeral', text: result.posted
          ? '🧶 Posted this week\'s memories recap.'
          : 'No memories channel set — run `/grantweaver setup` and pick one.' });
      }
      if (target === 'sync-list') {
        // Otherwise only runs on the hourly scheduler sweep — useful to force
        // right after editing the List by hand, to confirm two-way sync live
        // instead of waiting up to an hour.
        await reconcileListEdits(client, command.team_id);
        await reconcileEvidenceListEdits(client, command.team_id);
        return respond({ response_type: 'ephemeral', text: '🧶 Reconciled the pipeline and evidence Lists against any manual edits.' });
      }
      return respond({ response_type: 'ephemeral', text: 'Usage: `/grantweaver simulate <match-drop|harvest|update-request|reviewing-stale|deadline|digest|memories|sync-list>`' });
    }

    // Live feature request: a way to reset the DM for demo takes without
    // re-provisioning the whole sandbox. Bot tokens can only delete their
    // OWN messages (Slack API constraint — never another user's), so this
    // clears every message Grantweaver itself posted in this DM; the
    // human's own messages are left for them to remove by hand if they want
    // a truly blank thread.
    if (sub === 'clear') {
      const info = await client.conversations.info({ channel: command.channel_id }).catch(() => null);
      if (!info?.channel?.is_im) {
        return respond({ response_type: 'ephemeral', text: 'This only clears MY messages, and only works in your DM with me (not a channel). 🧶' });
      }
      const { user_id: botUserId } = await client.auth.test();
      let deleted = 0, cursor;
      do {
        const { messages = [], response_metadata } = await client.conversations.history({ channel: command.channel_id, limit: 200, cursor }).catch(() => ({}));
        for (const m of messages) {
          if (m.user === botUserId || m.bot_id) {
            await client.chat.delete({ channel: command.channel_id, ts: m.ts }).then(() => { deleted++; }).catch(() => {});
          }
        }
        cursor = response_metadata?.next_cursor || undefined;
      } while (cursor);
      return respond({ response_type: 'ephemeral', text: `🧹 Cleared ${deleted} of my messages from this DM. Your own messages stay — I can only delete what I posted.` });
    }

    // help + anything unknown → same friendly card (never an error dump)
    return respond({ response_type: 'ephemeral',
      text: 'Grantweaver help', blocks: helpBlocks() });
  });

  app.view('gw_settings_submit', async ({ ack, body, view }) => {
    await ack();
    const excluded = view.state.values.excluded?.value?.selected_conversations ?? [];
    const proactiveEnabled = Boolean((view.state.values.proactive?.value?.selected_options ?? []).find((o) => o.value === 'enabled'));
    await db.setGovernanceSettings(body.team.id, {
      ai_excluded_channels: excluded,
      proactive_enabled: proactiveEnabled,
      governance_settings: { updated_by: body.user.id, updated_at: new Date().toISOString() },
    });
    await db.logAuditEvent({
      teamId: body.team.id, userId: body.user.id, eventType: 'governance_setting_changed',
      subjectType: 'org', subjectId: body.team.id, metadata: { ai_excluded_channels: excluded, proactive_enabled: proactiveEnabled },
    }).catch(() => {});
  });
}
