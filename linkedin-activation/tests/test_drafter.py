from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest

from app.drafter import (
    generate_outreach_draft,
    draft_and_update_outreach,
    draft_all_detected,
    OUTREACH_SYSTEM,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SAMPLE_ROW = {
    "id": "outreach-1",
    "full_name": "Jane Smith",
    "first_name": "Jane",
    "last_name": "Smith",
    "headline": "VP Engineering @ Acme Corp",
    "linkedin_profile_url": "https://www.linkedin.com/in/janesmith",
    "status": "detected",
    "draft_message": None,
    "slack_message_ts": None,
    "slack_channel": None,
}

SAMPLE_ROW_NO_HEADLINE = {
    **SAMPLE_ROW,
    "id": "outreach-2",
    "headline": None,
}


def _build_supabase_mock(select_results: list[dict]) -> MagicMock:
    """Build a mock supabase client where .table().select().eq().single().execute().data
    returns successive dicts from select_results."""
    mock_supabase = MagicMock()
    responses = []
    for data in select_results:
        resp = MagicMock()
        resp.data = data
        responses.append(resp)

    def table_side_effect(name):
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.single.return_value = chain
        chain.execute.side_effect = responses
        return chain

    mock_supabase.table.side_effect = table_side_effect
    return mock_supabase


def _mock_openai_response(text: str) -> MagicMock:
    message = MagicMock()
    message.content = text
    choice = MagicMock()
    choice.message = message
    resp = MagicMock()
    resp.choices = [choice]
    return resp


# ---------------------------------------------------------------------------
# generate_outreach_draft
# ---------------------------------------------------------------------------

class TestGenerateOutreachDraft:
    @patch("app.drafter.OPENAI_API_KEY", "test-key")
    @patch("app.drafter.OpenAI")
    def test_returns_draft_text(self, mock_cls):
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            "Great to connect, Jane! Your work at Acme sounds fascinating."
        )

        result = generate_outreach_draft(SAMPLE_ROW)

        assert result == "Great to connect, Jane! Your work at Acme sounds fascinating."

    @patch("app.drafter.OPENAI_API_KEY", "test-key")
    @patch("app.drafter.OpenAI")
    def test_prompt_includes_full_name_and_headline(self, mock_cls):
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response("Hi!")

        generate_outreach_draft(SAMPLE_ROW)

        create_call = mock_client.chat.completions.create.call_args
        user_message = create_call.kwargs["messages"][1]["content"]
        assert "Jane Smith" in user_message
        assert "VP Engineering @ Acme Corp" in user_message

    @patch("app.drafter.OPENAI_API_KEY", "test-key")
    @patch("app.drafter.OpenAI")
    def test_uses_openai_model(self, mock_cls):
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response("Hi!")

        generate_outreach_draft(SAMPLE_ROW)

        create_call = mock_client.chat.completions.create.call_args
        assert create_call.kwargs["model"] == "gpt-4.1"
        assert create_call.kwargs["max_tokens"] == 600

    @patch("app.drafter.OPENAI_API_KEY", "test-key")
    @patch("app.drafter.OpenAI")
    def test_null_headline_shows_na(self, mock_cls):
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response("Hi!")

        generate_outreach_draft(SAMPLE_ROW_NO_HEADLINE)

        create_call = mock_client.chat.completions.create.call_args
        user_message = create_call.kwargs["messages"][1]["content"]
        assert "Headline: N/A" in user_message

    @patch("app.drafter.OPENAI_API_KEY", "test-key")
    @patch("app.drafter.OpenAI")
    def test_does_not_truncate_output(self, mock_cls):
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response("x" * 500)

        result = generate_outreach_draft(SAMPLE_ROW)

        assert len(result) == 500

    def test_outreach_system_contains_new_prompt_markers(self):
        assert "LinkedIn First Message Generation Prompt" in OUTREACH_SYSTEM
        assert "Do not ask permission for a conversation." in OUTREACH_SYSTEM
        assert "The message must be:" in OUTREACH_SYSTEM
        assert "two or three paragraphs" in OUTREACH_SYSTEM
        assert "Never explain a market trend or industry problem in more than one short clause." in OUTREACH_SYSTEM
        assert "Messages should reference the person's vantage point" in OUTREACH_SYSTEM
        assert "Never use the words:" in OUTREACH_SYSTEM
        assert "enterprise-scale adoption" in OUTREACH_SYSTEM


# ---------------------------------------------------------------------------
# draft_and_update_outreach
# ---------------------------------------------------------------------------

