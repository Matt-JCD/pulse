from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from slack_sdk import WebClient

from app import db
from app.attio_sync import upsert_person
from app.config import ANTHROPIC_API_KEY, ATTIO_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL
from app.drafter import draft_message
from app.slack_bot import post_approval

BLOCKING_CALL_TIMEOUT = 60
FINAL_STATUSES = {"awaiting_review", "pending_send", "sent", "skipped"}
logger = logging.getLogger(__name__)


def build_enrichment_from_webhook(conn: dict) -> dict:
    experience = conn.get("experience", [])
    return {
        "profile": {
            "firstName": conn.get("first_name", ""),
            "lastName": conn.get("last_name", ""),
            "headline": conn.get("headline", ""),
            "publicIdentifier": conn.get("public_identifier", ""),
            "public_id": conn.get("public_identifier", ""),
            "locationName": conn.get("location", ""),
            "industryName": conn.get("industry", ""),
            "summary": conn.get("summary", ""),
            "experience": experience,
        },
        "contact_info": {},
        "recent_posts": [{"text": p} if isinstance(p, str) else p for p in conn.get("recent_posts", [])],
    }


def build_enrichment_from_row(row: dict) -> dict:
    experience = row.get("experience") or []
    recent_posts = row.get("recent_posts") or []
    if isinstance(experience, str):
        try:
            experience = json.loads(experience)
        except json.JSONDecodeError:
            experience = []
    if isinstance(recent_posts, str):
        try:
            recent_posts = json.loads(recent_posts)
        except json.JSONDecodeError:
            recent_posts = []

    return {
        "profile": {
            "firstName": row.get("first_name", ""),
            "lastName": row.get("last_name", ""),
            "headline": row.get("headline", ""),
            "publicIdentifier": row.get("public_identifier", ""),
            "public_id": row.get("public_identifier", ""),
            "locationName": row.get("location", ""),
            "industryName": row.get("industry", ""),
            "summary": row.get("summary", ""),
            "experience": experience,
        },
        "contact_info": {},
        "recent_posts": recent_posts,
    }


def can_skip_processing(status: Optional[str]) -> bool:
    return bool(status in FINAL_STATUSES)


def get_slack_client() -> tuple[Optional[WebClient], Optional[str], Optional[str]]:
    if not SLACK_BOT_TOKEN or not SLACK_CHANNEL:
        return None, None, "Slack is not configured"
    return WebClient(token=SLACK_BOT_TOKEN), SLACK_CHANNEL, None


async def process_connection(
    conn: dict,
    enrichment: dict,
    *,
    slack: Optional[WebClient],
    slack_channel: Optional[str],
    allow_retry: bool = False,
    review_required: bool = True,
) -> dict:
    row = await asyncio.to_thread(db.upsert_connection, conn)
    connection_id = row["id"]
    current_status = row.get("status")

    if can_skip_processing(current_status):
        logger.info("Skipping %s; already in terminal status '%s'", connection_id, current_status)
        return {"id": connection_id, "status": current_status, "skipped": True}

    if current_status and not allow_retry and current_status not in (None, "new"):
        logger.info("Skipping %s; already in status '%s'", connection_id, current_status)
        return {"id": connection_id, "status": current_status, "skipped": True}

    await asyncio.to_thread(db.set_enrichment, connection_id, enrichment)
    await asyncio.to_thread(db.set_status, connection_id, "enriched")

    if ATTIO_API_KEY:
        try:
            attio_id = await upsert_person(enrichment, ATTIO_API_KEY)
            await asyncio.to_thread(db.set_attio_id, connection_id, attio_id)
        except Exception as exc:
            logger.warning("Attio upsert failed for %s: %s", connection_id, exc)

    draft = row.get("draft_message") if allow_retry and current_status in {"drafted", "slack_failed"} else None
    if not draft:
        if not ANTHROPIC_API_KEY:
            message = "ANTHROPIC_API_KEY is not configured"
            await asyncio.to_thread(db.set_error, connection_id, "draft_failed", message)
            raise RuntimeError(message)

        draft = await asyncio.wait_for(
            asyncio.to_thread(draft_message, enrichment, ANTHROPIC_API_KEY),
            timeout=BLOCKING_CALL_TIMEOUT,
        )
        await asyncio.to_thread(db.set_draft, connection_id, draft, "drafted")
    else:
        await asyncio.to_thread(db.set_status, connection_id, "drafted")

    if not review_required:
        return {"id": connection_id, "status": "drafted", "draft_message": draft}

    if not slack or not slack_channel:
        await asyncio.to_thread(db.set_error, connection_id, "slack_failed", "Slack is not configured")
        return {"id": connection_id, "status": "slack_failed", "draft_message": draft}

    conn_for_slack = await asyncio.to_thread(db.get_connection, connection_id)
    try:
        ts = await asyncio.to_thread(post_approval, conn_for_slack, slack, slack_channel)
        await asyncio.to_thread(db.set_slack_ts, connection_id, ts, slack_channel, "awaiting_review")
        return {"id": connection_id, "status": "awaiting_review", "draft_message": draft}
    except Exception as exc:
        await asyncio.to_thread(db.set_error, connection_id, "slack_failed", str(exc))
        raise
