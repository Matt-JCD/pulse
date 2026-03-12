from __future__ import annotations

import logging
import time

from supabase import Client

from app import db
from app.config import DAILY_SEND_LIMIT, PB_MESSAGE_SENDER_AGENT_ID, SEND_BATCH_LIMIT, SEND_LAUNCH_PAUSE_SECONDS
from app.outreach_policy import sanitize_message_for_pb
from app.phantombuster import expected_webhook_url, launch_message_sender
from app.state_machine import transition_status

logger = logging.getLogger(__name__)


def _launch_send_for_row(supabase_client: Client, row: dict) -> dict:
    """Launch PB sender for a specific approved outreach row."""
    profile_url = row.get("linkedin_profile_url")
    original_message = row.get("approved_message") or row.get("draft_message")
    message = sanitize_message_for_pb(original_message or "")
    if not profile_url or not message:
        logger.warning("Skipping %s - missing profile URL or message", row["id"])
        return {"status": "skipped"}

    try:
        if original_message and message != original_message:
            logger.info(
                "[outreach:send] Sanitized PB message for %s from %d to %d chars",
                row["id"],
                len(original_message),
                len(message),
            )
        logger.info(
            "[outreach:send] Launching PB sender agentId=%s outreach=%s webhook=%s",
            PB_MESSAGE_SENDER_AGENT_ID or "<missing>",
            row["id"],
            expected_webhook_url() or "<not-configured>",
        )
        result = launch_message_sender(profile_url, message)
        container_id = result.get("containerId")
        db.update_outreach(row["id"], {"pb_send_container_id": container_id})
        transition_status(supabase_client, row["id"], "send_queued")
        logger.info("[outreach:send] PB launch queued for %s (container=%s)", row["id"], container_id)
        return {"status": "launched", "container_id": container_id}
    except Exception as e:
        logger.exception("Failed to launch send for %s", row["id"])
        return {"status": "error", "error": str(e)}


def launch_outreach_send(
    supabase_client: Client,
    outreach_id: str,
    bypass_daily_limit: bool = False,
) -> dict:
    """Launch a send immediately for one specific approved outreach row."""
    row = db.get_outreach(outreach_id)
    if not row:
        return {"status": "error", "error": f"Outreach {outreach_id} not found"}
    if row.get("status") != "approved":
        return {
            "status": "skipped",
            "reason": f"status is {row.get('status')}, not approved",
        }

    if not bypass_daily_limit:
        sent_today = db.get_sent_today_count()
        remaining = max(0, DAILY_SEND_LIMIT - sent_today)
        if remaining <= 0:
            logger.info("[outreach:send] Daily send limit reached for %s. Leaving approved.", outreach_id)
            return {"status": "deferred", "reason": "daily_limit"}

    return _launch_send_for_row(supabase_client, row)


def launch_approved_sends(
    supabase_client: Client,
    limit: int | None = None,
    bypass_daily_limit: bool = False,
) -> dict:
    """
    Launch PB message-sender for approved outreach rows, respecting DAILY_SEND_LIMIT.
    Processes oldest-approved first. Sleeps 2s between launches.
    Returns {"launched": int, "skipped": int, "errors": list[str]}.
    """
    sent_today = db.get_sent_today_count()
    remaining = max(0, DAILY_SEND_LIMIT - sent_today)
    logger.info(
        "[outreach:send] Daily limit: %d/%d sent today, %d remaining%s",
        sent_today,
        DAILY_SEND_LIMIT,
        remaining,
        " (bypass enabled)" if bypass_daily_limit else "",
    )

    if remaining == 0 and not bypass_daily_limit:
        logger.info("[outreach:send] Daily send limit reached. Skipping.")
        return {"launched": 0, "skipped": 0, "errors": []}

    requested_limit = limit if limit is not None else SEND_BATCH_LIMIT
    capped_limit = min(requested_limit, SEND_BATCH_LIMIT)
    if bypass_daily_limit:
        fetch_limit = capped_limit
    else:
        fetch_limit = min(capped_limit, remaining)
    rows = db.get_approved_outreach(limit=fetch_limit)
    launched = 0
    skipped = 0
    errors: list[str] = []

    for index, row in enumerate(rows):
        result = _launch_send_for_row(supabase_client, row)
        if result["status"] == "skipped":
            skipped += 1
            continue
        if result["status"] == "launched":
            launched += 1
            if index < len(rows) - 1:
                time.sleep(SEND_LAUNCH_PAUSE_SECONDS)
            continue
        if result["status"] == "error":
            errors.append(f"{row['id']}: {result['error']}")

    logger.info("[outreach:send] Complete: launched=%d, skipped=%d, errors=%d", launched, skipped, len(errors))
    return {"launched": launched, "skipped": skipped, "errors": errors}
