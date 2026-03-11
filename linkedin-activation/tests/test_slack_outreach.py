from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest

from app.slack_bot import (
    build_outreach_approval_blocks,
    build_outreach_context_modal,
    build_outreach_edit_modal,
    handle_outreach_approve,
    handle_outreach_context,
    handle_outreach_context_submit,
    handle_outreach_edit,
    handle_outreach_edit_submit,
    handle_outreach_reject,
    post_outreach_approval,
    refresh_outreach_slack_message,
    update_outreach_slack_message,
)


SAMPLE_ROW = {
    "id": "outreach-1",
    "full_name": "Jane Smith",
    "first_name": "Jane",
    "last_name": "Smith",
    "headline": "VP Engineering @ Acme Corp",
    "linkedin_profile_url": "https://www.linkedin.com/in/janesmith",
    "status": "awaiting_review",
    "draft_message": "Hey Jane, love the work at Acme!",
    "slack_message_ts": "1234.5678",
    "slack_channel": "C-outreach",
}


# ---------------------------------------------------------------------------
# Block builders
# ---------------------------------------------------------------------------

class TestBuildOutreachApprovalBlocks:
    def test_contains_approve_edit_context_reject_buttons(self):
        blocks = build_outreach_approval_blocks(SAMPLE_ROW)
        actions = [b for b in blocks if b["type"] == "actions"]
        assert len(actions) == 1

        button_ids = [e["action_id"] for e in actions[0]["elements"]]
        assert button_ids == ["outreach_approve", "outreach_edit", "outreach_redraft", "outreach_context", "outreach_reject"]

    def test_buttons_carry_outreach_id(self):
        blocks = build_outreach_approval_blocks(SAMPLE_ROW)
        actions = [b for b in blocks if b["type"] == "actions"][0]
        for btn in actions["elements"]:
            assert btn["value"] == "outreach-1"

    def test_includes_name_and_headline(self):
        blocks = build_outreach_approval_blocks(SAMPLE_ROW)
        text_blocks = [b for b in blocks if b["type"] == "section"]
        all_text = " ".join(b["text"]["text"] for b in text_blocks)
        assert "Jane Smith" in all_text
        assert "VP Engineering @ Acme Corp" in all_text

    def test_includes_draft_message(self):
        blocks = build_outreach_approval_blocks(SAMPLE_ROW)
        text_blocks = [b for b in blocks if b["type"] == "section"]
        all_text = " ".join(b["text"]["text"] for b in text_blocks)
        assert "Hey Jane, love the work at Acme!" in all_text


class TestBuildOutreachEditModal:
    def test_modal_structure(self):
        modal = build_outreach_edit_modal("outreach-1", "Draft text here")
        assert modal["callback_id"] == "outreach_edit_modal"
        assert modal["private_metadata"] == "outreach-1"
        assert modal["blocks"][0]["element"]["initial_value"] == "Draft text here"
        assert "max_length" not in modal["blocks"][0]["element"]


class TestBuildOutreachContextModal:
    def test_modal_structure(self):
        modal = build_outreach_context_modal("outreach-1", "Attending RSAC")
        assert modal["callback_id"] == "outreach_context_modal"
        assert modal["private_metadata"] == "outreach-1"
        assert modal["blocks"][0]["element"]["initial_value"] == "Attending RSAC"


# ---------------------------------------------------------------------------
# handle_outreach_approve
# ---------------------------------------------------------------------------

