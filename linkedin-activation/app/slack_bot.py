from __future__ import annotations

import logging
from datetime import datetime, timezone

from slack_sdk import WebClient
from supabase import Client

from app import db
from app.config import OUTREACH_SLACK_CHANNEL, SLACK_BOT_TOKEN
from app.state_machine import transition_status

logger = logging.getLogger(__name__)


def _get_operator_context(row: dict) -> str:
    research = row.get("research") or {}
    return (research.get("operator_context") or "").strip()


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
                "label": {"type": "plain_text", "text": "Message"},
                "element": {
                    "type": "plain_text_input",
                    "action_id": "draft_input",
                    "initial_value": current_draft,
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
    """
    Build Block Kit message for outreach approval with enrichment summary.

    Layout (all sections conditional — only shown when data exists):
    1. Header: name + title + company
    2. Location line: location, followers, connections
    3. Profile link
    4. Background: experience + education (if profile enrichment exists)
    5. Recent Activity: top posts with engagement + themes (if activity exists)
    6. Operator context (if set via Context button)
    7. Draft message
    8. Action buttons: Approve, Edit, Redraft, Context, Reject
    """
    name = row.get("full_name") or f"{row.get('first_name', '')} {row.get('last_name', '')}".strip()
    headline = row.get("headline") or ""
    draft = row.get("draft_message") or ""
    profile_url = row.get("linkedin_profile_url") or ""
    operator_context = _get_operator_context(row)

    research = row.get("research") or {}
    profile = research.get("profile") or {}
    posts = research.get("recent_posts") or []
    enrichment_meta = research.get("enrichment_meta") or {}

    # --- Header: name + headline + profile link ---
    header_parts = [f"*{name}*"]
    if headline:
        header_parts[0] += f" — {headline}"

    # Location + influence signals on one line
    location_parts = []
    location = profile.get("locationName") or ""
    if location:
        location_parts.append(location)
    followers = profile.get("followerCount") or 0
    if followers:
        location_parts.append(f"{_format_count(followers)} followers")
    connections = profile.get("connectionCount") or 0
    if connections:
        location_parts.append(f"{_format_count(connections)} connections")
    if location_parts:
        header_parts.append(" · ".join(location_parts))

    if profile_url:
        header_parts.append(f"<{profile_url}|View Profile>")

    blocks: list[dict] = [
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": "\n".join(header_parts)},
        },
    ]

    # --- Background section (experience + education) ---
    background_lines = _build_background_lines(profile)
    if background_lines:
        blocks.append({"type": "divider"})
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "*Background:*\n" + "\n".join(background_lines),
            },
        })

    # --- Recent Activity section ---
    activity_text = _build_activity_text(posts, enrichment_meta)
    if activity_text:
        blocks.append({"type": "divider"})
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": activity_text},
        })

    # --- Operator context ---
    if operator_context:
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*Context:* {operator_context}"},
        })

    # --- Draft message ---
    blocks.append({"type": "divider"})
    blocks.append({
        "type": "section",
        "text": {"type": "mrkdwn", "text": f"*Draft:*\n> {draft}"},
    })

    # --- Action buttons ---
    blocks.append({
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
                "text": {"type": "plain_text", "text": "Redraft"},
                "action_id": "outreach_redraft",
                "value": row["id"],
            },
            {
                "type": "button",
                "text": {"type": "plain_text", "text": "Context"},
                "action_id": "outreach_context",
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
    })
    return blocks


def _build_background_lines(profile: dict) -> list[str]:
    """Build bullet points for experience and education. Returns empty list if no data."""
    lines = []

    for exp in (profile.get("experience") or [])[:3]:
        title = exp.get("title", "")
        company = exp.get("companyName", "")
        date_range = exp.get("dateRange", "")
        if title and company:
            line = f"• {title} at {company}"
            if date_range:
                line += f" ({date_range})"
            lines.append(line)

    for edu in (profile.get("education") or [])[:2]:
        school = edu.get("schoolName", "")
        degree = edu.get("degree", "")
        if school:
            line = f"• {school}"
            if degree:
                line += f" — {degree}"
            lines.append(line)

    return lines


def _build_activity_text(posts: list[dict], enrichment_meta: dict) -> str:
    """Build the Recent Activity section text. Returns empty string if no posts."""
    if not posts:
        return ""

    # Filter to original posts first, fall back to all if none
    original_posts = [p for p in posts if not p.get("isRepost")]
    display_posts = original_posts[:3] if original_posts else posts[:3]

    lines = [f"*Recent Activity ({len(posts)} posts):*"]
    for p in display_posts:
        text = (p.get("text") or p.get("commentary") or "")[:80]
        if not text:
            continue
        text = text.replace("\n", " ")
        likes = p.get("likeCount", 0)
        is_repost = p.get("isRepost", False)
        prefix = "Shared: " if is_repost else ""
        lines.append(f'• {prefix}"{text}..." ({likes} likes)')

    # Themes + engagement on one line
    themes = enrichment_meta.get("topThemes") or []
    engagement = enrichment_meta.get("engagementLevel") or ""
    meta_parts = []
    if themes:
        meta_parts.append("Themes: " + " · ".join(themes[:4]))
    if engagement:
        meta_parts.append(f"Engagement: {engagement}")
    if meta_parts:
        lines.append(" | ".join(meta_parts))

    return "\n".join(lines)


