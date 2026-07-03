import { db } from '../services/db.js';
import { publishHome } from './home.js';

const FOCUS = ['education', 'youth', 'health', 'environment', 'arts', 'housing',
  'food security', 'workforce', 'civil rights', 'community'];
const STATES = ['OH','CA','NY','TX','IL','GA','WA','FL','PA','MI','—'];

export function registerOnboarding(app) {
  // First-touch DM when a user opens the Messages tab and no org profile exists.
  const welcomed = new Set(); // per-process throttle; fine for demo scale
  app.event('app_home_opened', async ({ event, client, context }) => {
    if (event.tab !== 'messages' || welcomed.has(event.user)) return;
    welcomed.add(event.user);
    const org = await db.getOrg(context.teamId);
    if (org?.mission) return;
    await client.chat.postMessage({
      channel: event.channel ?? event.user,
      text: 'Welcome to Grantweaver! Run /grantweaver setup to get matched funding.',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn',
          text: '👋 Welcome to *Grantweaver*! Two minutes of setup unlocks funding matched to your mission.' } },
        { type: 'actions', elements: [{ type: 'button', style: 'primary', action_id: 'open_setup',
          text: { type: 'plain_text', text: '⚙️ Set up your organization' },
          accessibility_label: 'Open organization setup' }] },
      ],
    });
  });

  app.action('open_setup', async ({ ack, body, client }) => {
    await ack();
    const org = await db.getOrg(body.team.id);
    await client.views.open({ trigger_id: body.trigger_id, view: setupModal(org) });
  });

  app.view('org_setup', async ({ ack, body, view, client }) => {
    await ack();
    const v = view.state.values;
    await db.upsertOrg(body.team.id, {
      org_name: v.org_name.val.value,
      mission: v.mission.val.value,
      focus_areas: (v.focus.val.selected_options ?? []).map((o) => o.value),
      state: v.state.val.selected_option?.value,
      org_size: v.size.val.selected_option?.value,
      digest_channel: v.digest.val.selected_conversation ?? null,
    });
    await client.chat.postMessage({
      channel: body.user.id,
      text: "You're set! 🧶 I'll match grants to your mission. Open my agent panel (✨ icon) and try “Find matching grants” — or wait for Monday's digest.",
    });
    await publishHome(client, body.team.id, body.user.id);
  });
}

export function setupModal(org) {
  const input = (block_id, label, element, optional = false) => ({
    type: 'input', block_id, optional,
    label: { type: 'plain_text', text: label },
    element: { action_id: 'val', ...element },
  });
  return {
    type: 'modal', callback_id: 'org_setup',
    title: { type: 'plain_text', text: 'Grantweaver setup' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Later' },
    blocks: [
      input('org_name', 'Organization name',
        { type: 'plain_text_input', initial_value: org?.org_name ?? '',
          placeholder: { type: 'plain_text', text: 'Riverbend Youth Collective' } }),
      input('mission', 'Mission in one sentence',
        { type: 'plain_text_input', multiline: true, initial_value: org?.mission ?? '',
          placeholder: { type: 'plain_text', text: 'After-school mentorship for under-served youth in Dayton, Ohio' } }),
      input('focus', 'Focus areas (pick up to 4)',
        { type: 'multi_static_select', max_selected_items: 4,
          options: FOCUS.map((f) => ({ text: { type: 'plain_text', text: f }, value: f })),
          ...(org?.focus_areas?.length ? { initial_options: org.focus_areas.map((f) => ({ text: { type: 'plain_text', text: f }, value: f })) } : {}) }),
      input('state', 'Home state',
        { type: 'static_select',
          options: STATES.map((s) => ({ text: { type: 'plain_text', text: s }, value: s })) }),
      input('size', 'Team size',
        { type: 'static_select',
          options: ['1-5', '6-25', '26-100', '100+'].map((s) => ({ text: { type: 'plain_text', text: s }, value: s })) }),
      input('digest', 'Channel for the weekly grant digest',
        { type: 'conversations_select', default_to_current_conversation: true,
          filter: { include: ['public'] } }, true),
      { type: 'context', elements: [{ type: 'mrkdwn',
        text: 'This profile powers grant matching. Grantweaver stores it — and nothing from your messages.' }] },
    ],
  };
}
