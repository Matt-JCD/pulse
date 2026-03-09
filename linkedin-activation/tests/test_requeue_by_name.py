from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


class TestRequeueRejectedOutreachEndpoint:
    @patch("app.db.update_outreach")
    @patch("app.db.get_outreach_by_full_name")
    def test_moves_rejected_row_back_to_detected(self, mock_get_rows, mock_update):
        mock_get_rows.return_value = [{"id": "r1", "full_name": "Sean R Turner", "status": "rejected"}]
        client = TestClient(app)

        resp = client.post("/jobs/requeue-rejected-outreach?full_name=Sean%20R%20Turner")
        data = resp.json()

        assert resp.status_code == 200
        assert data == {"status": "ok", "outreach_id": "r1", "full_name": "Sean R Turner"}
        mock_update.assert_called_once_with(
            "r1",
            {
                "status": "detected",
                "slack_message_ts": None,
                "slack_channel": None,
                "approved_message": None,
                "approved_at": None,
                "last_error": None,
            },
        )


class TestUndoSentOutreachEndpoint:
    @patch("app.db.update_outreach")
    @patch("app.db.get_outreach_by_full_name")
    def test_moves_sent_row_back_to_detected(self, mock_get_rows, mock_update):
        mock_get_rows.return_value = [{"id": "r2", "full_name": "Mark Brown", "status": "sent"}]
        client = TestClient(app)

        resp = client.post("/jobs/undo-sent-outreach?full_name=Mark%20Brown")
        data = resp.json()

        assert resp.status_code == 200
        assert data == {"status": "ok", "outreach_id": "r2", "full_name": "Mark Brown"}
        mock_update.assert_called_once_with(
            "r2",
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


class TestUndoSentOutreachByProfileEndpoint:
    @patch("app.db.update_outreach")
    @patch("app.db.get_outreach_by_profile_url")
    def test_moves_sent_row_back_to_detected_by_profile_url(self, mock_get_row, mock_update):
        mock_get_row.return_value = {
            "id": "r3",
            "full_name": "Mark Brown",
            "status": "sent",
            "linkedin_profile_url": "https://www.linkedin.com/in/mark-brown-aws/",
        }
        client = TestClient(app)

        resp = client.post("/jobs/undo-sent-outreach-by-profile?profile_url=https://www.linkedin.com/in/mark-brown-aws/")
        data = resp.json()

        assert resp.status_code == 200
        assert data == {
            "status": "ok",
            "outreach_id": "r3",
            "full_name": "Mark Brown",
            "profile_url": "https://www.linkedin.com/in/mark-brown-aws/",
        }
        mock_update.assert_called_once_with(
            "r3",
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
