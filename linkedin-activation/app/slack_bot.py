from __future__ import annotations

from slack_sdk import WebClient

from app import db


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
