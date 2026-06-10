"""Mechanism B: hold-back Read maturation — compress before cache entry.

The prefix cache bills you for everything *after* the first changed byte,
so mutating an already-cached Read is ruinously expensive — but bytes that
have never been cache-written have no cache entry to bust. This module
exploits the one safe window: a fresh Read is deliberately held *out* of
the provider cache (the trailing cache breakpoint is relocated to just
before it) for a bounded number of requests. The model sees the verbatim
content exactly while it is hot. When the hold expires, the content is
replaced with a CCR-backed marker — and only that final, small form ever
enters the cache.

Timeline for a Read first seen at request R (hold_requests=1):

    R:    verbatim, NOT cached (breakpoint parked before it)
    R+1:  replaced with marker; breakpoint returns to the tail; the
          marker form is cache-written once
    R+2…: marker form read from cache at the provider discount

Two invariants:

1. **No cached byte is ever mutated.** The verbatim form is never
   cache-written, so the replacement at R+1 invalidates nothing.
2. **Replay is deterministic.** Once matured, the same marker is applied
   on every subsequent request (state is session-scoped), so the cached
   prefix stays byte-stable for the rest of the session.

Recovery contract (same as read_lifecycle): the full original is stored
in the CCR compression store, the marker carries the retrieval hash and
the file path, and the file itself remains on disk — a confused model
re-reads at the cost of one tool call.

State lives on the session's PrefixCacheTracker (same affinity and TTL
cleanup as the prefix-freeze state). Per-process, like all session state:
multi-worker deployments need sticky sessions (existing constraint).
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from typing import Any

from ..config import ReadMaturationConfig

logger = logging.getLogger(__name__)

# Tool names whose results are eligible for maturation.
_READ_TOOLS = frozenset({"Read", "read"})


@dataclass
class HeldRead:
    """Per-tool_use_id maturation state."""

    tool_use_id: str
    file_path: str
    first_seen_turn: int
    content_hash: str
    # Set when matured; replayed verbatim on every later request.
    marker: str | None = None
    ccr_hash: str | None = None

    @property
    def matured(self) -> bool:
        return self.marker is not None


@dataclass
class MaturationResult:
    """Output of one per-request maturation pass."""

    messages: list[dict[str, Any]]
    # Message indices that contain still-holding Reads (must stay out of
    # the provider cache this request — feed to relocate_cache_breakpoint).
    holding_msg_indices: list[int] = field(default_factory=list)
    newly_held: int = 0
    newly_matured: int = 0
    replacements_applied: int = 0
    bytes_saved: int = 0


class ReadMaturationManager:
    """Per-session Read maturation state machine.

    Construct once per session (or hold in a session-scoped container)
    and call :meth:`apply` on every request, after read_lifecycle and
    before breakpoint placement.
    """

    def __init__(
        self,
        config: ReadMaturationConfig,
        compression_store: Any | None = None,
    ):
        self.config = config
        self.store = compression_store
        self._held: dict[str, HeldRead] = {}

    # ─── Per-request entry point ────────────────────────────────────────

    def apply(
        self,
        messages: list[dict[str, Any]],
        turn_number: int,
        frozen_message_count: int = 0,
    ) -> MaturationResult:
        """Observe fresh Reads, mature expired holds, apply replacements.

        Args:
            messages: Conversation messages (Anthropic content-block or
                OpenAI role="tool" formats).
            turn_number: Monotonic per-session request counter (the
                prefix tracker's turn number).
            frozen_message_count: Provider-cached message count. Reads
                inside the frozen prefix were cache-written verbatim
                before this mechanism saw them (e.g. it was just
                enabled, or state was lost) — they are never touched.
        """
        result = MaturationResult(messages=messages)
        if not self.config.enabled:
            return result

        read_ids = self._read_tool_ids(messages)
        out: list[dict[str, Any]] = []
        any_changed = False

        for i, msg in enumerate(messages):
            if i < frozen_message_count:
                out.append(msg)
                continue
            new_msg, msg_holding = self._process_message(msg, i, read_ids, turn_number, result)
            out.append(new_msg)
            if new_msg is not msg:
                any_changed = True
            if msg_holding:
                result.holding_msg_indices.append(i)

        if any_changed:
            result.messages = out
        return result

    # ─── Internals ──────────────────────────────────────────────────────

    def _read_tool_ids(self, messages: list[dict[str, Any]]) -> dict[str, str]:
        """tool_use_id -> file_path for Read tool calls (both formats)."""
        ids: dict[str, str] = {}
        for msg in messages:
            if msg.get("role") != "assistant":
                continue
            for tc in msg.get("tool_calls", []) or []:
                if not isinstance(tc, dict):
                    continue
                func = tc.get("function", {})
                if func.get("name") in _READ_TOOLS:
                    import json as _json

                    try:
                        args = _json.loads(func.get("arguments", "{}"))
                    except (ValueError, TypeError):
                        args = {}
                    ids[tc.get("id", "")] = args.get("file_path") or args.get("path") or ""
            content = msg.get("content")
            if isinstance(content, list):
                for b in content:
                    if (
                        isinstance(b, dict)
                        and b.get("type") == "tool_use"
                        and b.get("name") in _READ_TOOLS
                    ):
                        inp = b.get("input") or {}
                        ids[b.get("id", "")] = inp.get("file_path") or inp.get("path") or ""
        return ids

    def _process_message(
        self,
        msg: dict[str, Any],
        msg_index: int,
        read_ids: dict[str, str],
        turn_number: int,
        result: MaturationResult,
    ) -> tuple[dict[str, Any], bool]:
        """Returns (possibly-replaced message, message_still_holding)."""
        role = msg.get("role", "")
        content = msg.get("content", "")

        # OpenAI format: whole message is one tool result.
        if role == "tool":
            tc_id = msg.get("tool_call_id", "")
            if tc_id in read_ids and isinstance(content, str):
                new_content, holding = self._handle_read(
                    tc_id, read_ids[tc_id], content, turn_number, result
                )
                if new_content is not None:
                    return {**msg, "content": new_content}, holding
                return msg, holding
            return msg, False

        # Anthropic format: tool_result blocks inside a user message.
        if isinstance(content, list):
            new_blocks: list[Any] = []
            changed = False
            holding_any = False
            for b in content:
                if (
                    isinstance(b, dict)
                    and b.get("type") == "tool_result"
                    and b.get("tool_use_id", "") in read_ids
                    and isinstance(b.get("content"), str)
                    and "cache_control" not in b
                ):
                    tc_id = b["tool_use_id"]
                    new_content, holding = self._handle_read(
                        tc_id, read_ids[tc_id], b["content"], turn_number, result
                    )
                    holding_any = holding_any or holding
                    if new_content is not None:
                        new_blocks.append({**b, "content": new_content})
                        changed = True
                        continue
                new_blocks.append(b)
            if changed:
                return {**msg, "content": new_blocks}, holding_any
            return msg, holding_any

        return msg, False

    def _handle_read(
        self,
        tc_id: str,
        file_path: str,
        content: str,
        turn_number: int,
        result: MaturationResult,
    ) -> tuple[str | None, bool]:
        """Returns (replacement_content | None, still_holding)."""
        state = self._held.get(tc_id)

        # Matured earlier: replay the recorded marker deterministically.
        if state is not None and state.matured:
            # Already-replaced content (replayed from a compression cache
            # upstream) passes through; otherwise substitute.
            if content == state.marker:
                return None, False
            result.replacements_applied += 1
            result.bytes_saved += max(0, len(content) - len(state.marker or ""))
            return state.marker, False

        size = len(content.encode("utf-8", errors="replace"))
        if size < self.config.min_size_bytes:
            return None, False
        # Lifecycle markers (stale/superseded) are already compact — and
        # read_lifecycle runs first, so respect its replacement.
        if "Retrieve original: hash=" in content or "Retrieve more: hash=" in content:
            return None, False

        if state is None:
            # First sight: register and hold out of the cache.
            self._held[tc_id] = HeldRead(
                tool_use_id=tc_id,
                file_path=file_path,
                first_seen_turn=turn_number,
                content_hash=hashlib.sha256(content.encode("utf-8", errors="replace")).hexdigest()[
                    :24
                ],
            )
            result.newly_held += 1
            return None, True

        if turn_number - state.first_seen_turn < self.config.hold_requests:
            return None, True  # still in the verbatim window

        # Hold expired: mature. Store the original, record the marker.
        ccr_hash = state.content_hash
        if self.store is not None:
            try:
                ccr_hash = self.store.store(
                    original=content,
                    compressed="",
                    tool_name="Read",
                    tool_call_id=tc_id,
                    compression_strategy="read_maturation",
                )
            except Exception as e:  # noqa: BLE001 - storage failure must not break the request
                logger.warning("read_maturation: CCR store failed for %s: %s", tc_id, e)

        file_display = file_path or "unknown"
        # NOTE: "Retrieve original: hash=" is load-bearing (marker-
        # preserving regex + ContentRouter compression pinning).
        state.marker = (
            f"[Read of {file_display} compressed after use — re-read the file "
            f"if needed. Retrieve original: hash={ccr_hash}]"
        )
        state.ccr_hash = ccr_hash
        result.newly_matured += 1
        result.replacements_applied += 1
        result.bytes_saved += max(0, len(content) - len(state.marker))
        return state.marker, False


def relocate_cache_breakpoint(
    messages: list[dict[str, Any]],
    holding_msg_indices: list[int],
) -> list[dict[str, Any]]:
    """Park the trailing message-level cache breakpoint before held Reads.

    Strips ``cache_control`` from every block at or after the earliest
    holding message, and places one ephemeral breakpoint on the last
    block of the latest *eligible* message before it — so the provider
    caches everything up to (not including) the held Reads. System- and
    tools-level breakpoints are untouched (they live outside messages).

    Total breakpoints never increase: at most one is added after one or
    more are removed. Returns the original list unchanged when there is
    nothing to do.
    """
    if not holding_msg_indices:
        return messages

    earliest = min(holding_msg_indices)
    out: list[dict[str, Any]] = list(messages)
    stripped_any = False

    # 1. Strip breakpoints from the held region [earliest:].
    for i in range(earliest, len(out)):
        msg = out[i]
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        if any(isinstance(b, dict) and "cache_control" in b for b in content):
            out[i] = {
                **msg,
                "content": [
                    {k: v for k, v in b.items() if k != "cache_control"}
                    if isinstance(b, dict)
                    else b
                    for b in content
                ],
            }
            stripped_any = True

    if not stripped_any:
        # No client breakpoint in the held region — nothing was going to
        # cache the held Reads this request; leave placement alone.
        return out

    # 2. Re-anchor: ephemeral breakpoint on the last block of the latest
    #    block-style message before the held region.
    for i in range(earliest - 1, -1, -1):
        content = out[i].get("content")
        if isinstance(content, list) and content and isinstance(content[-1], dict):
            new_content = list(content)
            new_content[-1] = {**new_content[-1], "cache_control": {"type": "ephemeral"}}
            out[i] = {**out[i], "content": new_content}
            break

    return out