class TestDraftAndUpdateOutreach:
    @patch("app.slack_bot.post_outreach_approval")
    @patch("app.drafter.db")
    @patch("app.drafter.transition_status")
    @patch("app.drafter.generate_outreach_draft", return_value="Welcome, Jane!")
    def test_transitions_detected_to_awaiting_review(
        self, _mock_gen, mock_transition, mock_db, _mock_slack
    ):
        mock_supabase = _build_supabase_mock([
            {**SAMPLE_ROW},
            {**SAMPLE_ROW, "status": "awaiting_review", "draft_message": "Welcome, Jane!"},
        ])

        draft_and_update_outreach(mock_supabase, "outreach-1")

        # Verify two transitions: detected->drafted, drafted->awaiting_review
        assert mock_transition.call_count == 2
        mock_transition.assert_any_call(mock_supabase, "outreach-1", "drafted")
        mock_transition.assert_any_call(mock_supabase, "outreach-1", "awaiting_review")

    @patch("app.slack_bot.post_outreach_approval")
    @patch("app.drafter.db")
    @patch("app.drafter.transition_status")
    @patch("app.drafter.generate_outreach_draft", return_value="Welcome!")
    def test_updates_draft_message(self, _mock_gen, _mock_transition, mock_db, _mock_slack):
        mock_supabase = _build_supabase_mock([
            {**SAMPLE_ROW},
            {**SAMPLE_ROW, "status": "awaiting_review", "draft_message": "Welcome!"},
        ])

        draft_and_update_outreach(mock_supabase, "outreach-1")

        mock_db.update_outreach.assert_any_call("outreach-1", {"draft_message": "Welcome!"})

    @patch("app.slack_bot.post_outreach_approval")
    @patch("app.drafter.db")
    @patch("app.drafter.transition_status")
    @patch("app.drafter.generate_outreach_draft")
    def test_skips_non_detected_status(self, mock_gen, _mock_transition, _mock_db, _mock_slack):
        mock_supabase = _build_supabase_mock([
            {**SAMPLE_ROW, "status": "drafted"},
        ])

        draft_and_update_outreach(mock_supabase, "outreach-1")

        mock_gen.assert_not_called()


# ---------------------------------------------------------------------------
# draft_all_detected
# ---------------------------------------------------------------------------

class TestDraftAllDetected:
    @patch("app.drafter.draft_and_update_outreach")
    @patch("app.drafter.db")
    def test_processes_all_detected_rows(self, mock_db, mock_draft):
        mock_db.get_outreach_by_status.return_value = [
            {**SAMPLE_ROW, "id": "id-1"},
            {**SAMPLE_ROW, "id": "id-2"},
        ]
        mock_supabase = MagicMock()

        count = draft_all_detected(mock_supabase)

        assert count == 2
        assert mock_draft.call_count == 2
        mock_db.get_outreach_by_status.assert_called_once_with("detected", limit=100)
        mock_draft.assert_any_call(mock_supabase, "id-1")
        mock_draft.assert_any_call(mock_supabase, "id-2")

    @patch("app.drafter.draft_and_update_outreach")
    @patch("app.drafter.db")
    def test_respects_limit(self, mock_db, mock_draft):
        mock_db.get_outreach_by_status.return_value = [
            {**SAMPLE_ROW, "id": "id-1"},
        ]
        mock_supabase = MagicMock()

        count = draft_all_detected(mock_supabase, limit=25)

        assert count == 1
        mock_db.get_outreach_by_status.assert_called_once_with("detected", limit=25)

    @patch("app.drafter.draft_and_update_outreach")
    @patch("app.drafter.db")
    def test_continues_on_error(self, mock_db, mock_draft):
        mock_db.get_outreach_by_status.return_value = [
            {**SAMPLE_ROW, "id": "id-1"},
            {**SAMPLE_ROW, "id": "id-2"},
        ]
        mock_draft.side_effect = [Exception("API error"), None]
        mock_supabase = MagicMock()

        count = draft_all_detected(mock_supabase)

        # First fails, second succeeds
        assert count == 1

    @patch("app.drafter.draft_and_update_outreach")
    @patch("app.drafter.db")
    def test_returns_zero_when_no_rows(self, mock_db, mock_draft):
        mock_db.get_outreach_by_status.return_value = []
        mock_supabase = MagicMock()

        count = draft_all_detected(mock_supabase)

        assert count == 0
        mock_draft.assert_not_called()