def _format_count(n: int) -> str:
    """Format large numbers: 10216 -> '10.2K', 446 -> '446'."""
    if n >= 1000:
        return f"{n / 1000:.1f}K"
    return str(n)


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


def build_outreach_context_modal(outreach_id: str, current_context: str) -> dict:
    """Build a Slack modal for adding trusted operator context and redrafting."""
    return {
        "type": "modal",
        "callback_id": "outreach_context_modal",
        "private_metadata": outreach_id,
        "title": {"type": "plain_text", "text": "Add Context"},
        "submit": {"type": "plain_text", "text": "Redraft"},
        "close": {"type": "plain_text", "text": "Cancel"},
        "blocks": [
            {
                "type": "input",
                "block_id": "outreach_context_block",
                "label": {"type": "plain_text", "text": "Context Variable"},
                "element": {
                    "type": "plain_text_input",
                    "action_id": "outreach_context_input",
                    "initial_value": current_context,
                    "multiline": True,
                    "placeholder": {
                        "type": "plain_text",
                        "text": "Example: They are attending RSAC / We will both be at CDAO Sydney",
                    },
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


def refresh_outreach_slack_message(outreach_row: dict) -> None:
    """Refresh an awaiting_review Slack card in place with the latest draft and context."""
    if not SLACK_BOT_TOKEN or not outreach_row.get("slack_message_ts"):
        return

    channel = outreach_row.get("slack_channel") or OUTREACH_SLACK_CHANNEL
    if not channel:
        return

    try:
        slack = WebClient(token=SLACK_BOT_TOKEN)
        slack.chat_update(
            channel=channel,
            ts=outreach_row["slack_message_ts"],
            text=f"Updated outreach: {outreach_row.get('full_name') or ''}",
            blocks=build_outreach_approval_blocks(outreach_row),
        )
    except Exception:
        logger.exception("Slack outreach message refresh failed for %s", outreach_row.get("id"))


def delete_outreach_slack_message(outreach_row: dict) -> bool:
    """Delete an outreach Slack card without changing DB workflow state."""
    if not SLACK_BOT_TOKEN or not outreach_row.get("slack_message_ts"):
        return False

    channel = outreach_row.get("slack_channel") or OUTREACH_SLACK_CHANNEL
    if not channel:
        return False

    try:
        slack = WebClient(token=SLACK_BOT_TOKEN)
        slack.chat_delete(channel=channel, ts=outreach_row["slack_message_ts"])
        logger.info("[outreach:slack] Deleted approval card for %s", outreach_row.get("id"))
        return True
    except Exception:
        logger.exception("Slack outreach message delete failed for %s", outreach_row.get("id"))
        return False

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


def handle_outreach_context(supabase_client: Client, outreach_id: str, trigger_id: str) -> None:
    """Open the context modal for an outreach draft."""
    row = db.get_outreach(outreach_id)
    if not row:
        raise RuntimeError(f"Outreach {outreach_id} not found")

    modal = build_outreach_context_modal(outreach_id, _get_operator_context(row))
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


def handle_outreach_context_submit(supabase_client: Client, outreach_id: str, operator_context: str) -> None:
    """Store operator context, regenerate the draft, and refresh the Slack card."""
    from app.drafter import generate_outreach_draft

    row = db.get_outreach(outreach_id)
    if not row:
        raise RuntimeError(f"Outreach {outreach_id} not found")

    research = dict(row.get("research") or {})
    if operator_context.strip():
        research["operator_context"] = operator_context.strip()
    else:
        research.pop("operator_context", None)

    row["research"] = research
    draft_text = generate_outreach_draft(row)
    db.update_outreach(outreach_id, {"research": research, "draft_message": draft_text})

    updated = db.get_outreach(outreach_id)
    refresh_outreach_slack_message(updated)


def handle_outreach_redraft(supabase_client: Client, outreach_id: str) -> None:
    """Redraft the outreach message with a different angle, refresh the Slack card."""
    from app.drafter import redraft_outreach

    redraft_outreach(supabase_client, outreach_id)

    # Refresh the Slack card in place — enrichment stays, only draft changes
    updated = db.get_outreach(outreach_id)
    refresh_outreach_slack_message(updated)


def handle_outreach_reject(supabase_client: Client, outreach_id: str) -> None:
    """Reject outreach: transition to rejected, update Slack."""
    transition_status(supabase_client, outreach_id, "rejected")

    row = db.get_outreach(outreach_id)
    update_outreach_slack_message(supabase_client, row, "Rejected")
