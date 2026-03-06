alter table if exists linkedin_connections
  add column if not exists summary text,
  add column if not exists location text,
  add column if not exists industry text,
  add column if not exists experience jsonb default '[]'::jsonb,
  add column if not exists recent_posts jsonb default '[]'::jsonb,
  add column if not exists slack_channel text,
  add column if not exists last_error text;

create unique index if not exists linkedin_connections_linkedin_urn_idx
  on linkedin_connections (linkedin_urn);
