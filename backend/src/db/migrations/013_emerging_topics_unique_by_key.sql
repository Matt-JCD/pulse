-- Migration 013: use stable topic_key for daily upsert uniqueness
DROP INDEX IF EXISTS uq_emerging_topics_daily_topic;

CREATE UNIQUE INDEX IF NOT EXISTS uq_emerging_topics_daily_topic
  ON emerging_topics (date, platform, category, topic_key);

INSERT INTO _migrations (name) VALUES ('013_emerging_topics_unique_by_key.sql')
ON CONFLICT (name) DO NOTHING;
