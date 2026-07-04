// Conversational onboarding — a JSONB state machine on
// orgs.onboarding_state. Every step but `mission`/`org_name` is buttons/
// selects; those two take over the DM message handler (assistant.js) with
// zero LLM involvement. The whole flow is LLM-free except the scan's theme
// classifier (src/prompts/classifiers.js#classifyThemes).
import { db } from '../services/db.js';
import { publishHome } from './home.js';
import { runWorkspaceScan } from '../services/scan.js';
import { scanSummaryCard, confirmCard } from './cards.js';
import { orgLinkUrl } from '../services/weblink.js';
import { registerIntentExecutor } from '../agent/intents.js';

const FOCUS = ['education', 'youth', 'health', 'environment', 'arts', 'housing',
  'food security', 'workforce', 'civil rights', 'community'];
const STATES = ['OH', 'CA', 'NY', 'TX', 'IL', 'GA', 'WA', 'FL', 'PA', 'MI', '—'];
const ENTITY_TYPES = [['501c3', '501(c)(3)'], ['other_nonprofit', 'Other nonprofit'], ['school', 'School/district'], ['gov', 'Government'], ['other', 'Other']];
const YEARS_OPTS = [['<2', 'Less than 2 years'], ['2-5', '2–5 years'], ['5+', '5+ years']];
const SAM_OPTS = [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']];

const COPY = {
  welcome: "👋 I'm *Grantweaver*. Give me ~2 minutes of questions, then I'll read through your workspace (with your permission) and show you the funding evidence you already have. Ready?",
  mission: "First: in a sentence or two, who do you serve and what do you do? Write it like you'd tell a funder.",
  org_name: "And what's your organization called?",
  focus: 'Which areas describe your work? Pick up to 4.',
  facts: 'Three quick facts funders always need:',
  channels: "Now the important part. Pick the channels I may *learn from* (I'll search them for impact evidence — I read live and store only links, never your messages), and where I may *post* (matches and digests).",
  scanning: '🧶 Scanning now — watch me work. This takes about a minute.',
  review: "Here's your evidence index — what your workspace can already prove to a funder. Look right?",
  done: "You're woven in 🧶 Three good first asks: *Find grants that fit our mission* · *What's our strongest evidence?* · *What's due soon?*",
};

async function setStep(teamId, step, patch = {}) {
  const org = await db.getOrg(teamId);
  const state = { ...(org?.onboarding_state ?? { answers: {} }), step, answers: { ...(org?.onboarding_state?.answers ?? {}), ...patch } };
  await db.setOnboardingState(teamId, state);
  return state;
}

async function postMission(client, channel) {
  await client.chat.postMessage({ channel, text: COPY.mission });
}
async function postOrgName(client, channel) {
  await client.chat.postMessage({ channel, text: COPY.org_name });
}
async function postFocus(client, channel) {
  await client.chat.postMessage({
    channel, text: COPY.focus,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: COPY.focus } },
      { type: 'actions', elements: [
        { type: 'multi_static_select', action_id: 'gw:onb:focus:pick', max_selected_items: 4,
          placeholder: { type: 'plain_text', text: 'Pick up to 4' },
          options: FOCUS.map((f) => ({ text: { type: 'plain_text', text: f }, value: f })) },
        { type: 'button', style: 'primary', action_id: 'gw:onb:focus:done', text: { type: 'plain_text', text: 'Done picking' } },
      ] },
    ],
  });
}
async function postFacts(client, channel) {
  await client.chat.postMessage({
    channel, text: COPY.facts,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: COPY.facts } },
      { type: 'actions', elements: [
        { type: 'static_select', action_id: 'gw:onb:facts:entity', placeholder: { type: 'plain_text', text: 'Entity type' },
          options: ENTITY_TYPES.map(([v, l]) => ({ text: { type: 'plain_text', text: l }, value: v })) },
        { type: 'static_select', action_id: 'gw:onb:facts:years', placeholder: { type: 'plain_text', text: 'Years operating' },
          options: YEARS_OPTS.map(([v, l]) => ({ text: { type: 'plain_text', text: l }, value: v })) },
        { type: 'static_select', action_id: 'gw:onb:facts:sam', placeholder: { type: 'plain_text', text: 'SAM.gov + UEI registered?' },
          options: SAM_OPTS.map(([v, l]) => ({ text: { type: 'plain_text', text: l }, value: v })) },
      ] },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', action_id: 'gw:onb:facts:done', text: { type: 'plain_text', text: 'Continue' } },
      ] },
    ],
  });
}
async function postChannels(client, channel) {
  await client.chat.postMessage({
    channel, text: COPY.channels,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: COPY.channels } },
      { type: 'actions', elements: [
        { type: 'multi_conversations_select', action_id: 'gw:onb:ch:watched',
          placeholder: { type: 'plain_text', text: 'Channels I may LEARN from' }, filter: { include: ['public', 'private'] } },
      ] },
      { type: 'actions', elements: [
        { type: 'multi_conversations_select', action_id: 'gw:onb:ch:post',
          placeholder: { type: 'plain_text', text: 'Channels I may POST to' }, filter: { include: ['public', 'private'] } },
      ] },
      { type: 'context', elements: [{ type: 'mrkdwn',
        text: '_Learn-from channels: I search them live for evidence, and store only links — never message text. Post channels: matches, digests, and nudges land there._' }] },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', action_id: 'gw:onb:ch:done', text: { type: 'plain_text', text: 'Continue' } },
      ] },
    ],
  });
}

