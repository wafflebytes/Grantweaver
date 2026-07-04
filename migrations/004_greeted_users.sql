-- The DM welcome message's de-dupe lived in an in-process Set, which every
-- deploy/restart wiped clean — during a night of many redeploys this meant
-- the "Hey! I'm Grantweaver..." intro kept re-firing on every app_home_opened
-- after each restart. Persist it instead.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS greeted_users TEXT[] DEFAULT '{}';
