-- Merge the manual evidence locker into the same evidence_index the org page
-- shows, so a human's :thread:-save actually strengthens a visible theme bar
-- instead of only bumping an invisible counter. Files/photos get their own
-- theme so they surface distinctly (per Chaitanya: index should foreground
-- files/images from manual saves, not just scan-derived message themes).
ALTER TABLE evidence_pointers ADD COLUMN IF NOT EXISTS is_file BOOLEAN DEFAULT false;