class TestHandleOutreachApprove:
    @patch("app.slack_bot.update_outreach_slack_message")
    @patch("app.slack_bot.transition_status")
    @patch("app.slack_bot.db")
    def test_sets_approved_fields(self, mock_db, mock_transition, _mock_slack_update):
        mock_db.get_outreach.side_effect = [
            {**SAMPLE_ROW},
            {**SAMPLE_ROW, "status": "approved"},
        ]
        mock_db.update_outreach.return_value = {**SAMPLE_ROW}
        mock_supabase = MagicMock()

        handle_outreach_approve(mock_supabase, "outreach-1")

        # Verify update_outreach was called with approved_message and approved_at
        update_call = mock_db.update_outreach.call_args
        updates = update_call.args[1]
        assert updates["approved_message"] == "Hey Jane, love the work at Acme!"
        assert "approved_at" in updates

    @patch("app.slack_bot.update_outreach_slack_message")
    @patch("app.slack_bot.transition_status")
    @patch("app.slack_bot.db")
    def test_transitions_to_approved(self, mock_db, mock_transition, _mock_slack_update):
        mock_db.get_outreach.side_effect = [
            {**SAMPLE_ROW},
            {**SAMPLE_ROW, "status": "approved"},
        ]
        mock_db.update_outreach.return_value = {**SAMPLE_ROW}
        mock_supabase = MagicMock()

        handle_outreach_approve(mock_supabase, "outreach-1")

        mock_transition.assert_called_once_with(mock_supabase, "outreach-1", "approved")

    @patch("app.slack_bot.update_outreach_slack_message")
    @patch("app.slack_bot.transition_status")
    @patch("app.slack_bot.db")
    def test_updates_slack(self, mock_db, _mock_transition, mock_slack_update):
        approved_row = {**SAMPLE_ROW, "status": "approved"}
        mock_db.get_outreach.side_effect = [{**SAMPLE_ROW}, approved_row]
        mock_db.update_outreach.return_value = {**SAMPLE_ROW}
        mock_supabase = MagicMock()

        handle_outreach_approve(mock_supabase, "outreach-1")

        mock_slack_update.assert_called_once_with(mock_supabase, approved_row, "Approved by Matt")


# ---------------------------------------------------------------------------
# handle_outreach_edit
# ---------------------------------------------------------------------------

class TestHandleOutreachEdit:
    @patch("app.slack_bot.SLACK_BOT_TOKEN", "xoxb-test")
    @patch("app.slack_bot.WebClient")
    @patch("app.slack_bot.db")
    def test_opens_modal_with_draft(self, mock_db, mock_webclient_cls):
        mock_db.get_outreach.return_value = {**SAMPLE_ROW}
        mock_slack = MagicMock()
        mock_webclient_cls.return_value = mock_slack
        mock_supabase = MagicMock()

        handle_outreach_edit(mock_supabase, "outreach-1", "trigger-abc")

        mock_slack.views_open.assert_called_once()
        view = mock_slack.views_open.call_args.kwargs["view"]
        assert view["callback_id"] == "outreach_edit_modal"
        assert view["private_metadata"] == "outreach-1"
        assert view["blocks"][0]["element"]["initial_value"] == "Hey Jane, love the work at Acme!"


class TestHandleOutreachContext:
    @patch("app.slack_bot.SLACK_BOT_TOKEN", "xoxb-test")
    @patch("app.slack_bot.WebClient")
    @patch("app.slack_bot.db")
    def test_opens_modal_with_existing_context(self, mock_db, mock_webclient_cls):
        mock_db.get_outreach.return_value = {
            **SAMPLE_ROW,
            "research": {"operator_context": "Attending RSAC"},
        }
        mock_slack = MagicMock()
        mock_webclient_cls.return_value = mock_slack
        mock_supabase = MagicMock()

        handle_outreach_context(mock_supabase, "outreach-1", "trigger-abc")

        view = mock_slack.views_open.call_args.kwargs["view"]
        assert view["callback_id"] == "outreach_context_modal"
        assert view["blocks"][0]["element"]["initial_value"] == "Attending RSAC"


# ---------------------------------------------------------------------------
# handle_outreach_edit_submit
# ---------------------------------------------------------------------------

class TestHandleOutreachEditSubmit:
    @patch("app.slack_bot.update_outreach_slack_message")
    @patch("app.slack_bot.transition_status")
    @patch("app.slack_bot.db")
    def test_saves_edited_text_and_approves(self, mock_db, mock_transition, _mock_slack_update):
        mock_db.get_outreach.return_value = {**SAMPLE_ROW, "status": "approved"}
        mock_db.update_outreach.return_value = {**SAMPLE_ROW}
        mock_supabase = MagicMock()

        handle_outreach_edit_submit(mock_supabase, "outreach-1", "Edited message here")

        update_call = mock_db.update_outreach.call_args
        updates = update_call.args[1]
        assert updates["approved_message"] == "Edited message here"
        assert "approved_at" in updates
        mock_transition.assert_called_once_with(mock_supabase, "outreach-1", "approved")

    @patch("app.slack_bot.update_outreach_slack_message")
    @patch("app.slack_bot.transition_status")
    @patch("app.slack_bot.db")
    def test_updates_slack_with_edited_label(self, mock_db, _mock_transition, mock_slack_update):
        approved_row = {**SAMPLE_ROW, "status": "approved"}
        mock_db.get_outreach.return_value = approved_row
        mock_db.update_outreach.return_value = {**SAMPLE_ROW}
        mock_supabase = MagicMock()

        handle_outreach_edit_submit(mock_supabase, "outreach-1", "Edited text")

        mock_slack_update.assert_called_once_with(mock_supabase, approved_row, "Approved (edited)")


