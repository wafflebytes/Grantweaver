CREATE TABLE IF NOT EXISTS agent_runs (
  id BIGSERIAL PRIMARY KEY,
  team_id TEXT,
  user_id TEXT,
  channel_id TEXT,
  thread_ts TEXT DEFAULT '',
  surface TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  request_message_ts TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','success','partial','failure','cancelled','blocked')),
  total_latency_ms INT,
  model TEXT,
  tools_called JSONB NOT NULL DEFAULT '[]',
  retry_attempts INT DEFAULT 0,
  input_tokens INT,
  output_tokens INT,
  total_tokens INT,
  estimated_cost_usd NUMERIC,
  token_efficiency REAL,
  error_type TEXT,
  error_message TEXT,
  channels_accessed JSONB NOT NULL DEFAULT '[]',
  artifacts JSONB NOT NULL DEFAULT '[]',
  cancel_requested_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_team_started ON agent_runs(team_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_audit_events (
  id BIGSERIAL PRIMARY KEY,
  team_id TEXT,
  user_id TEXT,
  run_id BIGINT REFERENCES agent_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_audit_team_created ON agent_audit_events(team_id, created_at DESC);

