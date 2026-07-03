import pkg from '@slack/bolt';
const { App, LogLevel } = pkg;
import { registerAssistant } from './assistant.js';
import { registerHome } from './surfaces/home.js';
import { registerOnboarding } from './surfaces/onboarding.js';
import { registerCommands } from './surfaces/commands.js';
import { registerReactions } from './surfaces/reactions.js';
import { registerActions } from './surfaces/actions.js';
import { startScheduler } from './services/scheduler.js';
import { db } from './services/db.js';
import { handleMcpRequest } from './mcp/grantweaver-server.mjs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const socketMode = process.env.SOCKET_MODE === 'true';
const port = Number(process.env.PORT ?? 3000);

// The landing/privacy/support pages ship from this same service — one Railway
// deployment hosts the app, the MCP endpoint, and the site with no extra
// hosting or domain to manage.
const SITE_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
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
    sitePage('index.html', '/'),
    sitePage('index.html'),
    sitePage('privacy.html'),
    sitePage('support.html'),
    sitePage('style.css'),
    sitePage('logo.png'),
  ],
});

registerAssistant(app);
registerHome(app);
registerOnboarding(app);
registerCommands(app);
registerReactions(app);
registerActions(app);

app.error(async (error) => {
  // Never crash on a handler error; never leak stack traces to users.
  console.error('[bolt:error]', error?.code ?? '', error?.original?.message ?? error?.message ?? error);
});

await db.migrateIfNeeded();
await app.start(port);
startScheduler(app);
console.log(`🧶 Grantweaver running (${socketMode ? 'socket mode' : `http :${port}`}) sha=${process.env.BUILD_SHA ?? 'dev'}`);
