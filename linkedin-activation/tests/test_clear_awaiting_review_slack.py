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


class TestClearSlackCardsEndpoint:
    @patch("app.db.update_outreach")
    @patch("app.main.delete_outreach_slack_message")
    @patch("app.db.get_outreach_by_status")
    def test_clears_multiple_statuses_without_touching_workflow(
        self,
        mock_get_rows,
        mock_delete,
        mock_update,
    ):
        mock_get_rows.side_effect = [
            [{"id": "r1", "status": "awaiting_review", "slack_message_ts": "1", "slack_channel": "C1"}],
            [{"id": "r2", "status": "approved", "slack_message_ts": "2", "slack_channel": "C1"}],
        ]
        mock_delete.side_effect = [True, False]
        client = TestClient(app)

        resp = client.post("/jobs/clear-slack-cards?status=awaiting_review&status=approved&limit=10")
        data = resp.json()

        assert resp.status_code == 200
        assert data == {
            "status": "ok",
            "cleared": 1,
            "skipped": 1,
            "statuses": ["awaiting_review", "approved"],
            "status_counts": {"awaiting_review": 1, "approved": 1},
            "limit": 10,
        }
        mock_get_rows.assert_any_call("awaiting_review", 10)
        mock_get_rows.assert_any_call("approved", 10)
        mock_update.assert_called_once_with("r1", {"slack_message_ts": None, "slack_channel": None})


class TestPurgeOutreachSlackCardsEndpoint:
    @patch("app.main.OUTREACH_SLACK_CHANNEL", "C-outreach")
    @patch("app.main.SLACK_BOT_TOKEN", "xoxb-test")
    @patch("app.main.WebClient")
    def test_purges_recent_outreach_cards_from_slack_history(self, mock_webclient_cls):
        mock_slack = mock_webclient_cls.return_value
        mock_slack.conversations_history.return_value = {
            "messages": [
                {
                    "ts": "1.1",
                    "blocks": [
                        {
                            "type": "actions",
                            "elements": [
                                {"action_id": "outreach_approve"},
                                {"action_id": "outreach_edit"},
                            ],
                        }
                    ],
                },
                {
                    "ts": "2.2",
                    "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "ignore"}}],
                },
            ]
        }
        client = TestClient(app)

        resp = client.post("/jobs/purge-outreach-slack-cards?limit=20")
        data = resp.json()

        assert resp.status_code == 200
        assert data == {"status": "ok", "deleted": 1, "skipped": 0, "scanned": 2, "limit": 20}
        mock_slack.conversations_history.assert_called_once()
        mock_slack.chat_delete.assert_called_once()
