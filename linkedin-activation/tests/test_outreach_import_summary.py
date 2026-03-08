from __future__ import annotations

from unittest.mock import patch


class TestOutreachImportSummaryEndpoint:
    @patch("app.db.get_outreach_status_counts")
    def test_returns_counts_and_estimated_filtered(self, mock_counts):
        from fastapi.testclient import TestClient
        from app.main import app

        mock_counts.return_value = {"detected": 320, "awaiting_review": 90}
        client = TestClient(app)

        resp = client.get("/jobs/outreach-import-summary?seen_count=475")
        data = resp.json()

        assert resp.status_code == 200
        assert data["status"] == "ok"
        assert data["total_outreach"] == 410
        assert data["seen_count"] == 475
        assert data["estimated_filtered"] == 65
        assert data["status_counts"] == {"detected": 320, "awaiting_review": 90}
