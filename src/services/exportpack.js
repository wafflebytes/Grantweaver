// Exports: fresh, zero-retention artifacts handed to the user —
// nothing here is stored, everything is re-read live at export time.
import { db } from './db.js';
import { grantsGov } from '../mcp/grantsgov-client.js';
import { SYSTEM_PROMPT, renderOrgContext } from '../prompts/system.js';
import { completeOnce } from '../agent/llm.js';
import { registerIntentExecutor } from '../agent/intents.js';

function slug(title) {
  return String(title ?? 'grant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'grant';
}

/** Re-reads one saved evidence pointer's exact message live via its ts — never from storage. */
async function rereadPointer(client, pointer) {
  try {
    const { messages = [] } = await client.conversations.history({
      channel: pointer.channel_id, latest: pointer.message_ts, oldest: pointer.message_ts, inclusive: true, limit: 1,
    });
    const m = messages[0];
    return m?.text ? { ...pointer, snippet: m.text, author: m.user ? `<@${m.user}>` : 'teammate' } : null;
  } catch {
    return null;
  }
}

export async function buildMdPack(client, teamId, oppId) {
  const [org, opp, oppDetails, checklist, pointers] = await Promise.all([
    db.getOrg(teamId),
    db.listOpportunities(teamId).then((rows) => rows.find((o) => o.opp_id === String(oppId))),
    grantsGov.fetchOpportunity(oppId).catch(() => null),
    db.listOpportunities(teamId).then((rows) => rows.find((o) => o.opp_id === String(oppId))?.checklist ?? []),
    db.listEvidence(teamId, 50),
  ]);
  const linked = pointers.filter((p) => p.opp_id === String(oppId));
  const evidencePointers = linked.length ? linked : pointers.slice(0, 6);
  const reread = (await Promise.all(evidencePointers.map((p) => rereadPointer(client, p)))).filter(Boolean);

  const title = opp?.title ?? oppDetails?.title ?? `Opportunity ${oppId}`;
  const today = new Date().toISOString().slice(0, 10);

  const lines = [
    `# ${title} — working pack`,
    `_(generated ${today} by Grantweaver)_`,
    '',
    '## The opportunity',
    oppDetails
      ? `**Agency:** ${oppDetails.agency ?? '—'} · **Closes:** ${oppDetails.close_date ?? '—'} · **Ceiling:** $${Number(oppDetails.award_ceiling ?? 0).toLocaleString()}\n\n**Eligibility:** ${(oppDetails.eligibility ?? '—').slice(0, 600)}\n\n${(oppDetails.synopsis ?? '').slice(0, 1500)}`
      : '_Details unavailable from Grants.gov right now._',
    '',
    '## Requirements',
    checklist.length
      ? checklist.map((c) => `- [${c.done ? 'x' : ' '}] ${c.label}${c.detail ? ` (${c.detail})` : ''}`).join('\n')
      : '_No checklist extracted yet._',
    '',
    '## Current draft',
    opp?.canvas_id
      ? `A draft canvas exists for this opportunity in Slack. Grantweaver can\'t yet re-export a Canvas\'s live content into this pack — open the canvas directly for the current text.`
      : '_No draft yet._',
    '',
    '## Evidence',
    reread.length
      ? reread.map((r) => `> ${r.snippet}\n— ${r.author} · [source](${r.permalink})`).join('\n\n')
      : '_No saved evidence pointers for this opportunity yet._',
    '',
    '## How to use this pack',
    '1. Paste this whole file into Claude, ChatGPT, or any AI assistant.',
    '2. Ask: "Turn this into a full grant proposal narrative, keeping every cited fact exactly as written."',
    '3. Every fact here traces to a live source — verify before you submit anything.',
  ];
  return { title, content: lines.join('\n'), filename: `${slug(title)}-pack.md` };
}

export async function buildAnswers(client, teamId, oppId) {
  const [org, opp, pointers] = await Promise.all([
    db.getOrg(teamId),
    db.listOpportunities(teamId).then((rows) => rows.find((o) => o.opp_id === String(oppId))),
    db.listEvidence(teamId, 30),
  ]);
  const linked = pointers.filter((p) => p.opp_id === String(oppId));
  const reread = (await Promise.all((linked.length ? linked : pointers.slice(0, 6)).map((p) => rereadPointer(client, p)))).filter(Boolean);
  const checklist = opp?.checklist ?? [];

  const system = SYSTEM_PROMPT + renderOrgContext({ org, pipeline: [opp].filter(Boolean), evidenceCount: reread.length, contextChannelId: undefined });
  const userMsg = [
    'Turn this into copy-ready application answers per your ANSWERS format instructions.',
    `OPPORTUNITY: ${opp?.title ?? oppId} (${opp?.opp_number ?? oppId})`,
    `CHECKLIST: ${JSON.stringify(checklist)}`,
    `DRAFT: ${opp?.canvas_id ? 'A canvas exists but its live text is not re-exportable yet — answer from profile + evidence only.' : 'No draft yet — answer from profile + evidence only.'}`,
    `EVIDENCE: ${JSON.stringify(reread.map((r) => ({ snippet: r.snippet, permalink: r.permalink, author: r.author })))}`,
  ].join('\n\n');

  const markdown = await completeOnce([
    { role: 'system', content: system },
    { role: 'user', content: userMsg },
  ], { maxTokens: 2500 });

  return { title: opp?.title ?? `Opportunity ${oppId}`, content: markdown, filename: `${slug(opp?.title ?? oppId)}-answers.md` };
}

registerIntentExecutor('export_pack', async (client, intent) => {
  const { opp_id } = intent.params;
  const { title, content, filename } = await buildMdPack(client, intent.team_id, opp_id);
  await client.files.uploadV2({ channel_id: intent.channel_id, thread_ts: intent.message_ts, filename, content });
  await client.chat.postMessage({
    channel: intent.channel_id, thread_ts: intent.message_ts,
    text: `📦 Working pack for *${title}* — everything a human (or another AI) needs to take this further. Fresh from live sources just now.`,
  });
});

registerIntentExecutor('answers', async (client, intent) => {
  const { opp_id } = intent.params;
  const { title, content, filename } = await buildAnswers(client, intent.team_id, opp_id);
  await client.files.uploadV2({ channel_id: intent.channel_id, thread_ts: intent.message_ts, filename, content });
  await client.chat.postMessage({
    channel: intent.channel_id, thread_ts: intent.message_ts,
    text: `📋 Copy-ready answers for *${title}* — paste into the funder's form. Everything unverified is marked [TEAM TO CONFIRM].`,
  });
});
