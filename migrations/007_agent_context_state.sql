CREATE TABLE IF NOT EXISTS active_contexts (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}',
  entities JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_active_contexts_updated ON active_contexts(team_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_thread_state (
  id BIGSERIAL PRIMARY KEY,
  team_id TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('dm','channel')),
  user_id TEXT,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL DEFAULT '',
  goal TEXT,
  constraints JSONB NOT NULL DEFAULT '{}',
  decisions JSONB NOT NULL DEFAULT '[]',
  artifacts JSONB NOT NULL DEFAULT '[]',
  sources JSONB NOT NULL DEFAULT '[]',
  summary TEXT,
  last_user_message_ts TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (team_id, channel_id, thread_ts)
);
CREATE INDEX IF NOT EXISTS idx_agent_state_team_updated ON agent_thread_state(team_id, updated_at DESC);

