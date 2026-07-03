import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../services/db.js';
import { grantsGov } from './grantsgov-client.js';

function text(obj) { return { content: [{ type: 'text', text: JSON.stringify(obj) }] }; }

// One fresh McpServer per HTTP request, not a shared module-level instance:
// the SDK's Server.connect() throws "Already connected to a transport" on a
// second connect() call, which would crash the process on the very next
// request in the stateless one-shot pattern used here.
function buildServer() {
  const server = new McpServer({ name: 'grantweaver-mcp', version: '0.1.0' });

  server.tool('list_pipeline',
    "List a workspace's grant pipeline: title, agency, stage, close date, award ceiling, draft-canvas existence.",
    { team_id: z.string().describe('Slack team ID, e.g. T0123456') },
    async ({ team_id }) => text({
      pipeline: (await db.listOpportunities(team_id)).map((o) => ({
        title: o.title, agency: o.agency, stage: o.stage,
        close_date: o.close_date, award_ceiling: o.award_ceiling, has_draft: !!o.canvas_id,
      })),
    }));

  server.tool('get_deadlines',
    'Upcoming grant deadlines for a workspace within N days.',
    { team_id: z.string(), within_days: z.number().int().default(30) },
    async ({ team_id, within_days }) => {
      const opps = await db.listOpportunities(team_id);
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
    { team_id: z.string() },
    async ({ team_id }) => text(await db.impactMeter(team_id)));

  return server;
}

// ── Streamable HTTP with bearer auth ───────────────────────────────────
const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
const http = await import('node:http');
const PORT = Number(process.env.GRANTWEAVER_MCP_PORT ?? 7802);

http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return; }
  if (req.headers.authorization !== `Bearer ${process.env.MCP_SHARED_SECRET}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' })); return;
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}).listen(PORT, () => console.log(`grantweaver-mcp listening on :${PORT}/mcp`));
