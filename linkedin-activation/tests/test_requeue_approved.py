from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


class TestRequeueApprovedEndpoint:
    @patch("app.db.update_outreach")
    @patch("app.db.get_outreach_by_status")
    def test_moves_approved_rows_back_to_detected_and_clears_approval_fields(
        self,
        mock_get_rows,
        mock_update,
    ):
        mock_get_rows.return_value = [
            {"id": "r1", "status": "approved", "approved_message": "hello"},
            {"id": "r2", "status": "approved", "approved_message": "hi"},
        ]
        client = TestClient(app)

        resp = client.post("/jobs/requeue-approved?limit=10")
        data = resp.json()

        assert resp.status_code == 200
        assert data == {"status": "ok", "requeued": 2, "limit": 10}
        mock_get_rows.assert_called_once_with("approved", 10)
        assert mock_update.call_count == 2
        mock_update.assert_any_call(
            "r1",
            {
                "status": "detected",
                "approved_message": None,
                "approved_at": None,
                "slack_message_ts": None,
                "slack_channel": None,
            },
        )
