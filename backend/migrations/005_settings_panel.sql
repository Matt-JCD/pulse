-- Migration: Settings Panel support
-- 1. Add platforms JSONB to keywords
-- 2. Add notification columns to config
-- 3. Create api_connections table

-- 1a. Add platforms column
ALTER TABLE keywords ADD COLUMN IF NOT EXISTS platforms jsonb NOT NULL DEFAULT '["reddit","hn"]'::jsonb;

-- 2. Notification columns on config singleton
ALTER TABLE config ADD COLUMN IF NOT EXISTS alert_on_failure boolean NOT NULL DEFAULT true;
ALTER TABLE config ADD COLUMN IF NOT EXISTS alert_on_no_posts boolean NOT NULL DEFAULT true;
ALTER TABLE config ADD COLUMN IF NOT EXISTS daily_summary_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE config ADD COLUMN IF NOT EXISTS notification_email text DEFAULT NULL;

-- 3. API connections table
CREATE TABLE IF NOT EXISTS api_connections (
  id serial PRIMARY KEY,
  provider text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'unknown',
  last_checked_at timestamptz,
  error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Seed default providers
INSERT INTO api_connections (provider) VALUES
  ('anthropic'),
  ('openai'),
  ('scrapebadger'),
  ('linkedapi'),
  ('x_api'),
  ('linkedin_api')
ON CONFLICT (provider) DO NOTHING;
