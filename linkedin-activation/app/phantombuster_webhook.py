from __future__ import annotations

import csv
import io
import json
import logging
from datetime import datetime, timezone

from slack_sdk import WebClient

from app import db
from app.attio_sync import parse_company_from_headline
from app.config import (
    PB_CONNECTIONS_AGENT_ID,
    PB_MESSAGE_SENDER_AGENT_ID,
    OUTREACH_SLACK_CHANNEL,
    SLACK_BOT_TOKEN,
)
from app.phantombuster import fetch_agent_info, download_result_csv
from app.state_machine import transition_status

logger = logging.getLogger(__name__)

# Re-export for backwards compat with existing tests
_parse_company_from_headline = parse_company_from_headline


def _find_first_value(obj, candidate_keys: tuple[str, ...]):
    """Recursively find the first matching key in a nested dict/list payload."""
    if isinstance(obj, dict):
        for key in candidate_keys:
            if key in obj and obj[key] not in (None, ""):
                return obj[key]
        for value in obj.values():
            found = _find_first_value(value, candidate_keys)
            if found not in (None, ""):
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _find_first_value(item, candidate_keys)
            if found not in (None, ""):
                return found
    return None


def _extract_webhook_metadata(payload: dict) -> dict[str, object]:
    """Normalize PhantomBuster webhook payloads across flat and nested variants."""
    return {
        "agent_id": _find_first_value(payload, ("agentId", "agent_id", "phantomId", "phantom_id")),
        "agent_name": _find_first_value(payload, ("agentName", "agent_name", "phantomName", "phantom_name")),
        "container_id": _find_first_value(payload, ("containerId", "container_id", "launchId", "launch_id")) or "?",
        "exit_code": _find_first_value(payload, ("exitCode", "exit_code", "statusCode", "status_code")),
        "exit_message": _find_first_value(payload, ("exitMessage", "exit_message", "status", "message")),
    }


def _public_identifier_from_url(url: str) -> str:
    """Extract public identifier from a LinkedIn profile URL."""
    return url.rstrip("/").split("/")[-1]


# ---------------------------------------------------------------------------
# Connections export complete
# ---------------------------------------------------------------------------

def handle_connections_result(payload: dict) -> dict:
    """Process a successful connections export webhook from PhantomBuster."""
    container_id = payload["containerId"]
    agent_id = payload["agentId"]

    agent_info = fetch_agent_info(agent_id)
    s3_folder = agent_info["s3Folder"]
    org_s3_folder = agent_info["orgS3Folder"]

    csv_text = download_result_csv(s3_folder, org_s3_folder)
    reader = csv.DictReader(io.StringIO(csv_text))

    new_ids: list[str] = []
    skipped = 0

    for row in reader:
        profile_url = row.get("profileUrl", "").strip()
        if not profile_url:
            continue

        headline = row.get("title", "")
        data = {
            "linkedin_profile_url": profile_url,
            "public_identifier": _public_identifier_from_url(profile_url),
            "full_name": row.get("fullName", ""),
            "first_name": row.get("firstName", ""),
            "last_name": row.get("lastName", ""),
            "headline": headline,
            "company": _parse_company_from_headline(headline),
            "connection_since": row.get("connectionSince") or None,
            "status": "detected",
            "pb_connections_container_id": container_id,
        }
        result = db.upsert_outreach_connection(data)

        if result.get("status") == "detected" and result.get("pb_connections_container_id") == container_id:
            new_ids.append(result["id"])
        else:
            skipped += 1

    logger.info(
        "[outreach:detection] Webhook processed: %d new connections, %d skipped (container %s)",
        len(new_ids), skipped, container_id,
    )
    return {"new_ids": new_ids, "skipped": skipped}


# ---------------------------------------------------------------------------
# Message send complete
# ---------------------------------------------------------------------------

def handle_send_success(payload: dict) -> None:
    """Process a successful message send webhook from PhantomBuster."""
    container_id = payload["containerId"]
    row = db.get_outreach_by_container_id(container_id)
    if not row:
        logger.warning("Send success webhook: no row for container %s", container_id)
        return

    supabase_client = db.get_db()
    transition_status(supabase_client, row["id"], "sent")
    db.update_outreach(row["id"], {
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "last_error": None,
    })
    logger.info("[outreach:send] Message sent for %s (container %s)", row.get("full_name"), container_id)

    _update_slack_message(row, "Sent")


def handle_send_failure(payload: dict) -> None:
    """Process a failed message send webhook from PhantomBuster."""
    container_id = payload["containerId"]
    exit_message = payload.get("exitMessage", "Unknown error")
    row = db.get_outreach_by_container_id(container_id)
    if not row:
        logger.warning("Send failure webhook: no row for container %s", container_id)
        return

    supabase_client = db.get_db()
    transition_status(supabase_client, row["id"], "send_failed")
    db.update_outreach(row["id"], {
        "last_error": exit_message[:1000],
        "send_result": json.dumps(payload),
        "retry_count": (row.get("retry_count") or 0) + 1,
    })

    logger.warning("[outreach:send] Send failed for %s: %s (container %s)", row.get("full_name"), exit_message, container_id)
    _update_slack_message(row, f"Failed: {exit_message}")


# ---------------------------------------------------------------------------
# Slack helpers
# ---------------------------------------------------------------------------

def _update_slack_message(row: dict, status_text: str) -> None:
    """Update the Slack message for an outreach row."""
    if not SLACK_BOT_TOKEN or not row.get("slack_message_ts"):
        return

    channel = row.get("slack_channel") or OUTREACH_SLACK_CHANNEL
    if not channel:
        return

    name = row.get("full_name") or f"{row.get('first_name', '')} {row.get('last_name', '')}".strip()
    try:
        slack = WebClient(token=SLACK_BOT_TOKEN)
        slack.chat_update(
            channel=channel,
            ts=row["slack_message_ts"],
            text=f"{status_text}: {name}",
            blocks=[],
        )
    except Exception:
        logger.exception("Slack update failed for outreach %s", row.get("id"))


# ---------------------------------------------------------------------------
# Main dispatcher (called from background task)
# ---------------------------------------------------------------------------

def process_pb_webhook(payload: dict) -> None:
    """Route a PhantomBuster webhook payload to the correct handler."""
    meta = _extract_webhook_metadata(payload)
    agent_id = meta["agent_id"]
    exit_code = meta["exit_code"]
    container_id = str(meta["container_id"])
    agent_name = meta["agent_name"]

    logger.info(
        "[webhook] Processing PB webhook: agentId=%s agentName=%s exitCode=%s(%s) containerId=%s",
        agent_id, agent_name, exit_code, type(exit_code).__name__, container_id,
    )

    try:
        # PB may send exitCode as string or int
        is_success = str(exit_code) == "0"

        if agent_id == PB_CONNECTIONS_AGENT_ID:
            if is_success:
                handle_connections_result(payload)
            else:
                logger.error(
                    "Connections agent failed (container %s): exit %s — %s",
                    container_id, exit_code, payload.get("exitMessage"),
                )

        elif agent_id == PB_MESSAGE_SENDER_AGENT_ID:
            if is_success:
                handle_send_success(payload)
            else:
                handle_send_failure(payload)

        else:
            logger.warning(
                "Unknown agentId in PB webhook: %s agentName=%s keys=%s",
                agent_id, agent_name, list(payload.keys()),
            )

    except Exception:
        logger.exception("[webhook] process_pb_webhook crashed for container %s", container_id)
