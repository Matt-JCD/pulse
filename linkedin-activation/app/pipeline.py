from __future__ import annotations

import asyncio
import argparse
import time

from slack_sdk import WebClient

from app.config import (
    LI_EMAIL, LI_PASSWORD, LI_AT, LI_JSESSIONID, ANTHROPIC_API_KEY, ATTIO_API_KEY,
    SLACK_BOT_TOKEN, SLACK_CHANNEL,
)
from app import db
from app.linkedin_client import get_client
from app.detector import get_recent_connections, find_new_connections
from app.enricher import enrich_profile
from app.attio_sync import upsert_person
from app.drafter import draft_message
from app.slack_bot import post_approval, post_run_summary

RATE_LIMIT_DELAY = 3  # seconds between LinkedIn API calls


async def run_pipeline(dry_run: bool = False) -> dict:
    """Full pipeline: detect → enrich → attio → draft → slack."""
    errors: list[str] = []
    new_count = 0
    slack = WebClient(token=SLACK_BOT_TOKEN)

    # Authenticate with LinkedIn
    try:
        li = get_client(LI_EMAIL, LI_PASSWORD, LI_AT, LI_JSESSIONID)
    except Exception as e:
        errors.append(f"LinkedIn auth failed: {e}")
        post_run_summary(0, errors, dry_run, slack, SLACK_CHANNEL)
        return {"new_count": 0, "errors": errors}

    # Detect new connections
    try:
        current = get_recent_connections(li)
        time.sleep(RATE_LIMIT_DELAY)
        new = find_new_connections(current)
        new_count = len(new)
    except Exception as e:
        errors.append(f"Connection detection failed: {e}")
        post_run_summary(0, errors, dry_run, slack, SLACK_CHANNEL)
        return {"new_count": 0, "errors": errors}

    if not new:
        post_run_summary(0, errors, dry_run, slack, SLACK_CHANNEL)
        return {"new_count": 0, "errors": errors}

    # Process each new connection
    for conn_data in new:
        name = f"{conn_data.get('first_name', '')} {conn_data.get('last_name', '')}"
        try:
            # Insert into Supabase
            row = db.insert_connection(conn_data)
            connection_id = row["id"]

            # Enrich via LinkedIn
            time.sleep(RATE_LIMIT_DELAY)
            enrichment = enrich_profile(li, conn_data["public_identifier"])
            db.set_status(connection_id, "enriched")

            # Push to Attio
            attio_id = await upsert_person(enrichment, ATTIO_API_KEY)
            db.set_attio_id(connection_id, attio_id)

            # Draft message via Claude
            draft = draft_message(enrichment, ANTHROPIC_API_KEY)
            db.set_draft(connection_id, draft)

            if dry_run:
                print(f"[DRY RUN] {name}: {draft}")
                continue

            # Post to Slack for approval
            conn_for_slack = db.get_connection(connection_id)
            ts = post_approval(conn_for_slack, slack, SLACK_CHANNEL)
            db.set_slack_ts(connection_id, ts)

        except Exception as e:
            errors.append(f"{name}: {e}")
            continue

        time.sleep(RATE_LIMIT_DELAY)

    post_run_summary(new_count, errors, dry_run, slack, SLACK_CHANNEL)
    return {"new_count": new_count, "errors": errors}


def main():
    parser = argparse.ArgumentParser(description="LinkedIn Activation Pipeline")
    parser.add_argument("--dry-run", action="store_true", help="Run without sending to Slack")
    args = parser.parse_args()

    asyncio.run(run_pipeline(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
