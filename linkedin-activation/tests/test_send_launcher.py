from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest

from app.send_launcher import launch_approved_sends


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_row(id: str, **overrides) -> dict:
    base = {
        "id": id,
        "linkedin_profile_url": f"https://linkedin.com/in/user-{id}",
        "approved_message": f"Hello from row {id}!",
        "draft_message": f"Draft for {id}",
        "status": "approved",
        "retry_count": 0,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# launch_approved_sends
# ---------------------------------------------------------------------------

class TestLaunchApprovedSends:
    @patch("app.send_launcher.time.sleep")
    @patch("app.send_launcher.transition_status")
    @patch("app.send_launcher.db")
    @patch("app.send_launcher.launch_message_sender")
    def test_launches_approved_rows(self, mock_launch, mock_db, mock_transition, _sleep):
        mock_db.get_sent_today_count.return_value = 0
        mock_db.get_approved_outreach.return_value = [
            _make_row("r1"),
            _make_row("r2"),
        ]
        mock_launch.return_value = {"containerId": "c-123"}
        supabase = MagicMock()

        result = launch_approved_sends(supabase)

        assert result["launched"] == 2
        assert mock_launch.call_count == 2
        assert mock_transition.call_count == 2

    @patch("app.send_launcher.time.sleep")
    @patch("app.send_launcher.transition_status")
    @patch("app.send_launcher.db")
    @patch("app.send_launcher.launch_message_sender")
    def test_respects_daily_limit(self, mock_launch, mock_db, _mock_transition, _sleep):
        mock_db.get_sent_today_count.return_value = 15  # At limit (default 15)
        supabase = MagicMock()

        result = launch_approved_sends(supabase)

        assert result["launched"] == 0
        mock_db.get_approved_outreach.assert_not_called()
        mock_launch.assert_not_called()

    @patch("app.send_launcher.DAILY_SEND_LIMIT", 5)
    @patch("app.send_launcher.time.sleep")
    @patch("app.send_launcher.transition_status")
    @patch("app.send_launcher.db")
    @patch("app.send_launcher.launch_message_sender")
    def test_limits_to_remaining_quota(self, mock_launch, mock_db, _mock_transition, _sleep):
        mock_db.get_sent_today_count.return_value = 3  # 2 remaining
        mock_db.get_approved_outreach.return_value = [
            _make_row("r1"),
            _make_row("r2"),
        ]
        mock_launch.return_value = {"containerId": "c-1"}
        supabase = MagicMock()

        launch_approved_sends(supabase)

        # Should request at most 2 rows (limit=remaining)
        mock_db.get_approved_outreach.assert_called_once_with(limit=2)

    @patch("app.send_launcher.time.sleep")
    @patch("app.send_launcher.transition_status")
    @patch("app.send_launcher.db")
    @patch("app.send_launcher.launch_message_sender")
    def test_oldest_approved_first(self, mock_launch, mock_db, _mock_transition, _sleep):
        """get_approved_outreach returns oldest first — send_launcher processes in that order."""
        mock_db.get_sent_today_count.return_value = 0
        rows = [_make_row("old"), _make_row("new")]
        mock_db.get_approved_outreach.return_value = rows
        mock_launch.return_value = {"containerId": "c-1"}
        supabase = MagicMock()

        launch_approved_sends(supabase)

        # First call should be for the oldest row
        first_call = mock_launch.call_args_list[0]
        assert first_call[0][0] == "https://linkedin.com/in/user-old"

    @patch("app.send_launcher.time.sleep")
    @patch("app.send_launcher.transition_status")
    @patch("app.send_launcher.db")
    @patch("app.send_launcher.launch_message_sender")
    def test_skips_missing_profile_url(self, mock_launch, mock_db, _mock_transition, _sleep):
        mock_db.get_sent_today_count.return_value = 0
        mock_db.get_approved_outreach.return_value = [
            _make_row("r1", linkedin_profile_url=None),
        ]
        supabase = MagicMock()

        result = launch_approved_sends(supabase)

        assert result["skipped"] == 1
        assert result["launched"] == 0
        mock_launch.assert_not_called()

    @patch("app.send_launcher.time.sleep")
    @patch("app.send_launcher.transition_status")
    @patch("app.send_launcher.db")
    @patch("app.send_launcher.launch_message_sender")
    def test_uses_approved_message_over_draft(self, mock_launch, mock_db, _mock_transition, _sleep):
        mock_db.get_sent_today_count.return_value = 0
        mock_db.get_approved_outreach.return_value = [
            _make_row("r1", approved_message="Approved text", draft_message="Draft text"),
        ]
        mock_launch.return_value = {"containerId": "c-1"}
        supabase = MagicMock()

        launch_approved_sends(supabase)

        mock_launch.assert_called_once_with(
            "https://linkedin.com/in/user-r1",
            "Approved text",
        )

    @patch("app.send_launcher.time.sleep")
    @patch("app.send_launcher.transition_status")
    @patch("app.send_launcher.db")
    @patch("app.send_launcher.launch_message_sender")
    def test_stores_container_id(self, mock_launch, mock_db, mock_transition, _sleep):
        mock_db.get_sent_today_count.return_value = 0
        mock_db.get_approved_outreach.return_value = [_make_row("r1")]
        mock_launch.return_value = {"containerId": "pb-container-456"}
        supabase = MagicMock()

        launch_approved_sends(supabase)

        mock_db.update_outreach.assert_called_once_with(
            "r1", {"pb_send_container_id": "pb-container-456"}
        )

    @patch("app.send_launcher.time.sleep")
    @patch("app.send_launcher.transition_status")
    @patch("app.send_launcher.db")
    @patch("app.send_launcher.launch_message_sender")
    def test_continues_on_error(self, mock_launch, mock_db, mock_transition, _sleep):
        mock_db.get_sent_today_count.return_value = 0
        mock_db.get_approved_outreach.return_value = [
            _make_row("r1"),
            _make_row("r2"),
        ]
        mock_launch.side_effect = [Exception("PB down"), {"containerId": "c-2"}]
        supabase = MagicMock()

        result = launch_approved_sends(supabase)

        assert result["launched"] == 1
        assert len(result["errors"]) == 1
        assert "r1" in result["errors"][0]

    @patch("app.send_launcher.time.sleep")
    @patch("app.send_launcher.transition_status")
    @patch("app.send_launcher.db")
    @patch("app.send_launcher.launch_message_sender")
    def test_sleeps_between_launches(self, mock_launch, mock_db, _mock_transition, mock_sleep):
        mock_db.get_sent_today_count.return_value = 0
        mock_db.get_approved_outreach.return_value = [
            _make_row("r1"),
            _make_row("r2"),
        ]
        mock_launch.return_value = {"containerId": "c-1"}
        supabase = MagicMock()

        launch_approved_sends(supabase)

        # Sleep called after first launch (before second), not after last
        mock_sleep.assert_called_with(2)
        assert mock_sleep.call_count == 1


# ---------------------------------------------------------------------------
# Detection launcher
# ---------------------------------------------------------------------------

class TestDetectionLauncher:
    @patch("app.detection_launcher.launch_connections_export")
    @patch("app.detection_launcher.db")
    def test_defaults_to_7_days_ago(self, mock_db, mock_export):
        mock_db.get_outreach_by_status.return_value = []
        mock_db.get_db.return_value.table.return_value.select.return_value\
            .order.return_value.limit.return_value.execute.return_value.data = []
        mock_db.OUTREACH_TABLE = "linkedin_outreach"
        mock_export.return_value = {"containerId": "c-1"}

        from app.detection_launcher import launch_detection
        result = launch_detection()

        call_args = mock_export.call_args[0][0]
        # Should be a valid MM-DD-YYYY date string
        assert len(call_args) == 10
        assert call_args[2] == "-" and call_args[5] == "-"

    @patch("app.detection_launcher.launch_connections_export")
    @patch("app.detection_launcher.db")
    def test_uses_manual_override_date(self, mock_db, mock_export):
        mock_db.get_outreach_by_status.return_value = []
        mock_db.get_db.return_value.table.return_value.select.return_value\
            .order.return_value.limit.return_value.execute.return_value.data = [
            {"connection_since": "2026-03-07T00:00:00Z"}
        ]
        mock_db.OUTREACH_TABLE = "linkedin_outreach"
        mock_export.return_value = {"containerId": "c-1"}

        from app.detection_launcher import launch_detection
        launch_detection("01.01.2026")

        mock_export.assert_called_once_with("01-01-2026")

    @patch("app.detection_launcher.launch_connections_export")
    @patch("app.detection_launcher.db")
    def test_uses_latest_connection_since(self, mock_db, mock_export):
        mock_db.get_outreach_by_status.return_value = []
        mock_db.get_db.return_value.table.return_value.select.return_value\
            .order.return_value.limit.return_value.execute.return_value.data = [
            {"connection_since": "2026-03-01T00:00:00Z"}
        ]
        mock_db.OUTREACH_TABLE = "linkedin_outreach"
        mock_export.return_value = {"containerId": "c-1"}

        from app.detection_launcher import launch_detection
        launch_detection()

        mock_export.assert_called_once_with("03-01-2026")


# ---------------------------------------------------------------------------
# Retry endpoint constraints
# ---------------------------------------------------------------------------

class TestRetryEndpoint:
    @patch("app.db.get_outreach")
    def test_rejects_non_failed_status(self, mock_get):
        from fastapi.testclient import TestClient
        from app.main import app

        mock_get.return_value = {"id": "r1", "status": "approved", "retry_count": 0}
        client = TestClient(app)
        resp = client.post("/outreach/r1/retry-send")
        data = resp.json()
        assert data["status"] == "error"
        assert "send_failed" in data["error"]

    @patch("app.db.get_outreach")
    def test_rejects_max_retries(self, mock_get):
        from fastapi.testclient import TestClient
        from app.main import app

        mock_get.return_value = {"id": "r1", "status": "send_failed", "retry_count": 3}
        client = TestClient(app)
        resp = client.post("/outreach/r1/retry-send")
        data = resp.json()
        assert data["status"] == "error"
        assert "Max retries" in data["error"]

    @patch("app.state_machine.transition_status")
    @patch("app.db.get_db")
    @patch("app.db.get_outreach")
    def test_moves_failed_row_back_to_approved(self, mock_get, mock_get_db, mock_transition):
        from fastapi.testclient import TestClient
        from app.main import app

        mock_get.return_value = {"id": "r1", "status": "send_failed", "retry_count": 1}
        mock_get_db.return_value = MagicMock()
        client = TestClient(app)

        resp = client.post("/outreach/r1/retry-send")
        data = resp.json()

        assert data["status"] == "ok"
        mock_transition.assert_called_once_with(mock_get_db.return_value, "r1", "approved")

    @patch("app.main.ADMIN_API_KEY", "admin-secret")
    @patch("app.db.get_recent_failures")
    def test_admin_failures_endpoint_returns_rows(self, mock_failures):
        from fastapi.testclient import TestClient
        from app.main import app

        mock_failures.return_value = [
            {
                "id": "r1",
                "full_name": "Berowne",
                "linkedin_profile_url": "https://www.linkedin.com/in/berowne/",
                "last_error": "Couldn't type in chat widget",
                "retry_count": 1,
                "updated_at": "2026-03-08T02:21:52Z",
            }
        ]
        client = TestClient(app)

        resp = client.get("/admin/outreach/failures?limit=5", headers={"x-api-key": "admin-secret"})
        data = resp.json()

        assert resp.status_code == 200
        assert data["limit"] == 5
        assert data["failures"][0]["linkedin_profile_url"] == "https://www.linkedin.com/in/berowne/"

    @patch("app.main.ADMIN_API_KEY", "admin-secret")
    @patch("app.state_machine.transition_status")
    @patch("app.db.get_db")
    @patch("app.db.get_outreach_by_profile_url")
    def test_admin_retry_by_profile_url(self, mock_get, mock_get_db, mock_transition):
        from fastapi.testclient import TestClient
        from app.main import app

        mock_get.return_value = {
            "id": "r1",
            "status": "send_failed",
            "retry_count": 1,
            "linkedin_profile_url": "https://www.linkedin.com/in/berowne/",
        }
        mock_get_db.return_value = MagicMock()
        client = TestClient(app)

        resp = client.post(
            "/admin/outreach/retry-send?profile_url=https://www.linkedin.com/in/berowne/",
            headers={"x-api-key": "admin-secret"},
        )
        data = resp.json()

        assert resp.status_code == 200
        assert data["status"] == "ok"
        assert data["outreach_id"] == "r1"
        mock_transition.assert_called_once_with(mock_get_db.return_value, "r1", "approved")
