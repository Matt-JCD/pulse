"""Pipeline helpers for connections received via the Chrome extension webhook."""
from __future__ import annotations

import asyncio
import logging

from app import db
from app.config import require_env_vars
from app.slack_bot import post_run_summary
from app.workflow import (
    build_enrichment_from_row,
    build_enrichment_from_webhook,
    get_slack_client,
    process_connection,
)

logger = logging.getLogger(__name__)


def _dedupe_connections(connections: list[dict]) -> list[dict]:
    seen_urns: set[str] = set()
    unique_connections: list[dict] = []
    for conn in connections:
        urn = conn.get("linkedin_urn", "")
        if urn and urn not in seen_urns:
            seen_urns.add(urn)
            unique_connections.append(conn)
    return unique_connections


async def persist_new_connections(connections: list[dict]) -> dict:
    """Persist webhook connections quickly so the request can return before drafting/slack work."""
    require_env_vars("SUPABASE_URL", "SUPABASE_KEY")

    unique_connections = _dedupe_connections(connections)
    known_urns = await asyncio.to_thread(db.get_all_urns)
    new_connections = [conn for conn in unique_connections if conn["linkedin_urn"] not in known_urns]

    if not new_connections:
        logger.info("Webhook: all %d connections already known", len(connections))
        return {
            "accepted": 0,
            "skipped": len(connections),
            "errors": [],
            "connection_ids": [],
        }

    connection_ids: list[str] = []
    errors: list[str] = []

    for conn in new_connections:
        name = f"{conn.get('first_name', '')} {conn.get('last_name', '')}".strip() or conn.get("linkedin_urn", "")
        try:
            row = await asyncio.to_thread(db.upsert_connection, conn)
            connection_id = row["id"]
            enrichment = build_enrichment_from_webhook(conn)
            await asyncio.to_thread(db.set_enrichment, connection_id, enrichment)
            await asyncio.to_thread(db.set_status, connection_id, "enriched")
            connection_ids.append(connection_id)
        except Exception as exc:
            logger.exception("Failed to persist webhook connection %s", name)
            errors.append(f"{name}: {exc}")

    logger.info(
        "Webhook: accepted %d new connections (of %d received)",
        len(connection_ids),
        len(connections),
    )
    return {
        "accepted": len(connection_ids),
        "skipped": len(connections) - len(new_connections),
        "errors": errors,
        "connection_ids": connection_ids,
    }


async def process_persisted_connections(connection_ids: list[str]) -> dict:
    """Draft and post persisted connections to Slack in the background."""
    if not connection_ids:
        return {"processed": 0, "errors": []}

    errors: list[str] = []
    processed = 0
    slack, slack_channel, slack_error = get_slack_client()
    if slack_error:
        errors.append(slack_error)

    for connection_id in connection_ids:
        try:
            row = await asyncio.to_thread(db.get_connection, connection_id)
            if not row:
                errors.append(f"{connection_id}: connection not found after persist")
                continue

            enrichment = build_enrichment_from_row(row)
            result = await process_connection(
                row,
                enrichment,
                slack=slack,
                slack_channel=slack_channel,
                allow_retry=True,
            )
            if not result.get("skipped"):
                processed += 1
        except Exception as exc:
            logger.exception("Failed to process persisted connection %s", connection_id)
            errors.append(f"{connection_id}: {exc}")

    if slack and slack_channel:
        await asyncio.to_thread(post_run_summary, processed, errors, False, slack, slack_channel)

    return {"processed": processed, "errors": errors}
