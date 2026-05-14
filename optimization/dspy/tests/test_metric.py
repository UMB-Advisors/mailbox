"""Tests for ``metric.JudgeMetric``.

Coverage:
* Judge response parsing: well-formed JSON → ``(1, reason)``, malformed →
  ``(0, ...)`` conservative fallback, code-fence wrapping tolerated.
* Cosine math: identical vectors → 1.0, orthogonal → 0.0, mismatched
  length → 0.0.
* Empty candidate → automatic loss, judge not called.
* Mocked Ollama Cloud happy path: judge returns ``win=1``, cosine disabled,
  ``__call__`` returns ``1.0``.
* Wire shape: POST hits ``{judge_base_url}/api/chat`` with a Bearer auth
  header carrying ``OLLAMA_CLOUD_API_KEY``.

All Ollama Cloud + local-Ollama calls are mocked at the ``httpx.Client``
level. No live cloud or local-network calls happen in CI.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from metric import (
    JudgeConfig,
    JudgeMetric,
    JudgeResult,
    _cosine,
    _parse_judge_response,
)


# ---------------------------------------------------------------------------
# Pure helpers — no env / cloud
# ---------------------------------------------------------------------------


def test_parse_judge_response_well_formed_win() -> None:
    win, reason = _parse_judge_response('{"win": 1, "reason": "matches intent"}')
    assert win == 1
    assert reason == "matches intent"


def test_parse_judge_response_well_formed_loss() -> None:
    win, reason = _parse_judge_response('{"win": 0, "reason": "tone off"}')
    assert win == 0
    assert reason == "tone off"


def test_parse_judge_response_strips_code_fence() -> None:
    raw = '```json\n{"win": 1, "reason": "ok"}\n```'
    win, reason = _parse_judge_response(raw)
    assert win == 1
    assert reason == "ok"


def test_parse_judge_response_unparseable_is_loss() -> None:
    win, reason = _parse_judge_response("absolutely not JSON")
    assert win == 0
    assert "unparseable" in reason


def test_parse_judge_response_non_bool_win_is_loss() -> None:
    win, reason = _parse_judge_response('{"win": "yes", "reason": "..."}')
    assert win == 0
    assert "win not 0/1" in reason


def test_parse_judge_response_non_object_is_loss() -> None:
    win, reason = _parse_judge_response("[1, 2, 3]")
    assert win == 0
    assert "not a JSON object" in reason


def test_cosine_identical_is_one() -> None:
    assert _cosine([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]) == pytest.approx(1.0)


def test_cosine_orthogonal_is_zero() -> None:
    assert _cosine([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)


def test_cosine_length_mismatch_is_zero() -> None:
    assert _cosine([1.0], [1.0, 1.0]) == 0.0


def test_cosine_zero_vector_is_zero() -> None:
    assert _cosine([0.0, 0.0], [1.0, 1.0]) == 0.0


# ---------------------------------------------------------------------------
# Mocked end-to-end
# ---------------------------------------------------------------------------


def _fake_chat_response(content_text: str) -> MagicMock:
    """Build an ``httpx.Response``-shaped mock for an Ollama ``/api/chat`` success."""

    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "message": {"role": "assistant", "content": content_text},
    }
    mock_resp.raise_for_status.return_value = None
    return mock_resp


def _build_mock_metric(monkeypatch: pytest.MonkeyPatch) -> JudgeMetric:
    """Construct a ``JudgeMetric`` without touching real Ollama Cloud.

    Replaces the metric's ``httpx.Client`` with a ``MagicMock`` after
    construction so the judge HTTP POST never leaves the process, and
    forces ``disable_cosine=True`` so we don't touch the local Ollama for
    embeddings either.
    """

    monkeypatch.setenv("OLLAMA_CLOUD_API_KEY", "oc-test-key")
    metric = JudgeMetric(JudgeConfig(disable_cosine=True))
    metric._http = MagicMock()  # noqa: SLF001 — replace real client
    return metric


def test_empty_candidate_is_automatic_loss(monkeypatch: pytest.MonkeyPatch) -> None:
    metric = _build_mock_metric(monkeypatch)
    try:
        result = metric.judge(inbound="hi", reference="hello", candidate="   ")
        assert isinstance(result, JudgeResult)
        assert result.win == 0
        assert result.reason == "empty candidate"
        # And the Ollama Cloud mock was never called.
        assert metric._http.post.called is False  # noqa: SLF001
    finally:
        metric.close()


def test_judge_happy_path_returns_win(monkeypatch: pytest.MonkeyPatch) -> None:
    metric = _build_mock_metric(monkeypatch)
    try:
        metric._http.post.return_value = _fake_chat_response(  # noqa: SLF001
            '{"win": 1, "reason": "matches intent"}',
        )

        score = metric(
            SimpleNamespace(inbound_body="hi", reply_body="reference reply"),
            SimpleNamespace(reply_body="candidate reply"),
        )
        assert score == 1.0
        assert metric._http.post.called is True  # noqa: SLF001

        # Verify wire shape: URL targets /api/chat on the configured base
        # and the Bearer auth header carries the API key.
        call = metric._http.post.call_args  # noqa: SLF001
        url = call.args[0] if call.args else call.kwargs.get("url")
        assert url == "https://ollama.com/api/chat"
        assert call.kwargs["headers"]["Authorization"] == "Bearer oc-test-key"
        assert call.kwargs["json"]["model"] == "gpt-oss:120b"
        assert call.kwargs["json"]["stream"] is False
    finally:
        metric.close()


def test_judge_ollama_cloud_error_is_loss(monkeypatch: pytest.MonkeyPatch) -> None:
    metric = _build_mock_metric(monkeypatch)
    try:
        metric._http.post.side_effect = RuntimeError("503 overloaded")  # noqa: SLF001
        result = metric.judge(inbound="hi", reference="ref", candidate="cand")
        assert result.win == 0
        assert "errored" in result.reason
        assert "503" in (result.error or "")
    finally:
        metric.close()


def test_judge_missing_api_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OLLAMA_CLOUD_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="OLLAMA_CLOUD_API_KEY"):
        JudgeMetric(JudgeConfig(disable_cosine=True))
