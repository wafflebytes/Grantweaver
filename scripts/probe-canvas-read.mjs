// Probe: is there any live path to read a canvas's full markdown back?
// Run: node --env-file=.env scripts/probe-canvas-read.mjs
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function main() {
  console.log('--- 1. create scratch canvas ---');
  const created = await client.apiCall('canvases.create', {
    title: 'Probe Canvas',
    document_content: {
      type: 'markdown',
      markdown: '## Overview\nprobe-marker-abc123\n## Requirements\n- [ ] thing\n## Draft\nhello\n## Evidence\n(none)\n## Activity\n- created',
    },
  });
  console.log(created);
  const canvasId = created.canvas_id;

  console.log('\n--- 2a. files.info(canvasId) ---');
  try {
    const info = await client.files.info({ file: canvasId });
    console.log(JSON.stringify(info, null, 2).slice(0, 2000));
  } catch (e) {
    console.log('FAILED', e?.data?.error ?? e.message);
  }

  console.log('\n--- 2c. assistant.search.context content_types:[files] ---');
  try {
    const ctx = await client.apiCall('assistant.search.context', {
      query: 'probe-marker-abc123',
      content_types: ['files'],
      channel_types: ['public_channel', 'private_channel', 'im', 'mpim'],
      include_bots: true,
    });
    console.log(JSON.stringify(ctx, null, 2).slice(0, 2000));
  } catch (e) {
    console.log('FAILED', e?.data?.error ?? e.message);
  }

  console.log('\n--- 2d. canvases.export? (likely does not exist) ---');
  try {
    const exp = await client.apiCall('canvases.export', { canvas_id: canvasId });
    console.log(JSON.stringify(exp, null, 2).slice(0, 500));
  } catch (e) {
    console.log('FAILED (expected)', e?.data?.error ?? e.message);
  }

  console.log('\n--- 3. sections.lookup (needed for editSection regardless of read branch) ---');
  try {
    const lookup = await client.apiCall('canvases.sections.lookup', {
      canvas_id: canvasId,
      criteria: { contains_text: ['Draft'] },
    });
    console.log(JSON.stringify(lookup, null, 2));
  } catch (e) {
    console.log('FAILED', e?.data?.error ?? e.message);
  }

  console.log('\nDone. canvas_id =', canvasId, '— delete manually if desired (no canvases.delete method needed for probe).');
}

main().catch((e) => { console.error(e); process.exit(1); });
