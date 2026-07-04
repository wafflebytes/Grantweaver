ALTER TABLE orgs ADD COLUMN IF NOT EXISTS evidence_list_id TEXT;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS evidence_list_columns JSONB;
ALTER TABLE evidence_pointers ADD COLUMN IF NOT EXISTS list_item_id TEXT;
