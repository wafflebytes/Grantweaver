import pkg from '@slack/bolt';
const { App, LogLevel } = pkg;
import { registerAssistant } from './assistant.js';
import { registerHome } from './surfaces/home.js';
import { registerOnboarding } from './surfaces/onboarding.js';
import { registerCommands } from './surfaces/commands.js';
import { registerReactions } from './surfaces/reactions.js';
import { registerActions } from './surfaces/actions.js';
import { registerMention } from './surfaces/mention.js';
import { registerUnfurl } from './surfaces/unfurl.js';
import { registerShortcuts } from './surfaces/shortcuts.js';
import { registerProactive } from './surfaces/proactive.js';
import { startScheduler } from './services/scheduler.js';
import { db } from './services/db.js';
import { handleMcpRequest } from './mcp/grantweaver-server.mjs';
import { verifyOrgToken } from './services/weblink.js';
import { renderOrgPage } from './web/orgpage.js';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const socketMode = process.env.SOCKET_MODE === 'true';
const port = Number(process.env.PORT ?? 3000);

// The landing/privacy/support pages ship from this same service — one Railway
// deployment hosts the app, the MCP endpoint, and the site with no extra
// hosting or domain to manage.
const SITE_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const sitePage = (file, routePath = `/${file}`) => ({
  path: routePath,
  method: ['GET'],
  handler: async (_req, res) => {
    try {
      const body = await readFile(new URL(`../site/${file}`, import.meta.url));
      res.writeHead(200, { 'content-type': SITE_TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=300' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  },
});

export const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // @slack/web-api's WebClient defaults to timeout: 0 — NO timeout at all.
  // Every chat.postMessage/apiCall/conversations.* call in the whole app
  // shared this one gap, the same bug class already fixed for the LLM
  // client and the grantsgov MCP client, just much bigger blast radius:
  // live-reproduced a "pipeline add" turn that hung 5+ minutes with zero
  // reply and no error, most likely stuck inside a Slack API call
  // (slackLists/canvas) rather than the grantsgov or LLM calls that already
  // had timeouts. 45s covers real Slack API latency with headroom.
  clientOptions: { timeout: 45_000 },
  // In Socket Mode, Bolt's health-check/customRoutes HTTP server reads its
  // port from the constructor (not from app.start()'s argument) — pass it
  // here so PORT is honored in both modes.
  ...(socketMode ? { socketMode: true, appToken: process.env.SLACK_APP_TOKEN, port } : {}),
  logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
  customRoutes: [
    {
      path: '/healthz',
      method: ['GET'],
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sha: process.env.BUILD_SHA ?? 'dev', ts: new Date().toISOString() }));
      },
    },
    // One Railway service, one port, one TLS cert — grantweaver-mcp mounts
    // here instead of running as a second process/port in prod.
    { path: '/mcp', method: ['POST'], handler: handleMcpRequest },
    {
      // Bolt's HTTPReceiver router supports :param segments (verified live
      // locally). Falls back to ?t= if a param ever arrives unmatched —
      // verifyOrgToken doesn't care which transport handed it the token.
      path: '/org/:token',
      method: ['GET'],
      handler: async (req, res) => {
        const token = req.params?.token ?? new URL(req.url, 'http://x').searchParams.get('t');
        const verified = token ? verifyOrgToken(token) : null;
        const html = await renderOrgPage(verified?.teamId ?? null);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
      },
    },
    sitePage('index.html', '/'),
    sitePage('index.html'),
    sitePage('privacy.html'),
    sitePage('support.html'),
    sitePage('style.css'),
    sitePage('logo.png'),
    // Seed-persona avatars (Maya/Dre lack real sandbox user tokens, so their
    // messages post via the bot with an icon_url override) — served here so
    // Slack has a stable public URL to fetch at post time.
    sitePage('avatars/dre.jpg'),
    sitePage('avatars/maya.jpg'),
  ],
});

registerAssistant(app);
registerHome(app);
registerOnboarding(app);
registerCommands(app);
registerReactions(app);
registerActions(app);
registerMention(app);
registerUnfurl(app);
registerShortcuts(app);
registerProactive(app);

app.error(async (error) => {
  // Never crash on a handler error; never leak stack traces to users.
  console.error('[bolt:error]', error?.code ?? '', error?.original?.message ?? error?.message ?? error);
});

await db.migrateIfNeeded();
await app.start(port);
startScheduler(app);
console.log(`🧶 Grantweaver running (${socketMode ? 'socket mode' : `http :${port}`}) sha=${process.env.BUILD_SHA ?? 'dev'}`);