function makeScanStreamer(client, channel) {
  let ts = null;
  const lines = [];
  return {
    async task(label) {
      lines.push(`🧶 ${label}…`);
      const text = lines.join('\n');
      if (!ts) {
        const posted = await client.chat.postMessage({ channel, text });
        ts = posted.ts;
      } else {
        await client.chat.update({ channel, ts, text }).catch(() => {});
      }
    },
  };
}

async function runScanAndReview(client, teamId, channel) {
  await setStep(teamId, 'scanning');
  await client.chat.postMessage({ channel, text: COPY.scanning });
  const streamer = makeScanStreamer(client, channel);
  const summary = await runWorkspaceScan(client, teamId, streamer).catch((e) => {
    console.error('[onboarding:scan]', e?.message ?? e);
    return { themes: [], totalHits: 0, channelsCovered: 0, fileCount: 0 };
  });
  await setStep(teamId, 'review');
  const index = await db.listIndex(teamId);
  await client.chat.postMessage({
    channel, text: COPY.review,
    blocks: scanSummaryCard({ index, webUrl: orgLinkUrl(teamId) }),
  });
  // The scan used to just post the summary and stop — thin coverage got no
  // reaction at all, even though that's exactly the moment a real
  // development director would ask a follow-up question. One honest,
  // specific nudge (not a generic "add more channels") when coverage is
  // genuinely thin, so the org can fix it before it bites them in a draft.
  if (summary.totalHits < 3 || summary.channelsCovered < 2) {
    await client.chat.postMessage({
      channel,
      text: "I didn't find much yet — want to point me at more channels?",
      blocks: [{ type: 'section', text: { type: 'mrkdwn',
        text: `That's pretty thin evidence to build funder-ready proof from (${summary.totalHits} hit${summary.totalHits === 1 ? '' : 's'} across ${summary.channelsCovered} channel${summary.channelsCovered === 1 ? '' : 's'}). Two common reasons: your team posts outcomes somewhere I'm not watching yet, or the numbers mostly live in files/spreadsheets I haven't been shared. Hit *Adjust* above to add channels, or just tell me here where your team tracks program metrics or stories.` } }],
    });
  }
  return summary;
}

