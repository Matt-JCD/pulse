from __future__ import annotations

import json
from unittest.mock import patch, MagicMock, call

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.phantombuster_webhook import (
    _extract_webhook_metadata,
    handle_connections_result,
    handle_send_success,
    handle_send_failure,
    _parse_company_from_headline,
    _public_identifier_from_url,
)


client = TestClient(app)

SAMPLE_CSV = (
    "profileUrl,firstName,lastName,fullName,title,connectionSince,profileImageUrl,timestamp\n"
    "https://www.linkedin.com/in/jdoe/,John,Doe,John Doe,CTO @ Acme Inc,2026-03-01T00:00:00.000Z,https://img.example.com/jdoe.jpg,1709251200\n"
    "https://www.linkedin.com/in/asmith/,Alice,Smith,Alice Smith,\"VP Engineering, Platform\",2026-03-02T00:00:00.000Z,,1709337600\n"
)

CONNECTIONS_PAYLOAD = {
    "agentId": "conn-agent-123",
    "agentName": "LinkedIn Connections Export",
    "containerId": "container-abc",
    "exitCode": 0,
    "exitMessage": "Agent finished successfully",
    "resultObject": None,
}

SEND_SUCCESS_PAYLOAD = {
    "agentId": "send-agent-456",
    "agentName": "LinkedIn Message Sender",
    "containerId": "container-send-1",
    "exitCode": 0,
    "exitMessage": "Agent finished successfully",
    "resultObject": None,
}