class TestHandleOutreachContextSubmit:
    @patch("app.slack_bot.refresh_outreach_slack_message")
    @patch("app.drafter.generate_outreach_draft")
    @patch("app.slack_bot.db")
    def test_saves_context_and_redrafts(self, mock_db, mock_generate, mock_refresh):
        row = {**SAMPLE_ROW, "research": {"profile": {"headline": "VP Engineering"}}}
        updated = {
            **SAMPLE_ROW,
            "research": {"profile": {"headline": "VP Engineering"}, "operator_context": "Attending RSAC"},
            "draft_message": "New draft",
        }
        mock_db.get_outreach.side_effect = [row, updated]
        mock_generate.return_value = "New draft"
        mock_supabase = MagicMock()

        handle_outreach_context_submit(mock_supabase, "outreach-1", "Attending RSAC")

        mock_db.update_outreach.assert_called_once_with(
            "outreach-1",
            {
                "research": {"profile": {"headline": "VP Engineering"}, "operator_context": "Attending RSAC"},
                "draft_message": "New draft",
            },
        )
        mock_refresh.assert_called_once_with(updated)


# ---------------------------------------------------------------------------
# handle_outreach_reject
# ---------------------------------------------------------------------------

class TestHandleOutreachReject:
    @patch("app.slack_bot.update_outreach_slack_message")
    @patch("app.slack_bot.transition_status")
    @patch("app.slack_bot.db")
    def test_transitions_to_rejected(self, mock_db, mock_transition, _mock_slack_update):
        mock_db.get_outreach.return_value = {**SAMPLE_ROW, "status": "rejected"}
        mock_supabase = MagicMock()

        handle_outreach_reject(mock_supabase, "outreach-1")

        mock_transition.assert_called_once_with(mock_supabase, "outreach-1", "rejected")

    @patch("app.slack_bot.update_outreach_slack_message")
    @patch("app.slack_bot.transition_status")
    @patch("app.slack_bot.db")
    def test_updates_slack_with_rejected(self, mock_db, mock_transition, mock_slack_update):
        rejected_row = {**SAMPLE_ROW, "status": "rejected"}
        mock_db.get_outreach.return_value = rejected_row
        mock_supabase = MagicMock()

        handle_outreach_reject(mock_supabase, "outreach-1")

        mock_slack_update.assert_called_once_with(mock_supabase, rejected_row, "Rejected")


class TestRefreshOutreachSlackMessage:
    @patch("app.slack_bot.OUTREACH_SLACK_CHANNEL", "C-outreach")
    @patch("app.slack_bot.SLACK_BOT_TOKEN", "xoxb-test")
    @patch("app.slack_bot.WebClient")
    def test_refreshes_blocks_in_place(self, mock_webclient_cls):
        mock_slack = MagicMock()
        mock_webclient_cls.return_value = mock_slack

        refresh_outreach_slack_message(SAMPLE_ROW)

        mock_slack.chat_update.assert_called_once()
        kwargs = mock_slack.chat_update.call_args.kwargs
        assert kwargs["channel"] == "C-outreach"
        assert kwargs["ts"] == "1234.5678"


# ---------------------------------------------------------------------------
# post_outreach_approval
# ---------------------------------------------------------------------------

class TestPostOutreachApproval:
    @patch("app.slack_bot.OUTREACH_SLACK_CHANNEL", "C-outreach")
    @patch("app.slack_bot.SLACK_BOT_TOKEN", "xoxb-test")
    @patch("app.slack_bot.db")
    @patch("app.slack_bot.WebClient")
    def test_posts_message_and_saves_ts(self, mock_webclient_cls, mock_db):
        mock_slack = MagicMock()
        mock_webclient_cls.return_value = mock_slack
        mock_slack.chat_postMessage.return_value = {"ts": "999.888"}
        mock_supabase = MagicMock()

        post_outreach_approval(mock_supabase, SAMPLE_ROW)

        mock_slack.chat_postMessage.assert_called_once()
        post_kwargs = mock_slack.chat_postMessage.call_args.kwargs
        assert post_kwargs["channel"] == "C-outreach"

        mock_db.update_outreach.assert_called_once_with("outreach-1", {
            "slack_message_ts": "999.888",
            "slack_channel": "C-outreach",
        })
