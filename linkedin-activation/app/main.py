from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from typing import Optional

from fastapi import FastAPI, Query, Request, Response
from slack_sdk import WebClient

from app import db
from app.attio_sync import add_sent_note
from app.config import (
    ATTIO_API_KEY,
    SLACK_BOT_TOKEN,
    SLACK_CHANNEL,
    SLACK_SIGNING_SECRET,
    require_env_vars,
)
from app.pipeline import run_pipeline
from app.pipeline_webhook import process_new_connections
from app.slack_bot import handle_approve, handle_edit, handle_edit_submit, handle_skip
from app.workflow import build_enrichment_from_row, get_slack_client, process_connection

app = FastAPI(title="LinkedIn Activation Engine")
logger = logging.getLogger(__name__)


def process_approve_action(connection_id: str) -> None:
    """Mark connection as pending_send for Chrome extension to pick up."""
    slack = WebClient(token=SLACK_BOT_TOKEN)
    try:
        logger.info("Queuing send for connection %s", connection_id)
        handle_approve(connection_id, slack, SLACK_CHANNEL)
    except Exception:
        logger.exception("Approve action failed for connection %s", connection_id)
        slack.chat_postMessage(
            channel=SLACK_CHANNEL,
            text=f"Approval failed for connection {connection_id}. Check Render logs.",
        )