SEND_FAILURE_PAYLOAD = {
    "agentId": "send-agent-456",
    "agentName": "LinkedIn Message Sender",
    "containerId": "container-send-1",
    "exitCode": 1,
    "exitMessage": "Profile not found",
    "resultObject": None,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class TestHelpers:
    def test_parse_company_at_sign(self):
        assert _parse_company_from_headline("CTO @ Acme Inc") == "Acme Inc"

    def test_parse_company_at_word(self):
        assert _parse_company_from_headline("Engineer at Google") == "Google"

    def test_parse_company_none_when_no_separator(self):
        assert _parse_company_from_headline("Software Engineer") is None

    def test_parse_company_none_for_empty(self):
        assert _parse_company_from_headline(None) is None

    def test_public_identifier_from_url(self):
        assert _public_identifier_from_url("https://www.linkedin.com/in/jdoe/") == "jdoe"

    def test_public_identifier_no_trailing_slash(self):
        assert _public_identifier_from_url("https://www.linkedin.com/in/jdoe") == "jdoe"

    def test_extracts_nested_webhook_metadata(self):
        payload = {
            "event": "agent.finished",
            "data": {
                "agentId": "conn-agent-123",
                "agentName": "LinkedIn Connections Export",
                "containerId": "container-nested",
                "exitCode": "0",
                "exitMessage": "finished",
            },
        }

        meta = _extract_webhook_metadata(payload)

        assert meta["agent_id"] == "conn-agent-123"
        assert meta["agent_name"] == "LinkedIn Connections Export"
        assert meta["container_id"] == "container-nested"
        assert meta["exit_code"] == "0"


# ---------------------------------------------------------------------------
# Route: invalid secret returns 401
# ---------------------------------------------------------------------------

class TestWebhookAuth:
    @patch("app.main.validate_webhook_secret", return_value=False)
    def test_invalid_secret_returns_401(self, _mock_validate):
        resp = client.post(
            "/phantombuster/webhook?secret=wrong",
            json=CONNECTIONS_PAYLOAD,
        )
        assert resp.status_code == 401

    @patch("app.main.validate_webhook_secret", return_value=True)
    @patch("app.main.process_pb_webhook")
    def test_valid_secret_returns_200(self, _mock_process, _mock_validate):
        resp = client.post(
            "/phantombuster/webhook?secret=correct",
            json=CONNECTIONS_PAYLOAD,
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "accepted"


# ---------------------------------------------------------------------------
# Connections webhook: creates new rows with correct field mapping
# ---------------------------------------------------------------------------

class TestHandleConnectionsResult:
    @patch("app.phantombuster_webhook.db")
    @patch("app.phantombuster_webhook.download_result_csv", return_value=SAMPLE_CSV)
    @patch("app.phantombuster_webhook.fetch_agent_info", return_value={
        "s3Folder": "folder-1", "orgS3Folder": "org-1",
    })
    def test_creates_rows_with_correct_fields(self, _mock_info, _mock_csv, mock_db):
        # First call returns new row, second returns new row
        mock_db.upsert_outreach_connection.side_effect = [
            {
                "id": "id-1",
                "status": "detected",
                "pb_connections_container_id": "container-abc",
            },
            {
                "id": "id-2",
                "status": "detected",
                "pb_connections_container_id": "container-abc",
            },
        ]

        result = handle_connections_result(CONNECTIONS_PAYLOAD)

        assert result["new_ids"] == ["id-1", "id-2"]
        assert result["skipped"] == 0

        # Check first upsert call has correct field mapping
        first_call = mock_db.upsert_outreach_connection.call_args_list[0]
        data = first_call.args[0]
        assert data["linkedin_profile_url"] == "https://www.linkedin.com/in/jdoe/"
        assert data["public_identifier"] == "jdoe"
        assert data["full_name"] == "John Doe"
        assert data["first_name"] == "John"
        assert data["last_name"] == "Doe"
        assert data["headline"] == "CTO @ Acme Inc"
        assert data["company"] == "Acme Inc"
        assert data["connection_since"] == "2026-03-01T00:00:00.000Z"
        assert data["status"] == "detected"
        assert data["pb_connections_container_id"] == "container-abc"

    @patch("app.phantombuster_webhook.db")
    @patch("app.phantombuster_webhook.download_result_csv", return_value=SAMPLE_CSV)
    @patch("app.phantombuster_webhook.fetch_agent_info", return_value={
        "s3Folder": "folder-1", "orgS3Folder": "org-1",
    })
    def test_does_not_overwrite_existing_rows(self, _mock_info, _mock_csv, mock_db):
        # First row is new, second already exists with different status
        mock_db.upsert_outreach_connection.side_effect = [
            {
                "id": "id-1",
                "status": "detected",
                "pb_connections_container_id": "container-abc",
            },
            {
                "id": "id-2",
                "status": "drafted",  # already progressed
                "pb_connections_container_id": "old-container",
            },
        ]

        result = handle_connections_result(CONNECTIONS_PAYLOAD)

        assert result["new_ids"] == ["id-1"]
        assert result["skipped"] == 1

    @patch("app.phantombuster_webhook.db")
    @patch("app.phantombuster_webhook.download_result_csv", return_value=SAMPLE_CSV)
    @patch("app.phantombuster_webhook.fetch_agent_info", return_value={
        "s3Folder": "folder-1", "orgS3Folder": "org-1",
    })
    def test_handles_csv_with_commas_in_headline(self, _mock_info, _mock_csv, mock_db):
        """The second CSV row has a comma in the title field (quoted)."""
        mock_db.upsert_outreach_connection.side_effect = [
            {"id": "id-1", "status": "detected", "pb_connections_container_id": "container-abc"},
            {"id": "id-2", "status": "detected", "pb_connections_container_id": "container-abc"},
        ]

        handle_connections_result(CONNECTIONS_PAYLOAD)

        second_call = mock_db.upsert_outreach_connection.call_args_list[1]
        data = second_call.args[0]
        assert data["headline"] == "VP Engineering, Platform"


class TestProcessWebhookRouting:
    @patch("app.phantombuster_webhook.PB_CONNECTIONS_AGENT_ID", "conn-agent-123")
    @patch("app.phantombuster_webhook.handle_connections_result")
    def test_routes_nested_success_payload(self, mock_handle):
        from app.phantombuster_webhook import process_pb_webhook

        payload = {
            "event": "agent.finished",
            "data": {
                "agentId": "conn-agent-123",
                "containerId": "container-nested",
                "exitCode": "0",
            },
        }

        process_pb_webhook(payload)

        mock_handle.assert_called_once_with(payload)


# ---------------------------------------------------------------------------
# Send success webhook
# ---------------------------------------------------------------------------

class TestHandleSendSuccess:
    @patch("app.phantombuster_webhook._update_slack_message")
    @patch("app.phantombuster_webhook.db")
    @patch("app.phantombuster_webhook.transition_status")
    def test_marks_row_as_sent(self, mock_transition, mock_db, _mock_slack):
        existing_row = {
            "id": "outreach-1",
            "status": "send_queued",
            "retry_count": 0,
            "slack_message_ts": None,
        }
        mock_db.get_outreach_by_container_id.return_value = existing_row
        mock_db.get_db.return_value = MagicMock()
        mock_db.update_outreach.return_value = {**existing_row, "status": "sent"}

        handle_send_success(SEND_SUCCESS_PAYLOAD)

        mock_transition.assert_called_once_with(
            mock_db.get_db.return_value, "outreach-1", "sent"
        )
        update_call = mock_db.update_outreach.call_args
        updates = update_call.args[1]
        assert updates["last_error"] is None
        assert "sent_at" in updates

    @patch("app.phantombuster_webhook._update_slack_message")
    @patch("app.phantombuster_webhook.db")
    @patch("app.phantombuster_webhook.transition_status")
    def test_updates_slack_on_success(self, _mock_transition, mock_db, mock_slack):
        existing_row = {
            "id": "outreach-1",
            "status": "send_queued",
            "slack_message_ts": "123.456",
            "slack_channel": "C-test",
            "full_name": "John Doe",
        }
        mock_db.get_outreach_by_container_id.return_value = existing_row
        mock_db.get_db.return_value = MagicMock()

        handle_send_success(SEND_SUCCESS_PAYLOAD)

        mock_slack.assert_called_once_with(existing_row, "Sent")


# ---------------------------------------------------------------------------
# Send failure webhook
# ---------------------------------------------------------------------------

class TestHandleSendFailure:
    @patch("app.phantombuster_webhook._update_slack_message")
    @patch("app.phantombuster_webhook.db")
    @patch("app.phantombuster_webhook.transition_status")
    def test_marks_row_as_send_failed(self, mock_transition, mock_db, _mock_slack):
        existing_row = {
            "id": "outreach-1",
            "status": "send_queued",
            "retry_count": 1,
            "slack_message_ts": None,
        }
        mock_db.get_outreach_by_container_id.return_value = existing_row
        mock_db.get_db.return_value = MagicMock()
        mock_db.update_outreach.return_value = {**existing_row, "status": "send_failed"}

        handle_send_failure(SEND_FAILURE_PAYLOAD)

        mock_transition.assert_called_once_with(
            mock_db.get_db.return_value, "outreach-1", "send_failed"
        )
        update_call = mock_db.update_outreach.call_args
        updates = update_call.args[1]
        assert updates["last_error"] == "Profile not found"
        assert updates["retry_count"] == 2
        assert json.loads(updates["send_result"])["exitCode"] == 1

    @patch("app.phantombuster_webhook._update_slack_message")
    @patch("app.phantombuster_webhook.db")
    @patch("app.phantombuster_webhook.transition_status")
    def test_updates_slack_on_failure(self, _mock_transition, mock_db, mock_slack):
        existing_row = {
            "id": "outreach-1",
            "status": "send_queued",
            "retry_count": 0,
            "slack_message_ts": "123.456",
            "slack_channel": "C-test",
            "full_name": "John Doe",
        }
        mock_db.get_outreach_by_container_id.return_value = existing_row
        mock_db.get_db.return_value = MagicMock()

        handle_send_failure(SEND_FAILURE_PAYLOAD)

        mock_slack.assert_called_once_with(existing_row, "Failed: Profile not found")

    @patch("app.phantombuster_webhook._update_slack_message")
    @patch("app.phantombuster_webhook.db")
    @patch("app.phantombuster_webhook.transition_status")
    def test_no_row_found_logs_warning(self, _mock_transition, mock_db, _mock_slack):
        mock_db.get_outreach_by_container_id.return_value = None

        # Should not raise
        handle_send_failure(SEND_FAILURE_PAYLOAD)

        _mock_transition.assert_not_called()
