-- Migration 012: add stable cross-day topic key for tracking trend continuity
ALTER TABLE emerging_topics
  ADD COLUMN IF NOT EXISTS topic_key TEXT;

UPDATE emerging_topics
SET topic_key = lower(category) || '::' || lower(keyword) || '::' || trim(regexp_replace(regexp_replace(lower(topic_title), '[^a-z0-9\s]+', ' ', 'g'), '\s+', ' ', 'g'))
WHERE topic_key IS NULL OR topic_key = '';

ALTER TABLE emerging_topics
  ALTER COLUMN topic_key SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_emerging_topics_topic_key
  ON emerging_topics (topic_key);

INSERT INTO _migrations (name) VALUES ('012_emerging_topics_topic_key.sql')
ON CONFLICT (name) DO NOTHING;
