"""Pipeline for connections received via the Chrome extension webhook."""
from __future__ import annotations

import asyncio
import logging

from app import db
from app.config import require_env_vars
from app.slack_bot import post_run_summary
from app.workflow import build_enrichment_from_webhook, get_slack_client, process_connection

logger = logging.getLogger(__name__)


async def process_new_connections(connections: list[dict]) -> dict:
    """Process new connections from the Chrome extension webhook."""
    require_env_vars("SUPABASE_URL", "SUPABASE_KEY")

    errors: list[str] = []
    processed = 0
    slack, slack_channel, slack_error = get_slack_client()
    if slack_error:
        errors.append(slack_error)

    seen_urns: set[str] = set()
    unique_connections: list[dict] = []
    for conn in connections:
        urn = conn.get("linkedin_urn", "")
        if urn and urn not in seen_urns:
            seen_urns.add(urn)
            unique_connections.append(conn)

    known_urns = await asyncio.to_thread(db.get_all_urns)
    new_connections = [conn for conn in unique_connections if conn["linkedin_urn"] not in known_urns]

    if not new_connections:
        logger.info("Webhook: all %d connections already known", len(connections))
        return {"processed": 0, "skipped": len(connections), "errors": errors}

    logger.info("Webhook: %d new connections (of %d received)", len(new_connections), len(connections))

    for conn in new_connections:
        name = f"{conn.get('first_name', '')} {conn.get('last_name', '')}".strip()
        try:
            enrichment = build_enrichment_from_webhook(conn)
            result = await process_connection(
                conn,
                enrichment,
                slack=slack,
                slack_channel=slack_channel,
            )
            if not result.get("skipped"):
                processed += 1
        except Exception as exc:
            logger.exception("Failed to process connection %s", name)
            errors.append(f"{name}: {exc}")

    if slack and slack_channel:
        await asyncio.to_thread(post_run_summary, processed, errors, False, slack, slack_channel)

    return {"processed": processed, "skipped": len(connections) - len(new_connections), "errors": errors}
