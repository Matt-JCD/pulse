"""Pipeline for connections received via Chrome extension webhook.

Skips LinkedIn API entirely — the extension provides detection + basic profile data.
Flow: dedupe → insert DB → Attio upsert → Claude draft → Slack approval.
"""
from __future__ import annotations

import asyncio
import logging

from slack_sdk import WebClient

from app import db
from app.attio_sync import upsert_person
from app.config import (
    ANTHROPIC_API_KEY,
    ATTIO_API_KEY,
    SLACK_BOT_TOKEN,
    SLACK_CHANNEL,
    require_env_vars,
)
from app.drafter import draft_message
from app.slack_bot import post_approval, post_run_summary

BLOCKING_CALL_TIMEOUT = 60
logger = logging.getLogger(__name__)


def _build_enrichment_from_webhook(conn: dict) -> dict:
    """Build an enrichment dict from the Chrome extension's connection data.

    The extension gives us: linkedin_urn, public_identifier, first_name,
    last_name, headline. We structure it like the LinkedIn enricher would
    so downstream code (Attio, drafter) works unchanged.
    """
    return {
        "profile": {
            "firstName": conn.get("first_name", ""),
            "lastName": conn.get("last_name", ""),
            "headline": conn.get("headline", ""),
            "publicIdentifier": conn.get("public_identifier", ""),
            "public_id": conn.get("public_identifier", ""),
            "locationName": "",
            "industryName": "",
            "summary": "",
        },
        "contact_info": {},
        "recent_posts": [],
    }


async def process_new_connections(connections: list[dict]) -> dict:
    """Process new connections from the Chrome extension webhook."""
    require_env_vars("SLACK_BOT_TOKEN", "SLACK_CHANNEL", "ANTHROPIC_API_KEY")

    errors: list[str] = []
    processed = 0
    slack = WebClient(token=SLACK_BOT_TOKEN)

    # Dedupe within the batch first (extension can send duplicates across pages)
    seen_urns: set[str] = set()
    unique_connections: list[dict] = []
    for c in connections:
        urn = c.get("linkedin_urn", "")
        if urn and urn not in seen_urns:
            seen_urns.add(urn)
            unique_connections.append(c)

    # Then dedupe against Supabase
    known_urns = await asyncio.to_thread(db.get_all_urns)
    new_connections = [c for c in unique_connections if c["linkedin_urn"] not in known_urns]

    if not new_connections:
        logger.info("Webhook: all %d connections already known", len(connections))
        return {"processed": 0, "skipped": len(connections), "errors": []}

    logger.info("Webhook: %d new connections (of %d received)", len(new_connections), len(connections))

    for conn in new_connections:
        name = f"{conn.get('first_name', '')} {conn.get('last_name', '')}".strip()
        try:
            # Insert into Supabase (upsert handles any remaining races)
            row = await asyncio.to_thread(db.upsert_connection, conn)
            connection_id = row["id"]

            # Skip if this connection was already processed (status beyond "new")
            if row.get("status") not in (None, "new"):
                logger.info("Skipping %s — already in status '%s'", name, row["status"])
                continue

            # Build enrichment from what the extension gave us
            enrichment = _build_enrichment_from_webhook(conn)
            await asyncio.to_thread(db.set_status, connection_id, "enriched")

            # Push to Attio (non-fatal — continue if Attio fails)
            if ATTIO_API_KEY:
                try:
                    attio_id = await upsert_person(enrichment, ATTIO_API_KEY)
                    await asyncio.to_thread(db.set_attio_id, connection_id, attio_id)
                except Exception as e:
                    logger.warning("Attio upsert failed for %s: %s", name, e)

            # Draft message via Claude
            draft = await asyncio.wait_for(
                asyncio.to_thread(draft_message, enrichment, ANTHROPIC_API_KEY),
                timeout=BLOCKING_CALL_TIMEOUT,
            )
            await asyncio.to_thread(db.set_draft, connection_id, draft)

            # Post to Slack for approval
            conn_for_slack = await asyncio.to_thread(db.get_connection, connection_id)
            ts = await asyncio.to_thread(post_approval, conn_for_slack, slack, SLACK_CHANNEL)
            await asyncio.to_thread(db.set_slack_ts, connection_id, ts)

            processed += 1
        except Exception as e:
            logger.exception("Failed to process connection %s", name)
            errors.append(f"{name}: {e}")

    await asyncio.to_thread(
        post_run_summary, processed, errors, False, slack, SLACK_CHANNEL
    )

    return {"processed": processed, "skipped": len(connections) - len(new_connections), "errors": errors}
