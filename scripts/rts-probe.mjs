// Minimal standalone Bolt listener for investigating Real-Time Search API
// behavior directly (action_token location, response shape, capability info).
// Run: node --env-file=.env scripts/rts-probe.mjs
// Then: open the Grantweaver agent panel in the sandbox and send: probe attendance
import pkg from '@slack/bolt';
const { App } = pkg;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  port: Number(process.env.PORT ?? 3000),
});

app.event('message', async ({ event, client }) => {
  if (!event.text?.startsWith('probe')) return;
  const query = event.text.replace(/^probe\s*/, '') || 'attendance';

  console.log('\n════ RAW EVENT (find the action_token path) ════');
  console.dir(event, { depth: 6 });

  // Q: capabilities shape?
  try {
    const info = await client.apiCall('assistant.search.info', {});
    console.log('\n════ assistant.search.info ════');
    console.dir(info, { depth: 6 });
  } catch (e) { console.error('search.info error:', e?.data ?? e.message); }

  // Q: search.context param names + response shape? bot-message indexing?
  const actionToken = event.action_token ?? event?.assistant_thread?.action_token
    ?? event?.metadata?.action_token;
  console.log('\naction_token found at:',
    event.action_token ? 'event.action_token'
    : event?.assistant_thread?.action_token ? 'event.assistant_thread.action_token'
    : event?.metadata?.action_token ? 'event.metadata.action_token' : 'NOT FOUND ⚠️');
  try {
    const res = await client.apiCall('assistant.search.context', {
      query, action_token: actionToken,
      channel_types: 'public_channel', content_types: 'messages', limit: 5,
    });
    console.log('\n════ assistant.search.context ════');
    console.dir(res, { depth: 8 });
    const hits = res?.results?.messages ?? res?.messages ?? [];
    console.log(`\nRESULT: ${hits.length} hits for "${query}".`);
    console.log('Bot-authored seed messages present?',
      hits.some((m) => (m.content ?? m.text ?? '').includes('42 of 47')) ? 'YES ✅' : 'NO — Risk R2, rerun seed --as-users');
  } catch (e) { console.error('search.context error:', e?.data ?? e.message); }
});

await app.start();
console.log('Probe listening. In Slack, message the app: "probe mentee attendance"');
