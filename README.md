<p align="center">
  <img src="assets/grantweaver-transparent.png" alt="Grantweaver" width="180" />
</p>

# Grantweaver

**Turn your nonprofit's conversations into funding.**

Grantweaver is a Slack agent for the full grant lifecycle. It finds live
federal funding on Grants.gov, mines your own workspace for cited impact
evidence using Slack's Real-Time Search API, drafts grounded proposals into
Canvases, and tracks the whole pipeline from your App Home.

The problem it attacks: 69% of nonprofits lost funding this year, and small
orgs have no grant writer. The proof funders ask for (attendance numbers,
parent testimonials, program wins) is already sitting in Slack, posted by the
people who did the work and forgotten within a week. Grantweaver puts it back
to work.

<!-- demo GIF goes here before submission -->

## The three challenge technologies, and where they live

| Technology | What it does here | Where |
|---|---|---|
| Slack AI capabilities | The agent surface: streaming replies, statuses, suggested prompts, feedback buttons | `src/assistant.js`, `src/agent/loop.js` |
| Real-Time Search API | The evidence engine: live, permission-aware workspace search with citations back to source messages | `src/agent/rts.js`, `src/agent/tools.js` |
| MCP | Both directions: `grantsgov-mcp` (a Grants.gov server we built and consume) and `grantweaver-mcp` (exposes the grant pipeline to Claude, Cursor, Agentforce, or any MCP client) | `src/mcp/` |

## Quickstart

1. Create a Slack app from `manifest.json` at [api.slack.com/apps](https://api.slack.com/apps) and install it to your workspace.
2. `cp .env.example .env` and fill in the Slack tokens, an LLM key, and a Postgres URL.
3. ```bash
   npm install
   npm run migrate
   npm run dev
   ```
4. Open the Grantweaver agent in Slack and ask it to find grants for your mission.

The LLM client is provider-agnostic (any OpenAI-compatible endpoint). Pick a
model with `npm run llm:bakeoff`, which tests tool-calling correctness and
latency against a replica of the real agent turn.

## Privacy by architecture

Grantweaver never stores message content. The evidence locker holds
permalinks and tags; at drafting time the agent re-reads each source live
through Slack's Real-Time Search, so deletions and permissions are respected
automatically. Drafts always cite their sources, and nothing goes out without
human review.

## License

[MIT](LICENSE)
