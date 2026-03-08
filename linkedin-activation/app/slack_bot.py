from __future__ import annotations

import logging
from datetime import datetime, timezone

from slack_sdk import WebClient
from supabase import Client

from app import db
from app.config import OUTREACH_SLACK_CHANNEL, SLACK_BOT_TOKEN
from app.state_machine import transition_status

logger = logging.getLogger(__name__)


# DEPRECATED — old linkedin_connections table functions. Remove in future cleanup.
def build_approval_block(conn: dict) -> list:
    """Build Slack Block Kit message for connection approval."""
    attio_link = ""
    if conn.get("attio_record_id"):
        attio_link = f" - <https://app.attio.com/people/{conn['attio_record_id']}|Attio>"

    return [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f"New connection: {conn['first_name']} {conn['last_name']}"},
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"*{conn.get('headline', '')}*\n"
                    f"<https://linkedin.com/in/{conn['public_identifier']}|LinkedIn>{attio_link}"
                ),
            },
        },
        {"type": "divider"},
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*Draft:*\n> {conn.get('draft_message', '')}"},
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Send"},
                    "style": "primary",
                    "action_id": "approve_message",
                    "value": conn["id"],
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Edit"},
                    "action_id": "edit_message",
                    "value": conn["id"],
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Skip"},
                    "style": "danger",
                    "action_id": "skip_message",
                    "value": conn["id"],
                },
            ],
        },
    ]


def build_edit_modal(connection_id: str, current_draft: str) -> dict:
    """Build a Slack modal for editing a draft message."""
    return {
        "type": "modal",
        "callback_id": "edit_draft_modal",
        "private_metadata": connection_id,
        "title": {"type": "plain_text", "text": "Edit Draft"},
        "submit": {"type": "plain_text", "text": "Save"},
        "close": {"type": "plain_text", "text": "Cancel"},
        "blocks": [
            {
                "type": "input",
                "block_id": "draft_block",
                "label": {"type": "plain_text", "text": "Message (max 200 chars)"},
                "element": {
                    "type": "plain_text_input",
                    "action_id": "draft_input",
                    "initial_value": current_draft,
                    "max_length": 200,
                    "multiline": True,
                },
            }
        ],
    }


def post_approval(conn: dict, slack: WebClient, channel: str) -> str:
    """Post approval card to Slack. Returns message timestamp."""
    resp = slack.chat_postMessage(
        channel=channel,
        blocks=build_approval_block(conn),
        text=f"New connection: {conn['first_name']} {conn['last_name']}",
    )
    return resp["ts"]


def post_run_summary(new_count: int, errors: list[str], dry_run: bool, slack: WebClient, channel: str):
    """Post a summary after each run."""
    if errors:
        text = "Pipeline run finished with issues\n" + "\n".join(f"- {e}" for e in errors)
    elif new_count == 0:
        text = "Pipeline ran: no new connections"
    else:
        mode = " (dry run)" if dry_run else ""
        text = f"Pipeline ran{mode}: {new_count} new connection(s) processed"

    slack.chat_postMessage(channel=channel, text=text)


def handle_approve(connection_id: str, slack: WebClient, channel: str):
    """Mark connection as pending_send so the Chrome extension can send it."""
    conn = db.get_connection(connection_id)
    if not conn:
        raise RuntimeError(f"Connection {connection_id} not found")
    db.set_error(connection_id, "pending_send", "")

    try:
        if conn.get("slack_message_ts"):
            slack.chat_update(
                channel=channel,
                ts=conn["slack_message_ts"],
                text=f"Queued for send: {conn['first_name']} {conn['last_name']} - waiting for Chrome extension",
                blocks=[],
            )
    except Exception:
        slack.chat_postMessage(
            channel=channel,
            text=f"Queued for send: {conn['first_name']} {conn['last_name']} - waiting for Chrome extension",
        )


def handle_skip(connection_id: str, slack: WebClient, channel: str):
    """Mark connection as skipped and update Slack."""
    conn = db.get_connection(connection_id)
    if not conn:
        raise RuntimeError(f"Connection {connection_id} not found")
    db.set_error(connection_id, "skipped", "")

    if conn.get("slack_message_ts"):
        slack.chat_update(
            channel=channel,
            ts=conn["slack_message_ts"],
            text=f"Skipped {conn['first_name']} {conn['last_name']}",
            blocks=[],
        )


def handle_edit(connection_id: str, trigger_id: str, slack: WebClient):
    """Open the edit modal in Slack."""
    conn = db.get_connection(connection_id)
    if not conn:
        raise RuntimeError(f"Connection {connection_id} not found")
    modal = build_edit_modal(connection_id, conn.get("draft_message", ""))
    slack.views_open(trigger_id=trigger_id, view=modal)


def handle_edit_submit(connection_id: str, new_draft: str, slack: WebClient, channel: str):
    """Save edited draft and keep the item in review."""
    db.set_draft(connection_id, new_draft)
    conn = db.get_connection(connection_id)
    if not conn:
        raise RuntimeError(f"Connection {connection_id} not found")

    if conn.get("slack_message_ts"):
        slack.chat_update(
            channel=channel,
            ts=conn["slack_message_ts"],
            blocks=build_approval_block(conn),
            text=f"Updated draft for {conn['first_name']} {conn['last_name']}",
        )
        db.set_error(connection_id, "awaiting_review", "")