export function registerOnboarding(app) {
  const welcomed = new Set(); // per-process throttle; fine for demo scale
  app.event('app_home_opened', async ({ event, client, context }) => {
    if (event.tab !== 'messages' || welcomed.has(event.user)) return;
    welcomed.add(event.user);
    const org = await db.getOrg(context.teamId);
    if (org?.mission) return;
    await client.chat.postMessage({
      channel: event.channel ?? event.user,
      text: 'Welcome to Grantweaver!',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn',
          text: '👋 Welcome to *Grantweaver*! A quick setup unlocks funding matched to your mission — plus a scan of the evidence you already have.' } },
        { type: 'actions', elements: [{ type: 'button', style: 'primary', action_id: 'gw:onb:start',
          text: { type: 'plain_text', text: 'Start setup (2 min + a quick scan)' },
          accessibility_label: 'Start conversational setup' }] },
      ],
    });
  });

  app.action('gw:onb:start', async ({ ack, body, client }) => {
    await ack();
    const teamId = body.team.id, channel = body.channel?.id ?? body.user.id;
    const state = await setStep(teamId, 'mission', {});
    state.started_by = body.user.id; state.started_at = new Date().toISOString();
    await db.setOnboardingState(teamId, state);
    await postMission(client, channel);
  });

  // Legacy entry point kept working alongside the new flow (org exists → modal, unchanged).
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

  // ── focus ──
  app.action('gw:onb:focus:pick', async ({ ack, body }) => {
    await ack();
    await setStep(body.team.id, 'focus', { focus_areas: (body.actions[0].selected_options ?? []).map((o) => o.value) });
  });
  app.action('gw:onb:focus:done', async ({ ack, body, client }) => {
    await ack();
    const teamId = body.team.id, channel = body.channel.id;
    const org = await db.getOrg(teamId);
    await db.upsertOrg(teamId, { focus_areas: org?.onboarding_state?.answers?.focus_areas ?? [] });
    await setStep(teamId, 'facts');
    await postFacts(client, channel);
  });

  // ── facts ──
  app.action('gw:onb:facts:entity', async ({ ack, body }) => {
    await ack(); await setStep(body.team.id, 'facts', { entity_type: body.actions[0].selected_option.value });
  });
  app.action('gw:onb:facts:years', async ({ ack, body }) => {
    await ack(); await setStep(body.team.id, 'facts', { years_operating: body.actions[0].selected_option.value });
  });
  app.action('gw:onb:facts:sam', async ({ ack, body }) => {
    await ack(); await setStep(body.team.id, 'facts', { has_sam_uei: body.actions[0].selected_option.value });
  });
  app.action('gw:onb:facts:done', async ({ ack, body, client }) => {
    await ack();
    const teamId = body.team.id, channel = body.channel.id;
    const org = await db.getOrg(teamId);
    const a = org?.onboarding_state?.answers ?? {};
    if (!a.entity_type || !a.years_operating || !a.has_sam_uei) {
      await client.chat.postEphemeral({ channel, user: body.user.id, text: 'Pick all three before continuing 🧶' });
      return;
    }
    await db.setEligibilityFacts(teamId, {
      entity_type: a.entity_type, years_operating: a.years_operating, has_sam_uei: a.has_sam_uei === 'yes',
    });
    await setStep(teamId, 'channels');
    await postChannels(client, channel);
  });

  // ── channels ──
  app.action('gw:onb:ch:watched', async ({ ack, body }) => {
    await ack(); await setStep(body.team.id, 'channels', { watched: body.actions[0].selected_conversations ?? [] });
  });
  app.action('gw:onb:ch:post', async ({ ack, body }) => {
    await ack(); await setStep(body.team.id, 'channels', { post: body.actions[0].selected_conversations ?? [] });
  });
  app.action('gw:onb:ch:done', async ({ ack, body, client }) => {
    await ack();
    const teamId = body.team.id, channel = body.channel.id;
    const org = await db.getOrg(teamId);
    const a = org?.onboarding_state?.answers ?? {};
    await db.setChannels(teamId, { watched: a.watched ?? [], post: a.post ?? [] });

    if (org?.onboarding_state?.isRescan) {
      // Post-onboarding rescan is a confirm-first intent — it costs ~1min of RTS budget.
      const intent = await db.createIntent(teamId, { kind: 'rescan', params: {}, requested_by: body.user.id, channel_id: channel });
      const posted = await client.chat.postMessage({
        channel, text: 'Ready to rescan',
        blocks: confirmCard(intent, { summary: 'Re-read your (updated) channel selection for fresh evidence.', etaSeconds: 60 }),
      });
      await db.setIntentMessage(intent.id, posted.ts);
      await setStep(teamId, 'review');
      return;
    }
    await runScanAndReview(client, teamId, channel);
  });

  // ── review ──
  app.action('gw:scan:ok', async ({ ack, body, client }) => {
    await ack();
    const teamId = body.team.id, channel = body.channel.id;
    await db.setOnboardingState(teamId, null);
    await client.chat.postMessage({ channel, text: COPY.done });
    await publishHome(client, teamId, body.user.id);
  });
  app.action('gw:scan:adjust', async ({ ack, body, client }) => {
    await ack();
    const teamId = body.team.id, channel = body.channel.id;
    await setStep(teamId, 'channels', {});
    const org = await db.getOrg(teamId);
    await db.setOnboardingState(teamId, { ...org.onboarding_state, step: 'channels', isRescan: true });
    await postChannels(client, channel);
  });

  // ── reset ──
  app.action('gw:onb:reset-confirm', async ({ ack, body, client }) => {
    await ack();
    const teamId = body.team.id, channel = body.channel?.id ?? body.user.id;
    await db.resetOrg(teamId);
    await client.chat.postMessage({
      channel, text: 'Clean slate 🧶 Want to set up again?',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'Clean slate 🧶 Want to set up again?' } },
        { type: 'actions', elements: [{ type: 'button', style: 'primary', action_id: 'gw:onb:start',
          text: { type: 'plain_text', text: 'Start setup' } }] },
      ],
    });
  });
  app.action('gw:onb:reset-keep', async ({ ack, body, client }) => {
    await ack();
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, text: 'Kept everything as-is. 🧶' });
  });

  // rescan intent executor — reused by the review "Adjust" path and any
  // future organic "rescan my workspace" ask.
  registerIntentExecutor('rescan', async (client, intent) => {
    await runScanAndReview(client, intent.team_id, intent.channel_id);
  });
}

/** Called from assistant.js BEFORE runAgentTurn when org.onboarding_state.step
 * is a free-text step (mission, org_name). Returns true if it took over. */
export async function handleOnboardingAnswer(client, { teamId, channel, userId, text, org }) {
  const step = org?.onboarding_state?.step;
  if (step === 'mission') {
    await db.upsertOrg(teamId, { mission: text.trim() });
    if (org?.org_name) {
      await setStep(teamId, 'focus');
      await postFocus(client, channel);
    } else {
      await setStep(teamId, 'org_name');
      await postOrgName(client, channel);
    }
    return true;
  }
  if (step === 'org_name') {
    await db.upsertOrg(teamId, { org_name: text.trim() });
    await setStep(teamId, 'focus');
    await postFocus(client, channel);
    return true;
  }
  return false;
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
