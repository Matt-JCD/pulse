from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


class TestRequeueAwaitingReviewEndpoint:
    @patch("app.db.update_outreach")
    @patch("app.db.get_outreach_by_status")
    def test_moves_awaiting_review_rows_back_to_detected(self, mock_get_rows, mock_update):
        mock_get_rows.return_value = [
            {"id": "r1", "status": "awaiting_review", "slack_message_ts": "1", "slack_channel": "C1"},
            {"id": "r2", "status": "awaiting_review", "slack_message_ts": None, "slack_channel": None},
        ]
        client = TestClient(app)

        resp = client.post("/jobs/requeue-awaiting-review?limit=10")
        data = resp.json()

        assert resp.status_code == 200
        assert data == {"status": "ok", "requeued": 2, "limit": 10}
        assert mock_update.call_count == 2
