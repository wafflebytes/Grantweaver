# Devpost submission — what goes in every field

Everything below is paste-ready. Fields appear in the order Devpost shows them
(Manage team → Project overview → Project details → Additional info → Submit).
Character limits are from the form. Copy was written to read like a person, not
a model; edit freely but keep the numbers, they're all sourced from the impact
model.

---

## Page 1 · Project overview

### Project name (60 characters max)

```
Grantweaver: turn your nonprofit's Slack into funding
```

(53 characters. Plain `Grantweaver` also works if you want the clean brand.)

### Elevator pitch (200 characters max)

```
A Slack agent for the whole grant lifecycle. It finds live federal funding, pulls cited impact evidence out of your own workspace, and drafts proposals into Canvases. Nothing ever leaves Slack.
```

(193 characters.)

### Thumbnail

- Use `assets/grantweaver-white-bg.png`, cropped square then padded to 3:2
  (Devpost recommends 3:2, JPG/PNG/GIF, 5 MB max).
- Downscale first, the raw file is ~1.3 MB at print size. 1200×800 is plenty.
- Same image family as the video title card so the gallery looks coherent.

---

## Page 2 · Project details

### About the project (the big markdown box)

Paste this whole block:

```markdown
## Inspiration

69% of nonprofits lost funding this year, and their leaders rank funder
reporting as their #2 stressor, right behind funding itself. Small orgs
can't afford a grant writer, so the ED writes grants at midnight.

Here's what kept bugging us: everything a funder wants to see already exists
in the org's Slack. The attendance numbers a program manager posted in May.
A parent's thank-you message from March. It all scrolls away, and six months
later somebody re-interviews the whole staff to reconstruct what the
workspace already knows.

Until this February, no third-party tool could safely touch that history.
Slack's Real-Time Search API changed that: query-based, permission-aware,
nothing copied out. So we built the tool that couldn't have existed five
months ago.

## What it does

Grantweaver runs the full grant lifecycle without leaving Slack.

**Discover.** Ask it for funding and it searches Grants.gov live, through an
MCP server we built, then scores each opportunity against your mission
profile. One click adds it to your pipeline.

**Gather evidence.** The agent searches your own workspace with the
Real-Time Search API and returns evidence cards, each one linked to the
original message. Staff can file new evidence just by reacting with 🧵.

**Draft.** It re-reads that evidence live, works it into a letter of intent
or a funder report, and streams the draft into a Canvas. Every claim carries
a citation back to its source. A human reviews everything before it goes
anywhere.

**Track.** The App Home holds the pipeline board, deadline nudges, a weekly
digest, and an Impact Meter that shows its own math.

## How we built it

Node and Bolt JS on the new `Assistant` surface: streaming replies, suggested
prompts, status updates, feedback buttons. The agent core is a
provider-agnostic LLM tool loop (any OpenAI-compatible endpoint; we picked
the model with an empirical tool-calling bake-off that ships in the repo).
The evidence engine is `assistant.search.context`, with a keyword fallback
when semantic mode is unavailable. MCP runs in both directions: the agent
consumes `grantsgov-mcp`, a Grants.gov server we wrote, and exposes
`grantweaver-mcp` so Claude, Cursor, or Agentforce can read the same
pipeline. Postgres stores permalinks and metadata, never message content.
Drafts land through the Canvas API. Hosted on Railway.

## Challenges we ran into

Getting the RTS `action_token` plumbing right on a bot token took longer
than the feature it powers. Keyword-mode search needed OR-expansion before
it felt semantic. Canvas markdown has opinions about formatting that we
learned one draft at a time. And keeping card order deterministic while the
agent streams was fiddlier than it sounds.

## Accomplishments that we're proud of

The citation chain survives end to end: you can click any claim in a draft
and land on the Slack message it came from. The privacy model is
architectural rather than a policy promise, since we store pointers and
re-read sources live, deletions and permission changes are respected
automatically. And the Impact Meter means our impact claims and the
product's own telemetry are the same numbers.

## What we learned

The Real-Time Search API rewards restraint. Fetching less and citing
everything beat fetching more every time we tested. We also learned that
nonprofit staff will not tag evidence in a form, but they will react to a
teammate's win with an emoji, so that became the capture mechanism.

## What's next

Nearest term: five pilot nonprofits, then a Slack Marketplace listing.
Private-channel evidence via user-token OAuth, plus foundation and state
funding sources; each new source is just another MCP server plugged into the
same funding plane. After that, coalition co-applications over Slack
Connect. The engine itself generalizes: schools, research labs, and city
agencies all turn institutional memory into cited, human-reviewed documents.
Grants are the wedge.
```

