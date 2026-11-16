import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse

from query_ids import QueryError, main, query_ids


class FakeOpener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return io.BytesIO(json.dumps(response).encode())


class QueryIDsTest(unittest.TestCase):
    def test_bearer_and_cursor_pagination(self):
        opener = FakeOpener(
            {"items": [{"id": "a", "created_at": "2026-08-14T00:00:00Z"}], "next_cursor": "next"},
            {"items": [{"id": "b", "created_at": "2026-08-13T23:59:59Z"}]},
        )

        items = list(
            query_ids(
                "https://ledger.example/",
                "secret",
                "team/A",
                "2026-08-13T00:00:00Z",
                "2026-08-15T00:00:00Z",
                2,
                opener,
            )
        )

        self.assertEqual([item["id"] for item in items], ["a", "b"])
        self.assertEqual(len(opener.requests), 2)
        self.assertEqual(opener.requests[0].get_header("Authorization"), "Bearer secret")
        self.assertEqual(opener.requests[0].get_header("User-agent"), "cf-id-ledger-query/1.0")
        self.assertEqual(urlparse(opener.requests[0].full_url).path, "/v1/projects/team%2FA/ids")
        self.assertEqual(
            parse_qs(urlparse(opener.requests[0].full_url).query),
            {"since": ["2026-08-13T00:00:00Z"], "until": ["2026-08-15T00:00:00Z"], "limit": ["2"]},
        )
        self.assertEqual(parse_qs(urlparse(opener.requests[1].full_url).query), {"cursor": ["next"], "limit": ["2"]})

    def test_http_failure_is_explicit(self):
        error = HTTPError(
            "https://ledger.example",
            401,
            "Unauthorized",
            None,
            io.BytesIO(b'{"error":"unauthorized"}'),
        )

        with self.assertRaisesRegex(QueryError, "HTTP 401: unauthorized"):
            list(query_ids("https://ledger.example", "bad", "demo", "2026-08-14T00:00:00Z", opener=FakeOpener(error)))
        self.assertTrue(error.fp.closed)

    def test_invalid_base_url_exits_without_traceback(self):
        stderr = io.StringIO()
        with patch.dict(os.environ, {"ID_LEDGER_TOKEN": "secret"}), redirect_stderr(stderr):
            status = main(["demo", "--since", "2026-08-14T00:00:00Z", "--base-url", "not-a-url"])

        self.assertEqual(status, 1)
        self.assertTrue(stderr.getvalue().startswith("error: invalid URL:"))
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_cli_uses_environment_defaults_and_prints_json(self):
        since = "2026-08-14T00:00:00Z"
        item = {"id": "a", "created_at": "2026-08-14T00:00:00Z"}
        stdout = io.StringIO()
        with patch.dict(os.environ, {"ID_LEDGER_URL": "https://ledger.example", "ID_LEDGER_TOKEN": "secret"}):
            with patch("query_ids.query_ids", return_value=[item]) as query:
                with redirect_stdout(stdout):
                    status = main(["demo", "--since", since, "--limit", "1"])

        self.assertEqual(status, 0)
        query.assert_called_once_with("https://ledger.example", "secret", "demo", since, None, 1)
        self.assertEqual(stdout.getvalue(), '{"id":"a","created_at":"2026-08-14T00:00:00Z"}\n')

    def test_cli_rejects_out_of_range_page_size(self):
        stderr = io.StringIO()
        with patch.dict(os.environ, {"ID_LEDGER_TOKEN": "secret"}), redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as exit_info:
                main(["demo", "--since", "2026-08-14T00:00:00Z", "--base-url", "https://ledger.example", "--limit", "1001"])

        self.assertEqual(exit_info.exception.code, 2)
        self.assertIn("--limit: must be between 1 and 1000", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