def verify_slack_signature(body: bytes, timestamp: str, signature: str) -> bool:
    """Verify that the request actually came from Slack."""
    try:
        parsed_timestamp = int(timestamp)
    except (TypeError, ValueError):
        return False

    if abs(time.time() - parsed_timestamp) > 60 * 5:
        return False
    base = f"v0:{parsed_timestamp}:{body.decode('utf-8')}"
    expected = "v0=" + hmac.new(
        SLACK_SIGNING_SECRET.encode(), base.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


@app.get("/health")
async def health():
    try:
        return {
            "status": "ok",
            "last_run": await asyncio.to_thread(db.get_last_run_timestamp),
            "connections_tracked": await asyncio.to_thread(db.get_total_count),
            "connections_sent": await asyncio.to_thread(db.get_sent_count),
        }
    except Exception as e:
        return {"status": "ok", "db_error": str(e)}



@app.get("/connections")
async def list_connections(
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
):
    return await asyncio.to_thread(db.get_connections, status, limit)


@app.post("/run")
async def trigger_run(dry_run: bool = Query(False)):
    """Trigger a pipeline run and return the result."""
    try:
        result = await run_pipeline(dry_run=dry_run)
        return {"status": "completed", "dry_run": dry_run, **result}
    except Exception as e:
        return {"status": "error", "error": str(e)}


@app.post("/webhook/new-connections")
async def webhook_new_connections(request: Request):
    """Receive new connections from the Chrome extension."""
    body = await request.json()
    connections = body.get("connections", [])
    if not connections:
        return {"status": "ok", "message": "No connections provided", "processed": 0}

    try:
        result = await process_new_connections(connections)
        return {"status": "ok", **result}
    except Exception as e:
        logger.exception("Webhook processing failed")
        return {"status": "error", "error": str(e)}


@app.get("/known-urns")
async def known_urns():
    """Return all URNs the backend already knows about (for extension first-run diff)."""
    urns = await asyncio.to_thread(db.get_all_urns)
    return list(urns)


@app.post("/retry-enriched")
async def retry_enriched(limit: int = Query(10, ge=1, le=50)):
    """Retry connections that reached enrichment/draft but never made it to review."""
    rows = await asyncio.to_thread(
        db.get_connections_by_statuses,
        ["enriched", "drafted", "slack_failed"],
        limit,
    )
    if not rows:
        return {"status": "ok", "message": "No retryable connections found", "processed": 0}

    slack, slack_channel, slack_error = get_slack_client()
    processed = 0
    errors = [slack_error] if slack_error else []

    for row in rows:
        name = f"{row['first_name']} {row['last_name']}"
        try:
            enrichment = build_enrichment_from_row(row)
            await process_connection(
                row,
                enrichment,
                slack=slack,
                slack_channel=slack_channel,
                allow_retry=True,
            )
            processed += 1
        except Exception as e:
            logger.exception("Retry failed for %s", name)
            errors.append(f"{name}: {e}")

    return {"status": "ok", "processed": processed, "errors": errors}


@app.get("/pending-sends")
async def pending_sends():
    """Chrome extension polls this to find messages it needs to send."""
    rows = await asyncio.to_thread(db.get_connections, "pending_send", 50)
    return [
        {
            "id": r["id"],
            "linkedin_urn": r["linkedin_urn"],
            "public_identifier": r["public_identifier"],
            "first_name": r["first_name"],
            "last_name": r["last_name"],
            "draft_message": r["draft_message"],
        }
        for r in rows
    ]


@app.post("/confirm-send/{connection_id}")
async def confirm_send(connection_id: str):
    """Chrome extension calls this after successfully sending a LinkedIn DM."""
    conn = await asyncio.to_thread(db.get_connection, connection_id)
    if not conn:
        return {"status": "error", "error": "Connection not found"}

    await asyncio.to_thread(db.set_status, connection_id, "sent")

    # Log to Attio (non-fatal)
    if ATTIO_API_KEY and conn.get("attio_record_id"):
        try:
            await add_sent_note(conn["attio_record_id"], conn["draft_message"], ATTIO_API_KEY)
        except Exception as e:
            logger.warning("Attio note failed for %s: %s", connection_id, e)

    # Update Slack message
    if conn.get("slack_message_ts"):
        try:
            slack = WebClient(token=SLACK_BOT_TOKEN)
            await asyncio.to_thread(
                slack.chat_update,
                channel=SLACK_CHANNEL,
                ts=conn["slack_message_ts"],
                text=f"Sent to {conn['first_name']} {conn['last_name']}",
                blocks=[],
            )
        except Exception as e:
            logger.warning("Slack update failed for %s: %s", connection_id, e)

    return {"status": "ok", "connection_id": connection_id}


@app.post("/slack/events")
async def slack_events(request: Request):
    try:
        require_env_vars("SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "SLACK_CHANNEL")

        if request.headers.get("content-type", "").startswith("application/json"):
            payload = await request.json()
            if payload.get("type") == "url_verification":
                return Response(
                    status_code=200,
                    media_type="application/json",
                    content=json.dumps({"challenge": payload.get("challenge", "")}),
                )
            return Response(status_code=400, content="Unsupported Slack JSON payload")

        body = await request.body()
        timestamp = request.headers.get("X-Slack-Request-Timestamp", "")
        signature = request.headers.get("X-Slack-Signature", "")

        if not verify_slack_signature(body, timestamp, signature):
            return Response(status_code=401, content="Invalid signature")

        from urllib.parse import parse_qs

        parsed = parse_qs(body.decode("utf-8"))
        payload_str = parsed.get("payload", ["{}"])[0]
        payload = json.loads(payload_str)

        payload_type = payload.get("type")
        slack = WebClient(token=SLACK_BOT_TOKEN)

        if payload_type == "block_actions":
            for action in payload.get("actions", []):
                action_id = action["action_id"]
                connection_id = action["value"]

                if action_id == "approve_message":
                    asyncio.create_task(
                        asyncio.to_thread(process_approve_action, connection_id)
                    )

                elif action_id == "skip_message":
                    asyncio.create_task(
                        asyncio.to_thread(handle_skip, connection_id, slack, SLACK_CHANNEL)
                    )

                elif action_id == "edit_message":
                    trigger_id = payload["trigger_id"]
                    asyncio.create_task(
                        asyncio.to_thread(handle_edit, connection_id, trigger_id, slack)
                    )

        elif payload_type == "view_submission":
            view = payload["view"]
            if view.get("callback_id") == "edit_draft_modal":
                connection_id = view["private_metadata"]
                new_draft = view["state"]["values"]["draft_block"]["draft_input"]["value"]
                await asyncio.to_thread(handle_edit_submit, connection_id, new_draft, slack, SLACK_CHANNEL)

        return Response(status_code=200)
    except Exception:
        logger.exception("Slack events handler crashed")
        return Response(status_code=500, content="Slack events handler crashed")
