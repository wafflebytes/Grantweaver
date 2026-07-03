import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import { db } from '../services/db.js';
import { grantsGov } from './grantsgov-client.js';

function text(obj) { return { content: [{ type: 'text', text: JSON.stringify(obj) }] }; }

// One fresh McpServer per HTTP request, not a shared module-level instance:
// the SDK's Server.connect() throws "Already connected to a transport" on a
// second connect() call, which would crash the process on the very next
// request in the stateless one-shot pattern used here.
function buildServer(fixedTeamId) {
  const server = new McpServer({ name: 'grantweaver-mcp', version: '0.1.0' });
  // Under slack_identity auth, fixedTeamId comes from the verified request
  // signature, not the caller — never let a tool argument override it, or a
  // Slackbot user could pass an arbitrary team_id and read another
  // workspace's pipeline.
  const resolveTeamId = (argTeamId) => fixedTeamId ?? argTeamId;

  server.tool('list_pipeline',
    "List a workspace's grant pipeline: title, agency, stage, close date, award ceiling, draft-canvas existence.",
    { team_id: z.string().describe('Slack team ID, e.g. T0123456').optional() },
    async ({ team_id }) => text({
      pipeline: (await db.listOpportunities(resolveTeamId(team_id))).map((o) => ({
        title: o.title, agency: o.agency, stage: o.stage,
        close_date: o.close_date, award_ceiling: o.award_ceiling, has_draft: !!o.canvas_id,
      })),
    }));

  server.tool('get_deadlines',
    'Upcoming grant deadlines for a workspace within N days.',
    { team_id: z.string().optional(), within_days: z.number().int().default(30) },
    async ({ team_id, within_days }) => {
      const opps = await db.listOpportunities(resolveTeamId(team_id));
      const soon = opps.filter((o) => o.close_date
        && !['awarded', 'declined'].includes(o.stage)
        && (new Date(o.close_date) - Date.now()) / 86400000 <= within_days);
      return text({ deadlines: soon.map((o) => ({ title: o.title, due: o.close_date, stage: o.stage })) });
    });

  server.tool('search_grants',
    'Search live Grants.gov opportunities (proxied through grantsgov-mcp).',
    { keyword: z.string(), rows: z.number().int().max(15).default(8) },
    async ({ keyword, rows }) => text({ opportunities: await grantsGov.search({ keyword, rows }) }));

  server.tool('get_impact_meter',
    "A workspace's Grantweaver impact stats: opportunities surfaced, dollars applied for, evidence items, estimated hours saved.",
    { team_id: z.string().optional() },
    async ({ team_id }) => text(await db.impactMeter(resolveTeamId(team_id))));

  return server;
}

// ── slack_identity auth ─────────────────────────────────────────────────
// UNVERIFIED LIVE — the Slackbot MCP Client's slack_identity mode signs
// requests the same way Slack signs Events API callbacks: HMAC-SHA256 of
// "v0:{timestamp}:{raw body}" using the app's signing secret, sent as
// X-Slack-Signature / X-Slack-Request-Timestamp. The exact shape of the
// identity payload (team_id/user_id) wasn't published in fetchable docs at
// investigation time — this reads it from `_meta.slack` on the JSON-RPC body
// per the docs summary, with a defensive fallback that still refuses to
// trust a client-supplied team_id if that shape is wrong.
function verifySlackSignature(req, rawBody) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!secret || !ts || !sig) return null;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return null; // replay guard
  const hmac = crypto.createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex');
  const expected = `v0=${hmac}`;
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const parsed = JSON.parse(rawBody);
    return parsed?._meta?.slack?.team_id ?? null;
  } catch {
    return null;
  }
}

// ── Streamable HTTP — bearer (our own `claude mcp add` client, unrelated to
// the Slackbot MCP Client feature) or slack_identity (for the Slackbot MCP
// Client; only register there once this has a public URL and is
// live-verified) ──
const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
// 'bearer' (default) keeps today's shared-secret scheme for our own MCP
// client demo; 'slack_identity' is the production-correct mode for the
// Slackbot MCP Client feature — do not register the manifest under
// `no_auth`, which would let any caller supply an arbitrary team_id.
const AUTH_MODE = process.env.MCP_AUTH_MODE ?? 'bearer';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Exported so app.js can mount this on the main server's port as a custom
// route (one Railway service, one port, one TLS cert) instead of running a
// second HTTP listener in production. Standalone `npm run mcp:grantweaver`
// still works — see the self-start block below.
export async function handleMcpRequest(req, res) {
  let fixedTeamId, parsedBody;
  if (AUTH_MODE === 'slack_identity') {
    const raw = await readBody(req);
    fixedTeamId = verifySlackSignature(req, raw);
    if (!fixedTeamId) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' })); return;
    }
    parsedBody = JSON.parse(raw);
  } else if (req.headers.authorization !== `Bearer ${process.env.MCP_SHARED_SECRET}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' })); return;
  }

  const server = buildServer(fixedTeamId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

// Self-start a standalone HTTP server only when run directly
// (`npm run mcp:grantweaver` / local dev) — not when imported by app.js.
if (import.meta.url === `file://${process.argv[1]}`) {
  const http = await import('node:http');
  const PORT = Number(process.env.GRANTWEAVER_MCP_PORT ?? 7802);
  http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    await handleMcpRequest(req, res);
  }).listen(PORT, () => console.log(`grantweaver-mcp listening on :${PORT}/mcp (auth=${AUTH_MODE})`));
}
