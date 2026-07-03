CREATE TABLE IF NOT EXISTS orgs (
  team_id        TEXT PRIMARY KEY,
  org_name       TEXT,
  mission        TEXT,
  focus_areas    TEXT[] DEFAULT '{}',
  state          TEXT,
  org_size       TEXT,
  digest_channel TEXT,
  digest_cron    TEXT DEFAULT '0 9 * * 1',
  evidence_emoji TEXT DEFAULT 'thread',
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS opportunities (
  id             BIGSERIAL PRIMARY KEY,
  team_id        TEXT REFERENCES orgs(team_id) ON DELETE CASCADE,
  source         TEXT DEFAULT 'grants_gov',
  opp_id         TEXT NOT NULL,
  opp_number     TEXT,
  title          TEXT,
  agency         TEXT,
  close_date     DATE,
  award_ceiling  NUMERIC,
  url            TEXT,
  stage          TEXT DEFAULT 'suggested'
                 CHECK (stage IN ('suggested','reviewing','drafting','submitted','awarded','declined')),
  canvas_id      TEXT,
  match_score    REAL,
  added_by       TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (team_id, opp_id)
);

-- POINTERS ONLY. If you are adding a column that could hold Slack message
-- content, STOP: you are breaking the product's core compliance promise.
CREATE TABLE IF NOT EXISTS evidence_pointers (
  id             BIGSERIAL PRIMARY KEY,
  team_id        TEXT REFERENCES orgs(team_id) ON DELETE CASCADE,
  channel_id     TEXT NOT NULL,
  message_ts     TEXT NOT NULL,
  permalink      TEXT NOT NULL DEFAULT '',
  tag            TEXT DEFAULT 'story' CHECK (tag IN ('metric','story','testimonial','other')),
  saved_by       TEXT,
  saved_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE (team_id, channel_id, message_ts)
);

CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  team_id TEXT, user_id TEXT, message_ts TEXT, value TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installations (
  team_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opp_team_stage ON opportunities(team_id, stage);
CREATE INDEX IF NOT EXISTS idx_opp_close     ON opportunities(team_id, close_date);
CREATE INDEX IF NOT EXISTS idx_evid_team     ON evidence_pointers(team_id, saved_at DESC);
