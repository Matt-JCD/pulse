from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


class TestClearAwaitingReviewSlackEndpoint:
    @patch("app.main.delete_outreach_slack_message")
    @patch("app.db.get_outreach_by_status")
    def test_clears_cards_without_touching_status(self, mock_get_rows, mock_delete):
        mock_get_rows.return_value = [
            {"id": "r1", "status": "awaiting_review", "slack_message_ts": "1", "slack_channel": "C1"},
            {"id": "r2", "status": "awaiting_review", "slack_message_ts": "2", "slack_channel": "C1"},
        ]
        mock_delete.side_effect = [True, False]
        client = TestClient(app)

        resp = client.post("/jobs/clear-awaiting-review-slack?limit=10")
        data = resp.json()

        assert resp.status_code == 200
        assert data == {"status": "ok", "cleared": 1, "skipped": 1, "limit": 10}
        mock_get_rows.assert_called_once_with("awaiting_review", 10)
