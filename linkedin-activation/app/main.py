from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from typing import Optional

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Request, Response
from slack_sdk import WebClient

from app import db
from app.attio_sync import sync_all_unsynced
from app.config import (
    ADMIN_API_KEY,
    APP_BASE_URL,
    DAILY_SEND_LIMIT,
    PB_CONNECTIONS_AGENT_ID,
    PB_MESSAGE_SENDER_AGENT_ID,
    SLACK_BOT_TOKEN,
    SLACK_CHANNEL,
    SLACK_SIGNING_SECRET,
    require_env_vars,
)
from app.detection_launcher import launch_detection
from app.drafter import draft_all_detected
from app.phantombuster import expected_webhook_url, launch_message_sender, validate_webhook_secret
from app.phantombuster_webhook import process_pb_webhook
from app.send_launcher import launch_approved_sends
from app.slack_bot import (
    handle_outreach_approve, handle_outreach_edit, handle_outreach_edit_submit,
    handle_outreach_reject,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = FastAPI(title="LinkedIn Activation Engine")
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Admin auth dependency
# ---------------------------------------------------------------------------

def verify_admin_key(x_api_key: str = Header(alias="x-api-key", default="")) -> None:
    if not ADMIN_API_KEY or not hmac.compare_digest(x_api_key, ADMIN_API_KEY):
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


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


# ---------------------------------------------------------------------------
# Health & info
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Outreach pipeline jobs (cron-triggered)
# ---------------------------------------------------------------------------

@app.post("/jobs/detect-new-connections")
async def detect_new_connections_job(date_after: Optional[str] = Query(None)):
    """Cron-triggered. Launches PB connections export agent."""
    try:
        result = await asyncio.to_thread(launch_detection, date_after)
        return {"status": "launched", **result}
    except Exception as e:
        logger.exception("[outreach:detection] Detection launch failed")
        return {"status": "error", "error": str(e)}


@app.post("/jobs/draft-outreach")
async def draft_outreach_job(limit: int = Query(25, ge=1, le=200)):
    """Cron-triggered. Drafts messages for detected connections in batches."""
    supabase = db.get_db()
    count = await asyncio.to_thread(draft_all_detected, supabase, limit)
    return {"drafted": count, "limit": limit}


@app.post("/jobs/enrich-and-redraft")
async def enrich_and_redraft_job(
    limit: int = Query(5, ge=1, le=50),
    status: str = Query("detected"),
):
    """Re-enrich and re-draft outreach rows. Use status=awaiting_review to redo existing drafts."""
    from app.drafter import enrich_and_store, generate_outreach_draft
    from app.state_machine import transition_status

    supabase = db.get_db()
    rows = await asyncio.to_thread(db.get_outreach_by_status, status, limit)
    results = {"enriched": 0, "drafted": 0, "errors": []}

    for row in rows:
        try:
            row = await asyncio.to_thread(enrich_and_store, supabase, row["id"], row)
            results["enriched"] += 1

            draft_text = await asyncio.to_thread(generate_outreach_draft, row)
            await asyncio.to_thread(db.update_outreach, row["id"], {"draft_message": draft_text})
            results["drafted"] += 1
        except Exception as e:
            results["errors"].append(f"{row.get('full_name')}: {str(e)[:100]}")

    return results


@app.post("/jobs/launch-approved-sends")
async def launch_approved_sends_job():
    """Cron-triggered. Launches PB message sender for approved outreach rows."""
    supabase = db.get_db()
    result = await asyncio.to_thread(launch_approved_sends, supabase)
    return result


@app.post("/jobs/send-simon-test")
async def send_simon_test_job():
    """
    Temporary operator endpoint.
    Draft and send a message to Simon Russell entirely server-side using live env vars.
    """
    from app.drafter import generate_outreach_draft
    from app.linkdapi import enrich_profile

    profile_url = "https://www.linkedin.com/in/simonrussell/"
    research = await asyncio.to_thread(enrich_profile, "simonrussell")
    profile = research.get("profile") or {}
    row = {
        "full_name": " ".join(part for part in [profile.get("firstName"), profile.get("lastName")] if part).strip() or "Simon Russell",
        "first_name": profile.get("firstName") or "Simon",
        "last_name": profile.get("lastName") or "Russell",
        "headline": profile.get("headline") or "",
        "linkedin_profile_url": profile_url,
        "public_identifier": "simonrussell",
        "research": research,
    }
    draft_text = await asyncio.to_thread(generate_outreach_draft, row)
    result = await asyncio.to_thread(launch_message_sender, profile_url, draft_text)
    return {
        "status": "launched",
        "profile_url": profile_url,
        "draft_message": draft_text,
        **result,
    }


# ---------------------------------------------------------------------------
# Outreach actions
# ---------------------------------------------------------------------------

@app.post("/outreach/{outreach_id}/retry-send")
async def retry_outreach_send(outreach_id: str):
    """Retry a failed send by moving it back to approved."""
    from app.state_machine import transition_status

    row = await asyncio.to_thread(db.get_outreach, outreach_id)
    if not row:
        return {"status": "error", "error": "Outreach not found"}
    if row["status"] != "send_failed":
        return {"status": "error", "error": f"Cannot retry — status is {row['status']}, not send_failed"}
    if (row.get("retry_count") or 0) >= 3:
        return {"status": "error", "error": "Max retries (3) reached"}

    supabase = db.get_db()
    await asyncio.to_thread(transition_status, supabase, outreach_id, "approved")
    return {"status": "ok", "outreach_id": outreach_id}


@app.post("/admin/outreach/retry-send", dependencies=[Depends(verify_admin_key)])
async def admin_retry_outreach_send(profile_url: str = Query(..., alias="profile_url")):
    """Retry a failed send by LinkedIn profile URL for operator convenience."""
    from app.state_machine import transition_status

    row = await asyncio.to_thread(db.get_outreach_by_profile_url, profile_url)
    if not row:
        return {"status": "error", "error": "Outreach not found", "profile_url": profile_url}
    if row["status"] != "send_failed":
        return {
            "status": "error",
            "error": f"Cannot retry - status is {row['status']}, not send_failed",
            "outreach_id": row["id"],
            "profile_url": profile_url,
        }
    if (row.get("retry_count") or 0) >= 3:
        return {
            "status": "error",
            "error": "Max retries (3) reached",
            "outreach_id": row["id"],
            "profile_url": profile_url,
        }

    supabase = db.get_db()
    await asyncio.to_thread(transition_status, supabase, row["id"], "approved")
    return {"status": "ok", "outreach_id": row["id"], "profile_url": profile_url}


# ---------------------------------------------------------------------------
# PhantomBuster webhook
# ---------------------------------------------------------------------------

@app.post("/phantombuster/webhook")
async def phantombuster_webhook(request: Request, background_tasks: BackgroundTasks):
    """Receive webhook callbacks from PhantomBuster after agent runs complete."""
    secret = request.query_params.get("secret", "")
    if not validate_webhook_secret(secret):
        return Response(status_code=401, content="Invalid secret")

    payload = await request.json()
    logger.info("[webhook] PB webhook received: %s", {k: v for k, v in payload.items() if k != "output"})
    background_tasks.add_task(process_pb_webhook, payload)
    return {"status": "accepted"}


# ---------------------------------------------------------------------------
# Admin endpoints (protected by ADMIN_API_KEY)
# ---------------------------------------------------------------------------

@app.get("/admin/outreach/status", dependencies=[Depends(verify_admin_key)])
async def outreach_status():
    """Dashboard-style overview of the outreach pipeline."""
    counts = await asyncio.to_thread(db.get_outreach_status_counts)
    failures = await asyncio.to_thread(db.get_recent_failures, 10)
    sent_today = await asyncio.to_thread(db.get_sent_today_count)
    attio = await asyncio.to_thread(db.get_outreach_attio_stats)

    return {
        "counts": counts,
        "recent_failures": failures,
        "send_today": {"sent": sent_today, "limit": DAILY_SEND_LIMIT},
        "attio": attio,
    }


@app.get("/admin/outreach/config", dependencies=[Depends(verify_admin_key)])
async def outreach_config():
    """Operator diagnostics for the PB-linked outreach pipeline."""
    webhook_url = expected_webhook_url()
    return {
        "app_base_url": APP_BASE_URL or None,
        "pb_connections_agent_id": PB_CONNECTIONS_AGENT_ID or None,
        "pb_message_sender_agent_id": PB_MESSAGE_SENDER_AGENT_ID or None,
        "pb_webhook_secret_configured": bool(webhook_url),
        "expected_webhook_url": webhook_url or None,
    }


@app.get("/admin/outreach/failures", dependencies=[Depends(verify_admin_key)])
async def outreach_failures(limit: int = Query(10, ge=1, le=100)):
    """Recent failed outreach sends with enough metadata for targeted retries."""
    failures = await asyncio.to_thread(db.get_recent_failures, limit)
    return {"failures": failures, "limit": limit}


@app.post("/admin/attio/sync-connections", dependencies=[Depends(verify_admin_key)])
async def sync_connections_to_attio(
    status: Optional[str] = Query(None),
    limit: Optional[int] = Query(None, ge=1, le=200),
    dry_run: bool = Query(False),
):
    """Sync unsynced outreach connections to Attio as People + Companies."""
    if dry_run:
        rows = await asyncio.to_thread(db.get_unsynced_outreach, status, limit)
        return {"dry_run": True, "would_sync": len(rows)}

    supabase = db.get_db()
    result = await asyncio.to_thread(sync_all_unsynced, supabase, status, limit)
    return result


# ---------------------------------------------------------------------------
# Slack interactivity
# ---------------------------------------------------------------------------

@app.post("/slack/events")
async def slack_events(request: Request):
    try:
        require_env_vars("SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN")

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

        if payload_type == "block_actions":
            for action in payload.get("actions", []):
                action_id = action["action_id"]
                outreach_id = action["value"]

                if action_id == "outreach_approve":
                    logger.info("[outreach:slack] Approve action for %s", outreach_id)
                    supabase_client = db.get_db()
                    asyncio.create_task(
                        asyncio.to_thread(handle_outreach_approve, supabase_client, outreach_id)
                    )

                elif action_id == "outreach_edit":
                    logger.info("[outreach:slack] Edit action for %s", outreach_id)
                    trigger_id = payload["trigger_id"]
                    supabase_client = db.get_db()
                    asyncio.create_task(
                        asyncio.to_thread(handle_outreach_edit, supabase_client, outreach_id, trigger_id)
                    )

                elif action_id == "outreach_reject":
                    logger.info("[outreach:slack] Reject action for %s", outreach_id)
                    supabase_client = db.get_db()
                    asyncio.create_task(
                        asyncio.to_thread(handle_outreach_reject, supabase_client, outreach_id)
                    )

        elif payload_type == "view_submission":
            view = payload["view"]
            if view.get("callback_id") == "outreach_edit_modal":
                outreach_id = view["private_metadata"]
                edited_text = view["state"]["values"]["outreach_draft_block"]["outreach_draft_input"]["value"]
                supabase_client = db.get_db()
                await asyncio.to_thread(handle_outreach_edit_submit, supabase_client, outreach_id, edited_text)

        return Response(status_code=200)
    except Exception:
        logger.exception("Slack events handler crashed")
        return Response(status_code=500, content="Slack events handler crashed")