Optional: embed the impact chart inside the story with
`![Funding trajectory](https://raw.githubusercontent.com/<user>/grantweaver/main/assets/impact-chart.png)`
once the repo is public.

### Built with (tags)

```
slack-bolt, slack-api, node.js, model-context-protocol, postgresql, grants.gov-api, railway
```

Plus the LLM provider tag once the bake-off winner is final (e.g. `gemini`
or `nvidia-nim`).

### "Try it out" links

- GitHub repo URL (public before submission)
- Demo video YouTube URL (public, captions on, under 3:00)

---

## Page 3 · Additional info

### URL to your Slack developer sandbox (required)

Paste the sandbox workspace URL, e.g. `https://yourorg.slack.com`.

Before submitting, invite **testing@devpost.com** and
**slackhack@salesforce.com** to the sandbox and confirm they can sign in.
The form warns that missing access can disqualify the project. Do this a day
early, not at the deadline.

### Slack Agents for Good Track: What impact does your project have?

```
We calculated it instead of claiming it; the full model lives in our repo.

Per organization: a small nonprofit with no grant writer spends roughly 284
staff-hours a year on grant work across discovery, evidence assembly,
drafting, and funder reports. Grantweaver returns about 236 of those hours,
six staff-weeks, or roughly $8,300 in staff capacity. Capacity is what caps
small-org applications, so those hours convert. Two more applications a year
at the sector's typical 20% success rate and a modest $25K average award is
about $10K in new funding per org, per year.

At scale: 1,000 orgs adopting (against 1.8M US nonprofits) means 236,000
hours a year returned to mission work. The equity point matters most to us.
About 88% of US nonprofits run on budgets under $1M and can afford neither a
grant writer nor $180/month discovery SaaS. Grantweaver gives a six-person
org the grant operation that well-funded orgs take for granted, on a Slack
plan that's already free for them.

Beyond the workspace: every marginal funded program lands on beneficiaries
who never touch Slack. Our grantsgov-mcp server is open source for any
civic-agent builder, and the zero-retention pointer pattern is documented as
a reference architecture for privacy-preserving Slack AI apps.

The claims are auditable inside the product: the App Home Impact Meter
computes the same counters live and discloses its heuristic in a tooltip.
```

### For Slack Agent for Organizations Track: Slack App ID

Leave blank (we're entering the For Good track). If you decide to enter both
tracks, the App ID is on your app's Basic Information page at
api.slack.com/apps, the value starting with `A`.

### "If you updated an existing project..." (Organizations track only)

Leave blank. Grantweaver is new for this hackathon.

### Architecture diagram (required, pdf/png/jpg, 35 MB max)

- Render the architecture Mermaid diagram at mermaid.live, export PNG at 2x.
- Badge the three required technologies visually: Slack AI surface, RTS API,
  MCP (both servers). Judges should get the whole story from this one image.
- Sanity check that every box in the diagram matches a file that actually
  ships in the repo.

---

## Submit checklist (the last page)

- [ ] Video: public YouTube, under 3:00, burned-in captions, no copyrighted
      music, no real-person data.
- [ ] Gallery: 5 or 6 images at 1600×1000, hero first.
- [ ] Repo public, README standing alone (no references to planning docs).
- [ ] Sandbox access confirmed for both judge accounts.
- [ ] Run the final story text through a fresh read-aloud pass. If a sentence
      sounds like a press release, cut it.
