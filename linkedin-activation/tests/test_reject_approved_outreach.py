from __future__ import annotations

from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.main import app
from app.state_machine import validate_transition


class TestApprovedRejectTransition:
    def test_allows_approved_to_rejected(self):
        assert validate_transition("approved", "rejected") is True


class TestRejectApprovedOutreachEndpoint:
    @patch("app.main.handle_outreach_reject")
    @patch("app.db.get_db")
    @patch("app.db.get_outreach_by_full_name")
    def test_rejects_single_approved_row(self, mock_get_rows, mock_get_db, mock_reject):
        mock_get_rows.return_value = [{"id": "row-1", "full_name": "Dr Kellie Nuttall", "status": "approved"}]
        mock_get_db.return_value = MagicMock()
        client = TestClient(app)

        resp = client.post("/jobs/reject-approved-outreach?full_name=Dr%20Kellie%20Nuttall")
        data = resp.json()

        assert resp.status_code == 200
        assert data == {"status": "ok", "outreach_id": "row-1", "full_name": "Dr Kellie Nuttall"}
        mock_reject.assert_called_once_with(mock_get_db.return_value, "row-1")

    @patch("app.db.get_outreach_by_full_name")
    def test_returns_error_when_no_approved_row_found(self, mock_get_rows):
        mock_get_rows.return_value = []
        client = TestClient(app)

        resp = client.post("/jobs/reject-approved-outreach?full_name=Dr%20Kellie%20Nuttall")
        data = resp.json()

        assert resp.status_code == 200
        assert data["status"] == "error"
        assert data["error"] == "No approved outreach found"
