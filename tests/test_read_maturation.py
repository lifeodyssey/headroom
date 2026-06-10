"""Tests for Mechanism B: hold-back Read maturation.

The two invariants under test, beyond basic behavior:
1. No cached byte is ever mutated — frozen-prefix content and content
   carrying a client cache_control breakpoint are untouched.
2. Replay is deterministic — once matured, the same marker is applied on
   every subsequent request, byte-identical.
"""

from __future__ import annotations

import pytest

from headroom.config import ReadMaturationConfig
from headroom.transforms.read_maturation import (
    ReadMaturationManager,
    relocate_cache_breakpoint,
)

CONTENT = "     1\tdef foo():\n     2\t    return 42\n" * 60  # > 2048B
SMALL = "     1\tok\n"


def anthropic_read(tc_id: str, file_path: str, content: str) -> list[dict]:
    return [
        {
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": tc_id, "name": "Read", "input": {"file_path": file_path}}
            ],
        },
        {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": tc_id, "content": content}],
        },
    ]


def openai_read(tc_id: str, file_path: str, content: str) -> list[dict]:
    return [
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": tc_id,
                    "function": {"name": "Read", "arguments": f'{{"file_path": "{file_path}"}}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": tc_id, "content": content},
    ]


def conv() -> list[dict]:
    return [{"role": "user", "content": "look"}, *anthropic_read("r1", "/x/foo.py", CONTENT)]


def manager(**overrides) -> ReadMaturationManager:
    cfg = ReadMaturationConfig(enabled=True, **overrides)
    return ReadMaturationManager(cfg)


class TestStateMachine:
    def test_disabled_is_noop(self):
        m = ReadMaturationManager(ReadMaturationConfig(enabled=False))
        res = m.apply(conv(), turn_number=1)
        assert res.messages == conv()
        assert res.holding_msg_indices == []

    def test_first_sight_holds_verbatim(self):
        m = manager()
        res = m.apply(conv(), turn_number=1)
        # Content untouched, message flagged as holding.
        assert res.messages[2]["content"][0]["content"] == CONTENT
        assert res.holding_msg_indices == [2]
        assert res.newly_held == 1
        assert res.newly_matured == 0

    def test_matures_after_hold_window(self):
        m = manager(hold_requests=1)
        m.apply(conv(), turn_number=1)
        res = m.apply(conv(), turn_number=2)

        assert res.newly_matured == 1
        assert res.holding_msg_indices == []
        marker = res.messages[2]["content"][0]["content"]
        assert "compressed after use" in marker
        assert "/x/foo.py" in marker
        assert "Retrieve original: hash=" in marker
        assert res.bytes_saved > 0

    def test_replay_is_deterministic(self):
        m = manager(hold_requests=1)
        m.apply(conv(), turn_number=1)
        a = m.apply(conv(), turn_number=2).messages[2]["content"][0]["content"]
        b = m.apply(conv(), turn_number=3).messages[2]["content"][0]["content"]
        c = m.apply(conv(), turn_number=9).messages[2]["content"][0]["content"]
        assert a == b == c

    def test_longer_hold_window(self):
        m = manager(hold_requests=3)
        assert m.apply(conv(), turn_number=1).holding_msg_indices == [2]
        assert m.apply(conv(), turn_number=2).holding_msg_indices == [2]
        assert m.apply(conv(), turn_number=3).holding_msg_indices == [2]
        res = m.apply(conv(), turn_number=4)
        assert res.newly_matured == 1
        assert res.holding_msg_indices == []

    def test_small_reads_ignored(self):
        msgs = [{"role": "user", "content": "look"}, *anthropic_read("r1", "/x/a.py", SMALL)]
        m = manager()
        res = m.apply(msgs, turn_number=1)
        assert res.holding_msg_indices == []
        assert m.apply(msgs, turn_number=5).messages[2]["content"][0]["content"] == SMALL

    def test_frozen_prefix_untouched(self):
        # A Read inside the frozen prefix (cached verbatim before this
        # mechanism saw it) is never held or replaced.
        m = manager(hold_requests=1)
        msgs = conv()
        res = m.apply(msgs, turn_number=1, frozen_message_count=len(msgs))
        assert res.holding_msg_indices == []
        res = m.apply(msgs, turn_number=5, frozen_message_count=len(msgs))
        assert res.messages[2]["content"][0]["content"] == CONTENT

    def test_respects_lifecycle_markers(self):
        # read_lifecycle runs first; its marker output must pass through.
        marker = "[Read content stale: /x/foo.py ... Retrieve original: hash=abc123]" + " " * 2048
        msgs = [{"role": "user", "content": "look"}, *anthropic_read("r1", "/x/foo.py", marker)]
        m = manager()
        res = m.apply(msgs, turn_number=1)
        assert res.holding_msg_indices == []

    def test_block_with_client_breakpoint_untouched(self):
        msgs = conv()
        msgs[2]["content"][0]["cache_control"] = {"type": "ephemeral"}
        m = manager(hold_requests=1)
        res = m.apply(msgs, turn_number=1)
        assert res.holding_msg_indices == []
        res = m.apply(msgs, turn_number=5)
        assert res.messages[2]["content"][0]["content"] == CONTENT

    def test_openai_format(self):
        msgs = [{"role": "user", "content": "look"}, *openai_read("r1", "/x/foo.py", CONTENT)]
        m = manager(hold_requests=1)
        res = m.apply(msgs, turn_number=1)
        assert res.holding_msg_indices == [2]
        res = m.apply(msgs, turn_number=2)
        assert "compressed after use" in res.messages[2]["content"]

    def test_multiple_reads_independent_clocks(self):
        m = manager(hold_requests=1)
        msgs1 = conv()
        m.apply(msgs1, turn_number=1)
        msgs2 = [*msgs1, *anthropic_read("r2", "/x/bar.py", CONTENT)]
        res = m.apply(msgs2, turn_number=2)
        # r1 matured (held at turn 1); r2 just arrived, still holding.
        assert res.newly_matured == 1
        assert res.holding_msg_indices == [4]
        res = m.apply(msgs2, turn_number=3)
        assert res.newly_matured == 1  # r2 matures
        assert res.holding_msg_indices == []


class TestCcrIntegration:
    def test_original_stored_and_retrievable(self):
        from headroom.cache.backends.memory import InMemoryBackend
        from headroom.cache.compression_store import CompressionStore

        store = CompressionStore(backend=InMemoryBackend())
        m = ReadMaturationManager(
            ReadMaturationConfig(enabled=True, hold_requests=1), compression_store=store
        )
        m.apply(conv(), turn_number=1)
        res = m.apply(conv(), turn_number=2)

        marker = res.messages[2]["content"][0]["content"]
        ccr_hash = marker.split("hash=")[1].rstrip("]")
        entry = store.retrieve(ccr_hash)
        assert entry is not None
        assert entry.original_content == CONTENT
        assert entry.compression_strategy == "read_maturation"


class TestBreakpointRelocation:
    def _msgs_with_tail_breakpoint(self) -> list[dict]:
        msgs = [
            {"role": "user", "content": [{"type": "text", "text": "earlier turn"}]},
            *anthropic_read("r1", "/x/foo.py", CONTENT),
        ]
        # Client breakpoint on the last block of the last message.
        msgs[-1]["content"][-1] = {
            **msgs[-1]["content"][-1],
            "cache_control": {"type": "ephemeral"},
        }
        return msgs

    @staticmethod
    def _breakpoint_indices(msgs: list[dict]) -> list[int]:
        return [
            i
            for i, m in enumerate(msgs)
            if isinstance(m.get("content"), list)
            and any(isinstance(b, dict) and "cache_control" in b for b in m["content"])
        ]

    def test_noop_without_holds(self):
        msgs = self._msgs_with_tail_breakpoint()
        assert relocate_cache_breakpoint(msgs, []) is msgs

    def test_relocates_before_held_read(self):
        msgs = self._msgs_with_tail_breakpoint()
        out = relocate_cache_breakpoint(msgs, [2])

        # Held region [2:] carries no breakpoint; re-anchored on the
        # latest eligible message before it (index 1 — the assistant
        # tool_use message), so everything up to but excluding the held
        # Read still gets cached.
        assert self._breakpoint_indices(out) == [1]
        assert out[1]["content"][-1]["cache_control"] == {"type": "ephemeral"}
        # Total breakpoint count did not grow.
        assert len(self._breakpoint_indices(out)) <= len(self._breakpoint_indices(msgs))

    def test_noop_when_no_breakpoint_in_held_region(self):
        msgs = [
            {"role": "user", "content": [{"type": "text", "text": "x"}]},
            *anthropic_read("r1", "/x/foo.py", CONTENT),
        ]
        out = relocate_cache_breakpoint(msgs, [2])
        assert self._breakpoint_indices(out) == []

    def test_originals_not_mutated(self):
        msgs = self._msgs_with_tail_breakpoint()
        before = [str(m) for m in msgs]
        relocate_cache_breakpoint(msgs, [2])
        assert [str(m) for m in msgs] == before


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
