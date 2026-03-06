from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from typing import Optional

from fastapi import FastAPI, Request, Response, Query
from slack_sdk import WebClient

from app.config import (
    LI_EMAIL, LI_PASSWORD, LI_AT, LI_JSESSIONID, ATTIO_API_KEY,
    SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_CHANNEL,
)
from app import db
from app.linkedin_client import get_client
from app.slack_bot import handle_approve, handle_skip, handle_edit, handle_edit_submit
from app.pipeline import run_pipeline


app = FastAPI(title="LinkedIn Activation Engine")


# ---------------------------------------------------------------------------
# Slack request verification
# ---------------------------------------------------------------------------

def verify_slack_signature(body: bytes, timestamp: str, signature: str) -> bool:
    """Verify that the request actually came from Slack."""
    if abs(time.time() - int(timestamp)) > 60 * 5:
        return False
    base = f"v0:{timestamp}:{body.decode('utf-8')}"
    expected = "v0=" + hmac.new(
        SLACK_SIGNING_SECRET.encode(), base.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


# ---------------------------------------------------------------------------
# Health & status endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    try:
        return {
            "status": "ok",
            "last_run": db.get_last_run_timestamp(),
            "connections_tracked": db.get_total_count(),
            "connections_sent": db.get_sent_count(),
        }
    except Exception as e:
        return {"status": "ok", "db_error": str(e)}


@app.get("/debug/auth")
async def debug_auth():
    """Check if LinkedIn cookies are loaded and valid."""
    return {
        "li_at_set": bool(LI_AT),
        "li_at_length": len(LI_AT),
        "li_at_prefix": LI_AT[:10] + "..." if LI_AT else "",
        "jsessionid_set": bool(LI_JSESSIONID),
        "jsessionid_length": len(LI_JSESSIONID),
        "jsessionid_value": LI_JSESSIONID[:20] + "..." if LI_JSESSIONID else "",
    }


@app.get("/connections")
async def list_connections(
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
):
    return db.get_connections(status=status, limit=limit)


# ---------------------------------------------------------------------------
# Manual trigger
# ---------------------------------------------------------------------------

@app.post("/run")
async def trigger_run(dry_run: bool = Query(False)):
    """Trigger a pipeline run and return the result."""
    try:
        result = await run_pipeline(dry_run=dry_run)
        return {"status": "completed", "dry_run": dry_run, **result}
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ---------------------------------------------------------------------------
# Slack interactive webhook
# ---------------------------------------------------------------------------

@app.post("/slack/events")
async def slack_events(request: Request):
    body = await request.body()
    timestamp = request.headers.get("X-Slack-Request-Timestamp", "")
    signature = request.headers.get("X-Slack-Signature", "")

    if not verify_slack_signature(body, timestamp, signature):
        return Response(status_code=401, content="Invalid signature")

    # Slack sends interactive payloads as form-encoded with a "payload" field
    form = await request.form()
    payload = json.loads(form.get("payload", "{}"))

    payload_type = payload.get("type")
    slack = WebClient(token=SLACK_BOT_TOKEN)

    # Button actions (Approve / Edit / Skip)
    if payload_type == "block_actions":
        for action in payload.get("actions", []):
            action_id = action["action_id"]
            connection_id = action["value"]

            if action_id == "approve_message":
                li = get_client(LI_EMAIL, LI_PASSWORD, LI_AT, LI_JSESSIONID)
                await handle_approve(connection_id, li, ATTIO_API_KEY, slack, SLACK_CHANNEL)

            elif action_id == "skip_message":
                handle_skip(connection_id, slack, SLACK_CHANNEL)

            elif action_id == "edit_message":
                trigger_id = payload["trigger_id"]
                handle_edit(connection_id, trigger_id, slack)

    # Modal submission (Edit draft saved)
    elif payload_type == "view_submission":
        view = payload["view"]
        if view.get("callback_id") == "edit_draft_modal":
            connection_id = view["private_metadata"]
            new_draft = view["state"]["values"]["draft_block"]["draft_input"]["value"]
            handle_edit_submit(connection_id, new_draft, slack, SLACK_CHANNEL)

    return Response(status_code=200)
