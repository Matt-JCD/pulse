# LinkedIn Activation Engine

## What this is
PhantomBuster-driven outreach service.
Detects new LinkedIn connections, enriches profiles, pushes to Attio,
drafts personalised messages via OpenAI, routes through Slack approval,
and sends on approve.

## Key concept
FastAPI job endpoints orchestrate the workflow.
Render cron jobs call `/jobs/*` on the web service.
There is no `app.pipeline` CLI anymore.

## Stack
Python 3.12, FastAPI, OpenAI, PhantomBuster, Attio REST API,
Slack SDK, Supabase.

## Rules
- NEVER commit credentials
- NEVER send without Slack approval
- APP_BASE_URL must be the public web URL without a trailing slash
- Respect the outreach policy end-to-end: detect on a 30-minute cadence, draft/Slack max 5 per run and 50 per day, send max 5 per run and 50 per day
- Approved messages wait for the scheduled send job; Slack approval should not send immediately
- Use the throttled/backlog scripts for manual catch-up runs
- Plain English for Matt

## Commands
- uvicorn app.main:app --reload
- curl -X POST "$APP_BASE_URL/jobs/detect-new-connections"
- curl -X POST "$APP_BASE_URL/jobs/draft-outreach"
- curl -X POST "$APP_BASE_URL/jobs/launch-approved-sends"
- curl -H "x-api-key: $ADMIN_API_KEY" "$APP_BASE_URL/admin/outreach/config"
