import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let clientPromise = null;

async function getClient() {
  clientPromise ??= (async () => {
    const c = new Client({ name: 'grantweaver-app', version: '0.1.0' });
    if (process.env.GRANTSGOV_MCP_TRANSPORT === 'http') {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      await c.connect(new StreamableHTTPClientTransport(new URL(process.env.GRANTSGOV_MCP_URL)));
    } else {
      await c.connect(new StdioClientTransport({
        command: 'node', args: ['src/mcp/grantsgov-server.mjs'],
      }));
    }
    return c;
  })().catch((e) => { clientPromise = null; throw e; });
  return clientPromise;
}

// Unlike llm.js's client, this MCP call had no timeout at all — a stalled
// grantsgov-server (or its network path) left a tool call, and therefore the
// whole agent turn, hanging indefinitely with an empty stream and no error
// (live-reproduced: a "pipeline add" turn stuck on fetch_opportunity for
// minutes with nothing surfaced). Race it against a deadline so the turn's
// own catch can close the stream out honestly instead of hanging forever.
async function callTool(name, args, timeoutMs = 30_000) {
  const c = await getClient();
  const res = await Promise.race([
    c.callTool({ name, arguments: args }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`grantsgov MCP call "${name}" timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
  const payload = res?.content?.[0]?.text ?? '{}';
  return JSON.parse(payload);
}

export const grantsGov = {
  async search({ keyword, oppStatuses = 'posted|forecasted', rows = 10, eligibilities, agencies }) {
    const out = await callTool('search_grants', {
      keyword, oppStatuses, rows,
      ...(eligibilities ? { eligibilities } : {}),
      ...(agencies ? { agencies } : {}),
    });
    return out.opportunities ?? [];
  },
  async fetchOpportunity(oppId) {
    return callTool('fetch_opportunity', { opp_id: String(oppId) });
  },
};