# END DEPRECATED


# ---------------------------------------------------------------------------
# Outreach approval flow (linkedin_outreach table)
# ---------------------------------------------------------------------------

def build_outreach_approval_blocks(row: dict) -> list:
    """Build Block Kit message for outreach approval."""
    name = row.get("full_name") or f"{row.get('first_name', '')} {row.get('last_name', '')}".strip()
    headline = row.get("headline") or ""
    draft = row.get("draft_message") or ""
    profile_url = row.get("linkedin_profile_url") or ""

    return [
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*{name}*\n{headline}"},
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"<{profile_url}|View Profile>"},
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"> {draft}"},
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Approve"},
                    "style": "primary",
                    "action_id": "outreach_approve",
                    "value": row["id"],
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Edit"},
                    "action_id": "outreach_edit",
                    "value": row["id"],
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Reject"},
                    "style": "danger",
                    "action_id": "outreach_reject",
                    "value": row["id"],
                },
            ],
        },
    ]


def build_outreach_edit_modal(outreach_id: str, current_draft: str) -> dict:
    """Build a Slack modal for editing an outreach draft."""
    return {
        "type": "modal",
        "callback_id": "outreach_edit_modal",
        "private_metadata": outreach_id,
        "title": {"type": "plain_text", "text": "Edit Message"},
        "submit": {"type": "plain_text", "text": "Approve"},
        "close": {"type": "plain_text", "text": "Cancel"},
        "blocks": [
            {
                "type": "input",
                "block_id": "outreach_draft_block",
                "label": {"type": "plain_text", "text": "Message"},
                "element": {
                    "type": "plain_text_input",
                    "action_id": "outreach_draft_input",
                    "initial_value": current_draft,
                    "multiline": True,
                },
            }
        ],
    }


def post_outreach_approval(supabase_client: Client, outreach_row: dict) -> None:
    """Post outreach approval card to Slack and save the message timestamp."""
    if not SLACK_BOT_TOKEN or not OUTREACH_SLACK_CHANNEL:
        return

    name = outreach_row.get("full_name") or ""
    slack = WebClient(token=SLACK_BOT_TOKEN)
    resp = slack.chat_postMessage(
        channel=OUTREACH_SLACK_CHANNEL,
        blocks=build_outreach_approval_blocks(outreach_row),
        text=f"New outreach: {name}",
    )
    db.update_outreach(outreach_row["id"], {
        "slack_message_ts": resp["ts"],
        "slack_channel": OUTREACH_SLACK_CHANNEL,
    })
    logger.info("[outreach:slack] Approval card posted for %s", name)


def update_outreach_slack_message(supabase_client: Client, outreach_row: dict, status_text: str) -> None:
    """Replace buttons with a status line."""
    if not SLACK_BOT_TOKEN or not outreach_row.get("slack_message_ts"):
        return

    channel = outreach_row.get("slack_channel") or OUTREACH_SLACK_CHANNEL
    if not channel:
        return

    name = outreach_row.get("full_name") or ""
    try:
        slack = WebClient(token=SLACK_BOT_TOKEN)
        slack.chat_update(
            channel=channel,
            ts=outreach_row["slack_message_ts"],
            text=f"{status_text}: {name}",
            blocks=[],
        )
    except Exception:
        logger.exception("Slack outreach message update failed for %s", outreach_row.get("id"))


def handle_outreach_approve(supabase_client: Client, outreach_id: str) -> None:
    """Approve outreach: set approved_message, approved_at, transition to approved."""
    row = db.get_outreach(outreach_id)
    if not row:
        raise RuntimeError(f"Outreach {outreach_id} not found")

    db.update_outreach(outreach_id, {
        "approved_message": row.get("draft_message"),
        "approved_at": datetime.now(timezone.utc).isoformat(),
    })
    transition_status(supabase_client, outreach_id, "approved")

    updated = db.get_outreach(outreach_id)
    update_outreach_slack_message(supabase_client, updated, "Approved by Matt")


def handle_outreach_edit(supabase_client: Client, outreach_id: str, trigger_id: str) -> None:
    """Open the outreach edit modal."""
    row = db.get_outreach(outreach_id)
    if not row:
        raise RuntimeError(f"Outreach {outreach_id} not found")

    modal = build_outreach_edit_modal(outreach_id, row.get("draft_message") or "")
    slack = WebClient(token=SLACK_BOT_TOKEN)
    slack.views_open(trigger_id=trigger_id, view=modal)


def handle_outreach_edit_submit(supabase_client: Client, outreach_id: str, edited_text: str) -> None:
    """Save edited text as approved_message, transition to approved."""
    db.update_outreach(outreach_id, {
        "approved_message": edited_text,
        "approved_at": datetime.now(timezone.utc).isoformat(),
    })
    transition_status(supabase_client, outreach_id, "approved")

    updated = db.get_outreach(outreach_id)
    update_outreach_slack_message(supabase_client, updated, "Approved (edited)")


def handle_outreach_reject(supabase_client: Client, outreach_id: str) -> None:
    """Reject outreach: transition to rejected, update Slack."""
    transition_status(supabase_client, outreach_id, "rejected")

    row = db.get_outreach(outreach_id)
    update_outreach_slack_message(supabase_client, row, "Rejected")
