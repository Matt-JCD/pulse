from __future__ import annotations

import logging
import time

from supabase import Client

from app import db
from app.config import DAILY_SEND_LIMIT, PB_MESSAGE_SENDER_AGENT_ID
from app.outreach_policy import sanitize_message_for_pb
from app.phantombuster import expected_webhook_url, launch_message_sender
from app.state_machine import transition_status

logger = logging.getLogger(__name__)


def launch_approved_sends(supabase_client: Client) -> dict:
    """
    Launch PB message-sender for approved outreach rows, respecting DAILY_SEND_LIMIT.
    Processes oldest-approved first. Sleeps 2s between launches.
    Returns {"launched": int, "skipped": int, "errors": list[str]}.
    """
    sent_today = db.get_sent_today_count()
    remaining = max(0, DAILY_SEND_LIMIT - sent_today)
    logger.info("[outreach:send] Daily limit: %d/%d sent today, %d remaining", sent_today, DAILY_SEND_LIMIT, remaining)

    if remaining == 0:
        logger.info("[outreach:send] Daily send limit reached. Skipping.")
        return {"launched": 0, "skipped": 0, "errors": []}

    rows = db.get_approved_outreach(limit=remaining)
    launched = 0
    skipped = 0
    errors: list[str] = []

    for row in rows:
        profile_url = row.get("linkedin_profile_url")
        original_message = row.get("approved_message") or row.get("draft_message")
        message = sanitize_message_for_pb(original_message or "")
        if not profile_url or not message:
            skipped += 1
            logger.warning("Skipping %s - missing profile URL or message", row["id"])
            continue

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
            launched += 1
            logger.info("[outreach:send] PB launch queued for %s (container=%s)", row["id"], container_id)

            if launched < len(rows):
                time.sleep(2)
        except Exception as e:
            logger.exception("Failed to launch send for %s", row["id"])
            errors.append(f"{row['id']}: {e}")

    logger.info("[outreach:send] Complete: launched=%d, skipped=%d, errors=%d", launched, skipped, len(errors))
    return {"launched": launched, "skipped": skipped, "errors": errors}
