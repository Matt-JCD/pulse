from __future__ import annotations

from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.main import app


class TestDeleteAwaitingReviewEndpoint:
    @patch("app.main.delete_outreach_slack_message")
    @patch("app.db.get_db")
    @patch("app.db.get_outreach_by_status")
    def test_deletes_rows_and_attempts_slack_cleanup(self, mock_get_rows, mock_get_db, mock_delete_slack):
        mock_get_rows.return_value = [
            {"id": "r1", "status": "awaiting_review", "slack_message_ts": "1", "slack_channel": "C1"},
            {"id": "r2", "status": "awaiting_review", "slack_message_ts": None, "slack_channel": None},
        ]
        mock_delete_slack.side_effect = [True, False]

        chain = MagicMock()
        chain.delete.return_value = chain
        chain.eq.return_value = chain
        mock_table = MagicMock(return_value=chain)
        mock_get_db.return_value.table = mock_table

        client = TestClient(app)
        resp = client.post("/jobs/delete-awaiting-review?limit=10")
        data = resp.json()

        assert resp.status_code == 200
        assert data == {
            "status": "ok",
            "deleted": 2,
            "slack_deleted": 1,
            "slack_skipped": 1,
            "limit": 10,
        }
        mock_get_rows.assert_called_once_with("awaiting_review", 10)
        mock_table.assert_called_once_with("linkedin_outreach")
        assert chain.execute.call_count == 2
