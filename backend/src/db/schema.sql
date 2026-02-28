-- Pulse Database Schema
-- Run this in the Supabase SQL Editor: https://supabase.com/dashboard → SQL Editor → New query

-- Migration tracking
CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  ran_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 001: Config
CREATE TABLE IF NOT EXISTS config (
  id                    INTEGER PRIMARY KEY DEFAULT 1,
  llm_provider          TEXT DEFAULT 'anthropic',
  llm_model             TEXT DEFAULT 'claude-haiku-4-5-20251001',
  anthropic_api_key     TEXT,
  openai_api_key        TEXT,
  mistral_api_key       TEXT,
  scrapebadger_api_key  TEXT,
  linkedapi_key         TEXT,
  daily_run_time_utc    TEXT DEFAULT '22:00',
  linkedin_frequency    TEXT DEFAULT 'every_other_day',
  posts_per_keyword     INTEGER DEFAULT 20,
  report_email          TEXT,
  email_report_enabled  BOOLEAN DEFAULT FALSE,
  prefactor_sdk_key     TEXT,
  updated_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 002: Keywords
CREATE TABLE IF NOT EXISTS keywords (
  id         SERIAL PRIMARY KEY,
  keyword    TEXT NOT NULL UNIQUE,
  active     BOOLEAN DEFAULT TRUE,
  category   TEXT NOT NULL DEFAULT 'ecosystem',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 003: Keyword Signals
CREATE TABLE IF NOT EXISTS keyword_signals (
  id         SERIAL PRIMARY KEY,
  date       DATE NOT NULL,
  platform   TEXT NOT NULL,
  keyword    TEXT NOT NULL,
  post_count INTEGER NOT NULL,
  sentiment  TEXT NOT NULL,
  momentum   TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'ecosystem',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(date, platform, keyword)
);

-- 004: Emerging Topics
CREATE TABLE IF NOT EXISTS emerging_topics (
  id           SERIAL PRIMARY KEY,
  date         DATE NOT NULL,
  platform     TEXT NOT NULL,
  keyword      TEXT NOT NULL,
  topic_key    TEXT NOT NULL,
  topic_title  TEXT NOT NULL,
  summary      TEXT NOT NULL,
  post_count   INTEGER NOT NULL,
  sample_urls  TEXT[],
  category     TEXT NOT NULL DEFAULT 'ecosystem',
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_emerging_topics_daily_topic
  ON emerging_topics (date, platform, category, topic_key);
CREATE INDEX IF NOT EXISTS idx_emerging_topics_topic_key
  ON emerging_topics (topic_key);

-- 005: Daily Report (synthesizer output)
CREATE TABLE IF NOT EXISTS daily_report (
  id                   SERIAL PRIMARY KEY,
  date                 DATE NOT NULL UNIQUE,
  ecosystem_synthesis  TEXT,
  enterprise_synthesis TEXT,
  sentiment_score      FLOAT,
  sentiment_direction  VARCHAR(2),
  sentiment_label      VARCHAR(20),
  slack_post_text      TEXT,
  posted_at            TIMESTAMP WITH TIME ZONE,
  created_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 006: Run Log
CREATE TABLE IF NOT EXISTS run_log (
  id            SERIAL PRIMARY KEY,
  date          DATE NOT NULL,
  function_name TEXT NOT NULL,
  status        TEXT NOT NULL,
  duration_ms   INTEGER,
  posts_fetched INTEGER,
  llm_tokens    INTEGER,
  error_msg     TEXT,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 007: Posts
CREATE TABLE IF NOT EXISTS posts (
  id                SERIAL PRIMARY KEY,
  platform          TEXT NOT NULL,
  content           TEXT NOT NULL,
  status            TEXT DEFAULT 'draft',
  scheduled_at      TIMESTAMP WITH TIME ZONE,
  published_at      TIMESTAMP WITH TIME ZONE,
  platform_post_id  TEXT,
  source_topic      TEXT,
  source_keyword    TEXT,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 008: Post Analytics
CREATE TABLE IF NOT EXISTS post_analytics (
  id               SERIAL PRIMARY KEY,
  post_id          INTEGER REFERENCES posts(id),
  impressions      INTEGER DEFAULT 0,
  engagements      INTEGER DEFAULT 0,
  clicks           INTEGER DEFAULT 0,
  replies          INTEGER DEFAULT 0,
  likes            INTEGER DEFAULT 0,
  fetched_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 009: Inbox Items
CREATE TABLE IF NOT EXISTS inbox_items (
  id               SERIAL PRIMARY KEY,
  platform         TEXT NOT NULL,
  platform_item_id TEXT NOT NULL UNIQUE,
  post_id          INTEGER REFERENCES posts(id),
  type             TEXT NOT NULL,
  author_name      TEXT,
  author_handle    TEXT,
  content          TEXT,
  status           TEXT DEFAULT 'unread',
  received_at      TIMESTAMP WITH TIME ZONE,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Record migrations as applied
INSERT INTO _migrations (name) VALUES
  ('001_config.sql'),
  ('002_keywords.sql'),
  ('003_keyword_signals.sql'),
  ('004_emerging_topics.sql'),
  ('005_daily_report.sql'),
  ('006_run_log.sql'),
  ('007_posts.sql'),
  ('008_post_analytics.sql'),
  ('009_inbox_items.sql'),
  ('010_alter_daily_report.sql'),
  ('011_emerging_topics_unique.sql'),
  ('012_emerging_topics_topic_key.sql'),
  ('013_emerging_topics_unique_by_key.sql')
ON CONFLICT (name) DO NOTHING;

-- Seed: default config
INSERT INTO config (id, llm_provider, llm_model, daily_run_time_utc, linkedin_frequency, posts_per_keyword, email_report_enabled)
VALUES (1, 'anthropic', 'claude-haiku-4-5-20251001', '22:00', 'every_other_day', 20, FALSE)
ON CONFLICT (id) DO NOTHING;

-- Seed: default keywords
INSERT INTO keywords (keyword) VALUES
  ('claude'),
  ('claude code'),
  ('anthropic'),
  ('model context protocol'),
  ('webmcp'),
  ('openai'),
  ('codex'),
  ('google gemini'),
  ('mistral'),
  ('langchain'),
  ('langsmith'),
  ('langfuse'),
  ('cursor'),
  ('a2a')
ON CONFLICT (keyword) DO NOTHING;
