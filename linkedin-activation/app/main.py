from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Request, Response
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from app import db
from app.attio_sync import sync_all_unsynced
from app.config import (
    ADMIN_API_KEY,
    APP_BASE_URL,
    DAILY_SEND_LIMIT,
    OUTREACH_SLACK_CHANNEL,
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
    handle_outreach_reject, handle_outreach_context, handle_outreach_context_submit,
    delete_outreach_slack_message,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = FastAPI(title="LinkedIn Activation Engine")
logger = logging.getLogger(__name__)
_approved_send_task: asyncio.Task | None = None


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
    return {"status": "ok"}


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
async def launch_approved_sends_job(
    limit: Optional[int] = Query(None, ge=1, le=50),
    bypass_daily_limit: bool = Query(False),
):
    """Cron-triggered. Launches PB message sender for approved outreach rows."""
    supabase = db.get_db()
    result = await asyncio.to_thread(launch_approved_sends, supabase, limit, bypass_daily_limit)
    return result


async def _run_approved_send_loop(pause_seconds: int, max_runs: int = 0) -> None:
    """Launch approved sends one at a time with a pause between PB launches."""
    global _approved_send_task

    supabase = db.get_db()
    run = 0
    try:
        while True:
            summary = await asyncio.to_thread(db.get_outreach_status_counts)
            approved = int(summary.get("approved", 0) or 0)
            queued = int(summary.get("send_queued", 0) or 0)
            logger.info(
                "[outreach:send-loop] approved=%d send_queued=%d run=%d",
                approved,
                queued,
                run,
            )
            if approved <= 0:
                logger.info("[outreach:send-loop] No approved rows remaining; stopping.")
                break
            if max_runs > 0 and run >= max_runs:
                logger.info("[outreach:send-loop] Max runs reached; stopping.")
                break

            run += 1
            result = await asyncio.to_thread(
                launch_approved_sends,
                supabase,
                1,
                True,
            )
            logger.info(
                "[outreach:send-loop] launched=%d skipped=%d errors=%d",
                result.get("launched", 0),
                result.get("skipped", 0),
                len(result.get("errors", [])),
            )
            if result.get("errors"):
                logger.warning("[outreach:send-loop] errors=%s", result["errors"])
            if int(result.get("launched", 0) or 0) <= 0:
                logger.info("[outreach:send-loop] Nothing launched; stopping.")
                break

            await asyncio.sleep(pause_seconds)
    finally:
        _approved_send_task = None


@app.post("/jobs/launch-approved-sends-throttled")
async def launch_approved_sends_throttled(
    pause_seconds: int = Query(90, ge=30, le=600),
    max_runs: int = Query(0, ge=0, le=500),
):
    """
    Start a background loop that launches approved sends one at a time with a pause.
    Uses bypass_daily_limit=True because this is a manual operator endpoint.
    """
    global _approved_send_task

    if _approved_send_task and not _approved_send_task.done():
        return {
            "status": "already_running",
            "pause_seconds": pause_seconds,
            "max_runs": max_runs,
        }

    _approved_send_task = asyncio.create_task(_run_approved_send_loop(pause_seconds, max_runs))
    return {
        "status": "started",
        "pause_seconds": pause_seconds,
        "max_runs": max_runs,
    }


@app.get("/jobs/launch-approved-sends-throttled/status")
async def launch_approved_sends_throttled_status():
    running = bool(_approved_send_task and not _approved_send_task.done())
    return {"running": running}


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


@app.post("/jobs/reset-outreach")
async def reset_outreach_job():
    """Temporary operator endpoint. Delete all rows from linkedin_outreach."""
    deleted = await asyncio.to_thread(db.delete_all_outreach)
    return {"status": "ok", "deleted": deleted}


@app.get("/jobs/outreach-import-summary")
async def outreach_import_summary(seen_count: Optional[int] = Query(None, ge=0)):
    """
    Temporary operator endpoint.
    Summarize linkedin_outreach after a fresh import and estimate filtered rows.
    """
    status_counts = await asyncio.to_thread(db.get_outreach_status_counts)
    total_outreach = sum(status_counts.values())
    response = {
        "status": "ok",
        "total_outreach": total_outreach,
        "status_counts": status_counts,
    }
    if seen_count is not None:
        response["seen_count"] = seen_count
        response["estimated_filtered"] = max(seen_count - total_outreach, 0)
    return response


@app.get("/jobs/sent-this-morning")
async def sent_this_morning(limit: int = Query(500, ge=1, le=1000)):
    """
    Temporary operator endpoint.
    List outreach rows sent since local Sydney midnight so they can be manually reviewed.
    """
    sydney = timezone(timedelta(hours=11))
    local_now = datetime.now(sydney)
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    utc_start = local_midnight.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    rows = await asyncio.to_thread(db.get_outreach_sent_since, utc_start, limit)
    for row in rows:
        row["message"] = row.get("approved_message") or row.get("draft_message") or ""
    return {
        "status": "ok",
        "timezone": "Australia/Sydney",
        "local_date": local_midnight.date().isoformat(),
        "sent_after_utc": utc_start,
        "count": len(rows),
        "rows": rows,
    }


@app.get("/jobs/sent-this-morning-full")
async def sent_this_morning_full(limit: int = Query(500, ge=1, le=1000)):
    """
    Temporary operator endpoint.
    Return full linkedin_outreach rows sent since local Sydney midnight.
    """
    sydney = timezone(timedelta(hours=11))
    local_now = datetime.now(sydney)
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    utc_start = local_midnight.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    rows = await asyncio.to_thread(db.get_full_outreach_sent_since, utc_start, limit)
    return {
        "status": "ok",
        "timezone": "Australia/Sydney",
        "local_date": local_midnight.date().isoformat(),
        "sent_after_utc": utc_start,
        "count": len(rows),
        "rows": rows,
    }


@app.post("/jobs/reject-approved-outreach")
async def reject_approved_outreach(full_name: str = Query(..., min_length=1)):
    """Temporary operator endpoint. Reject exactly one approved outreach row by full name."""
    rows = await asyncio.to_thread(db.get_outreach_by_full_name, full_name, "approved", 10)
    if not rows:
        return {"status": "error", "error": "No approved outreach found", "full_name": full_name}
    if len(rows) > 1:
        return {"status": "error", "error": f"Multiple approved outreach rows found ({len(rows)})", "full_name": full_name}

    supabase = db.get_db()
    row = rows[0]
    await asyncio.to_thread(handle_outreach_reject, supabase, row["id"])
    return {"status": "ok", "outreach_id": row["id"], "full_name": full_name}


@app.post("/jobs/clear-awaiting-review-slack")
async def clear_awaiting_review_slack(limit: int = Query(500, ge=1, le=1000)):
    """
    Temporary operator endpoint.
    Delete Slack approval cards for awaiting_review rows without changing Supabase status.
    """
    rows = await asyncio.to_thread(db.get_outreach_by_status, "awaiting_review", limit)
    cleared = 0
    skipped = 0
    for row in rows:
        deleted = await asyncio.to_thread(delete_outreach_slack_message, row)
        if deleted:
            cleared += 1
        else:
            skipped += 1
    return {"status": "ok", "cleared": cleared, "skipped": skipped, "limit": limit}


@app.post("/jobs/clear-slack-cards")
async def clear_slack_cards(
    status: list[str] = Query(...),
    limit: int = Query(500, ge=1, le=1000),
):
    """
    Temporary operator endpoint.
    Delete Slack outreach cards for the supplied workflow statuses without changing them.
    """
    cleared = 0
    skipped = 0
    status_counts: dict[str, int] = {}

    for current_status in status:
        rows = await asyncio.to_thread(db.get_outreach_by_status, current_status, limit)
        status_counts[current_status] = len(rows)
        for row in rows:
            deleted = await asyncio.to_thread(delete_outreach_slack_message, row)
            if deleted:
                cleared += 1
                await asyncio.to_thread(
                    db.update_outreach,
                    row["id"],
                    {"slack_message_ts": None, "slack_channel": None},
                )
            else:
                skipped += 1

    return {
        "status": "ok",
        "cleared": cleared,
        "skipped": skipped,
        "statuses": status,
        "status_counts": status_counts,
        "limit": limit,
    }


@app.post("/jobs/purge-outreach-slack-cards")
async def purge_outreach_slack_cards(limit: int = Query(500, ge=1, le=1000)):
    """
    Temporary operator endpoint.
    Delete recent outreach approval cards directly from Slack channel history, even if DB links are gone.
    """
    if not SLACK_BOT_TOKEN or not OUTREACH_SLACK_CHANNEL:
        return {"status": "error", "error": "Slack outreach channel not configured"}

    slack = WebClient(token=SLACK_BOT_TOKEN)
    try:
        resp = await asyncio.to_thread(
            slack.conversations_history,
            channel=OUTREACH_SLACK_CHANNEL,
            limit=limit,
        )
    except SlackApiError as exc:
        error = exc.response.get("error", "slack_api_error")
        logger.exception("Slack outreach history fetch failed")
        return {"status": "error", "error": error}
    except Exception:
        logger.exception("Slack outreach history fetch crashed")
        return {"status": "error", "error": "history_fetch_failed"}

    deleted = 0
    skipped = 0
    scanned = 0
    action_ids = {"outreach_approve", "outreach_edit", "outreach_reject"}

    for message in resp.get("messages", []):
        scanned += 1
        blocks = message.get("blocks") or []
        has_outreach_actions = any(
            block.get("type") == "actions"
            and any(element.get("action_id") in action_ids for element in block.get("elements", []))
            for block in blocks
        )
        if not has_outreach_actions:
            continue
        try:
            await asyncio.to_thread(
                slack.chat_delete,
                channel=OUTREACH_SLACK_CHANNEL,
                ts=message["ts"],
            )
            deleted += 1
        except SlackApiError as exc:
            logger.exception("Slack outreach message purge failed for ts=%s", message.get("ts"))
            skipped += 1
        except Exception:
            logger.exception("Slack outreach message purge failed for ts=%s", message.get("ts"))
            skipped += 1

    return {"status": "ok", "deleted": deleted, "skipped": skipped, "scanned": scanned, "limit": limit}


@app.post("/jobs/requeue-awaiting-review")
async def requeue_awaiting_review(limit: int = Query(500, ge=1, le=1000)):
    """
    Temporary operator endpoint.
    Move untouched awaiting_review rows back to detected so they can be redrafted.
    """
    rows = await asyncio.to_thread(db.get_outreach_by_status, "awaiting_review", limit)
    reset = 0
    for row in rows:
        await asyncio.to_thread(
            db.update_outreach,
            row["id"],
            {
                "status": "detected",
                "slack_message_ts": None,
                "slack_channel": None,
            },
        )
        reset += 1
    return {"status": "ok", "requeued": reset, "limit": limit}


@app.post("/jobs/delete-awaiting-review")
async def delete_awaiting_review(limit: int = Query(500, ge=1, le=1000)):
    """
    Temporary operator endpoint.
    Delete awaiting_review rows and remove their Slack approval cards.
    """
    rows = await asyncio.to_thread(db.get_outreach_by_status, "awaiting_review", limit)
    deleted = 0
    slack_deleted = 0
    slack_skipped = 0
    table = db.get_db().table("linkedin_outreach")
    for row in rows:
        removed = await asyncio.to_thread(delete_outreach_slack_message, row)
        if removed:
            slack_deleted += 1
        else:
            slack_skipped += 1
        await asyncio.to_thread(table.delete().eq("id", row["id"]).execute)
        deleted += 1
    return {
        "status": "ok",
        "deleted": deleted,
        "slack_deleted": slack_deleted,
        "slack_skipped": slack_skipped,
        "limit": limit,
    }


@app.post("/jobs/requeue-approved")
async def requeue_approved(limit: int = Query(500, ge=1, le=1000)):
    """
    Temporary operator endpoint.
    Move approved rows back to detected and clear approval-specific fields.
    """
    rows = await asyncio.to_thread(db.get_outreach_by_status, "approved", limit)
    reset = 0
    for row in rows:
        await asyncio.to_thread(
            db.update_outreach,
            row["id"],
            {
                "status": "detected",
                "approved_message": None,
                "approved_at": None,
                "slack_message_ts": None,
                "slack_channel": None,
            },
        )
        reset += 1
    return {"status": "ok", "requeued": reset, "limit": limit}


@app.post("/jobs/requeue-rejected-outreach")
async def requeue_rejected_outreach(full_name: str = Query(..., min_length=1)):
    """Temporary operator endpoint. Move exactly one rejected outreach row back to detected."""
    rows = await asyncio.to_thread(db.get_outreach_by_full_name, full_name, "rejected", 10)
    if not rows:
        return {"status": "error", "error": "No rejected outreach found", "full_name": full_name}
    if len(rows) > 1:
        return {"status": "error", "error": f"Multiple rejected outreach rows found ({len(rows)})", "full_name": full_name}

    row = rows[0]
    await asyncio.to_thread(
        db.update_outreach,
        row["id"],
        {
            "status": "detected",
            "slack_message_ts": None,
            "slack_channel": None,
            "approved_message": None,
            "approved_at": None,
            "last_error": None,
        },
    )
    return {"status": "ok", "outreach_id": row["id"], "full_name": full_name}


@app.post("/jobs/undo-sent-outreach")
async def undo_sent_outreach(full_name: str = Query(..., min_length=1)):
    """Temporary operator endpoint. Move exactly one sent outreach row back to detected."""
    rows = await asyncio.to_thread(db.get_outreach_by_full_name, full_name, "sent", 10)
    if not rows:
        return {"status": "error", "error": "No sent outreach found", "full_name": full_name}
    if len(rows) > 1:
        return {"status": "error", "error": f"Multiple sent outreach rows found ({len(rows)})", "full_name": full_name}

    row = rows[0]
    await asyncio.to_thread(
        db.update_outreach,
        row["id"],
        {
            "status": "detected",
            "sent_at": None,
            "pb_send_container_id": None,
            "approved_message": None,
            "approved_at": None,
            "slack_message_ts": None,
            "slack_channel": None,
            "last_error": None,
        },
    )
    return {"status": "ok", "outreach_id": row["id"], "full_name": full_name}


@app.post("/jobs/undo-sent-outreach-by-profile")
async def undo_sent_outreach_by_profile(profile_url: str = Query(..., min_length=1)):
    """Temporary operator endpoint. Move a sent outreach row back to detected by LinkedIn profile URL."""
    row = await asyncio.to_thread(db.get_outreach_by_profile_url, profile_url)
    if not row:
        return {"status": "error", "error": "No outreach found", "profile_url": profile_url}
    if row.get("status") != "sent":
        return {
            "status": "error",
            "error": f"Outreach status is {row.get('status')}, not sent",
            "profile_url": profile_url,
            "full_name": row.get("full_name"),
        }

    await asyncio.to_thread(
        db.update_outreach,
        row["id"],
        {
            "status": "detected",
            "sent_at": None,
            "pb_send_container_id": None,
            "approved_message": None,
            "approved_at": None,
            "slack_message_ts": None,
            "slack_channel": None,
            "last_error": None,
        },
    )
    return {"status": "ok", "outreach_id": row["id"], "full_name": row.get("full_name"), "profile_url": profile_url}


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

                elif action_id == "outreach_context":
                    logger.info("[outreach:slack] Context action for %s", outreach_id)
                    trigger_id = payload["trigger_id"]
                    supabase_client = db.get_db()
                    asyncio.create_task(
                        asyncio.to_thread(handle_outreach_context, supabase_client, outreach_id, trigger_id)
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
            elif view.get("callback_id") == "outreach_context_modal":
                outreach_id = view["private_metadata"]
                context_text = view["state"]["values"]["outreach_context_block"]["outreach_context_input"]["value"]
                supabase_client = db.get_db()
                await asyncio.to_thread(handle_outreach_context_submit, supabase_client, outreach_id, context_text)

        return Response(status_code=200)
    except Exception:
        logger.exception("Slack events handler crashed")
        return Response(status_code=500, content="Slack events handler crashed")
