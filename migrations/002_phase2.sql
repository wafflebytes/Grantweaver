-- Phase 2. Pointers/metadata only — the Class-A guard from
-- 001_init.sql applies to every table below. No column may hold Slack
-- message content.

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS watched_channels  TEXT[] DEFAULT '{}';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS post_channels     TEXT[] DEFAULT '{}';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS onboarding_state  JSONB;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS index_built_at    TIMESTAMPTZ;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS eligibility_facts JSONB;
  -- eligibility_facts: org-declared facts used by the screener, e.g.
  -- {"entity_type":"501c3","years_operating":6,"has_sam_uei":false}
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS magic_token_secret TEXT;

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS owner_user_id        TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS fit_score            INT;      -- 0..100
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS fit_rationale        TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS eligibility_verdict  TEXT
  CHECK (eligibility_verdict IN ('eligible','likely_not','unknown') OR eligibility_verdict IS NULL);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS eligibility_reason   TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS checklist            JSONB;
  -- checklist: [{"id":"narrative","label":"Project narrative (≤10 pages)","done":false,"kind":"document"},…]
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS canvas_written_at    TIMESTAMPTZ;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS last_activity_at     TIMESTAMPTZ DEFAULT now();
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS forecast             BOOLEAN DEFAULT FALSE;

-- gw:ev:link needs a join column on evidence_pointers. `strength` backs the
-- evidenceCardV2 "Strength: weak/solid/star" overflow action —
-- distinct from `tag` (evidence kind: metric/story/testimonial/other).
ALTER TABLE evidence_pointers ADD COLUMN IF NOT EXISTS opp_id TEXT;
ALTER TABLE evidence_pointers ADD COLUMN IF NOT EXISTS strength TEXT DEFAULT 'solid'
  CHECK (strength IN ('weak','solid','star'));
CREATE INDEX IF NOT EXISTS idx_evid_opp ON evidence_pointers(team_id, opp_id);

-- Activity log: append-only trail per opportunity ("stage moved by @a",
-- "canvas revised: 3 sections", "human edited List row"). Metadata sentences
-- authored by US, never copied Slack content.
CREATE TABLE IF NOT EXISTS opp_activity (
  id          BIGSERIAL PRIMARY KEY,
  team_id     TEXT NOT NULL,
  opp_id      TEXT NOT NULL,
  actor       TEXT,               -- user id, 'agent', or 'system'
  kind        TEXT NOT NULL,      -- stage_move|draft|revision|list_edit|owner|checklist|watch|note
  summary     TEXT NOT NULL,      -- our own wording only
  at          TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_opp ON opp_activity(team_id, opp_id, at DESC);

-- Watches: standing queries/agencies/forecasted opps the org tracks.
CREATE TABLE IF NOT EXISTS watches (
  id            BIGSERIAL PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES orgs(team_id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('query','agency','opp')),
  params        JSONB NOT NULL,   -- {"keyword":"youth mentoring"} | {"agency":"OJJDP"} | {"opp_id":"358xxx"}
  created_by    TEXT,
  last_run_at   TIMESTAMPTZ,
  last_seen_ids TEXT[] DEFAULT '{}',  -- opp ids already surfaced (dedupe)
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_watches_team ON watches(team_id);

-- Evidence index: the onboarding scan's output. Counts, themes, pointers —
-- NO snippets, NO message text (Class-A).
CREATE TABLE IF NOT EXISTS evidence_index (
  id          BIGSERIAL PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES orgs(team_id) ON DELETE CASCADE,
  theme       TEXT NOT NULL,      -- our label, e.g. 'attendance & academics'
  channel_id  TEXT NOT NULL,
  channel_name TEXT,
  strength    TEXT DEFAULT 'solid' CHECK (strength IN ('weak','solid','star')),
  hits        INT DEFAULT 0,
  permalinks  TEXT[] DEFAULT '{}',  -- up to 5 sample pointers
  has_files   BOOLEAN DEFAULT FALSE,
  scanned_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (team_id, theme, channel_id)
);

-- Pending intents: confirm-before-generate. A card offers a slow
-- action; the row holds its params until the user confirms or it expires.
CREATE TABLE IF NOT EXISTS pending_intents (
  id           BIGSERIAL PRIMARY KEY,
  team_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,     -- draft|revise|export_pack|answers|rescan
  params       JSONB NOT NULL,
  requested_by TEXT,
  channel_id   TEXT,              -- where the confirm card lives
  message_ts   TEXT,              -- ts of the confirm card (reaction-confirm needs it)
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending','running','done','cancelled','expired')),
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intents_msg ON pending_intents(channel_id, message_ts);

-- Match-teaching signals ("Not relevant") + proactivity throttles.
CREATE TABLE IF NOT EXISTS signals (
  id         BIGSERIAL PRIMARY KEY,
  team_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,       -- not_relevant|harvest_posted|nudge_posted|update_request
  subject    TEXT NOT NULL,       -- opp_id | channel_id | opp_id
  detail     TEXT,                -- e.g. the not-relevant reason chosen
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signals ON signals(team_id, kind, subject, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_opp_owner ON opportunities(team_id, owner_user_id);
