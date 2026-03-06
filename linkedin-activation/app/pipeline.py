from __future__ import annotations

import argparse
import asyncio
import logging

from app.config import (
    LI_AT,
    LI_EMAIL,
    LI_JSESSIONID,
    LI_PASSWORD,
    require_env_vars,
    require_linkedin_credentials,
)
from app.detector import find_new_connections, get_recent_connections
from app.enricher import enrich_profile
from app.linkedin_client import get_client
from app.slack_bot import post_run_summary
from app.workflow import get_slack_client, process_connection

RATE_LIMIT_DELAY = 3  # seconds between LinkedIn API calls
BLOCKING_CALL_TIMEOUT = 60
logger = logging.getLogger(__name__)


async def run_pipeline(dry_run: bool = False) -> dict:
    """Full pipeline: detect -> enrich -> attio -> draft -> slack."""
    require_env_vars("SUPABASE_URL", "SUPABASE_KEY")
    require_linkedin_credentials()

    errors: list[str] = []
    new_count = 0
    slack, slack_channel, slack_error = get_slack_client()
    if slack_error:
        errors.append(slack_error)

    # Authenticate with LinkedIn
    try:
        li = await asyncio.wait_for(
            asyncio.to_thread(get_client, LI_EMAIL, LI_PASSWORD, LI_AT, LI_JSESSIONID),
            timeout=BLOCKING_CALL_TIMEOUT,
        )
    except Exception as e:
        errors.append(f"LinkedIn auth failed: {e}")
        if slack and slack_channel:
            await asyncio.to_thread(post_run_summary, 0, errors, dry_run, slack, slack_channel)
        return {"new_count": 0, "errors": errors}

    # Detect new connections
    try:
        current = await asyncio.wait_for(
            asyncio.to_thread(get_recent_connections, li),
            timeout=BLOCKING_CALL_TIMEOUT,
        )
        await asyncio.sleep(RATE_LIMIT_DELAY)
        new = await asyncio.to_thread(find_new_connections, current)
        new_count = len(new)
        logger.info("Detected %s new LinkedIn connection(s)", new_count)
    except Exception as e:
        errors.append(f"Connection detection failed: {e}")
        if slack and slack_channel:
            await asyncio.to_thread(post_run_summary, 0, errors, dry_run, slack, slack_channel)
        return {"new_count": 0, "errors": errors}

    if not new:
        if slack and slack_channel:
            await asyncio.to_thread(post_run_summary, 0, errors, dry_run, slack, slack_channel)
        return {"new_count": 0, "errors": errors}

    # Process each new connection
    for conn_data in new:
        name = f"{conn_data.get('first_name', '')} {conn_data.get('last_name', '')}"
        try:
            await asyncio.sleep(RATE_LIMIT_DELAY)
            enrichment = await asyncio.wait_for(
                asyncio.to_thread(enrich_profile, li, conn_data["public_identifier"]),
                timeout=BLOCKING_CALL_TIMEOUT,
            )
            result = await process_connection(
                conn_data,
                enrichment,
                slack=None if dry_run else slack,
                slack_channel=None if dry_run else slack_channel,
                review_required=not dry_run,
            )
            if dry_run:
                print(f"[DRY RUN] {name}: {result.get('draft_message', '')}")
                continue

        except Exception as e:
            errors.append(f"{name}: {e}")
            continue

        await asyncio.sleep(RATE_LIMIT_DELAY)

    if slack and slack_channel:
        await asyncio.to_thread(post_run_summary, new_count, errors, dry_run, slack, slack_channel)
    return {"new_count": new_count, "errors": errors}


def main():
    parser = argparse.ArgumentParser(description="LinkedIn Activation Pipeline")
    parser.add_argument("--dry-run", action="store_true", help="Run without sending to Slack")
    args = parser.parse_args()

    asyncio.run(run_pipeline(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
