from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


class TestSentThisMorningEndpoint:
    @patch("app.db.get_outreach_sent_since")
    def test_returns_sent_rows_with_message_field(self, mock_get_rows):
        mock_get_rows.return_value = [
            {
                "id": "r1",
                "full_name": "Jane Smith",
                "linkedin_profile_url": "https://www.linkedin.com/in/janesmith/",
                "approved_message": "Approved text",
                "draft_message": "Draft text",
                "sent_at": "2026-03-09T01:23:45Z",
                "pb_send_container_id": "pb-1",
            }
        ]
        client = TestClient(app)

        resp = client.get("/jobs/sent-this-morning?limit=10")
        data = resp.json()

        assert resp.status_code == 200
        assert data["status"] == "ok"
        assert data["timezone"] == "Australia/Sydney"
        assert data["count"] == 1
        assert data["rows"][0]["message"] == "Approved text"
