# Compression request-path latency

Tracking issue: **#1171** (consolidates #1025, #946, #296, #1054). Distinct from
the already-fixed model-download hang (#1161 / #1146) and tiktoken-load hang
(#956 / #994) — those moved one-time blocking steps off-thread; this is about
the **per-request kompress inference** still running synchronously on the
request path.

## 1. The problem in one line

Kompress (ModernBERT ONNX) scores every token of the text inline on the request
thread under the 30 s `compression_first_stage` budget; on a large/cold context
that takes **200–300 s**, the `asyncio.wait_for` cancels but the CPU-bound worker
**cannot be preempted**, so it runs to completion holding a pool slot → the
bounded compression executor saturates → unrelated requests time out in the
queue → the proxy forwards the **original, uncompressed** request (+30 s, 0
savings).

## 2. Root cause (measured)

Sub-stage instrumentation + py-spy on a live proxy under real Claude Code use:

```
SLOW compression 209034ms breakdown (msgs=661, tok=275k):
  _deep_copy=5ms  _initial_token_count=256ms  _final_token_count=193ms
  content_router=208842ms
    _detect_pass1_ms=207816ms          # Pass-1 loop (detect + INLINE compress)
      compressor:text=101534ms          # ML  ┐ text+kompress ≈ 99% of the time
      compressor:kompress=96233ms        # ML  ┘
```

- py-spy native frames while busy: `LayerNorm / GELU / Softmax / BlockwiseQuantizer<128,8>`
  int8 MatMulNBits = ModernBERT int8 ONNX inference (kompress), **not** detection.
- Standalone sweep (model warm, CPU): 70k tok → 19 s, 319k → 80 s, **1.07 M → 273 s**.
  4 concurrent calls = 4.3× one call → serialized by `_execution_semaphore=1`.
- **When it triggers:** frozen-skip (compress only the non-cached delta) works
  ~90 % of the time in steady state. The ~10 % that re-compress the whole context
  are **cold-start on a large context**: `frozen_message_count == 0` because
  `turn == 0` (fresh tracker; first turn of a resumed/compacted conversation, 53 %)
  or `cached_tok < min_cached` (cache not warm, 47 %). Token-counting, deep-copy,
  and content-detection are all negligible (< 4 s even at 1.45 M tokens).

Code path on current `main`: `ContentRouter.apply` Pass-1 (`content_router.py`
~L2344) → `_try_ml_compressor` → `KompressCompressor.compress` (per-512-token ONNX
forward), submitted via `_run_compression_in_executor` (`server.py` ~L987–L1078,
32-worker pool + 30 s `wait_for` + non-preemptible leaked-thread accounting).

## 3. Design — phased

The fix must keep compression **local / free / private** (no paying a third party
to compress; no shipping context off-box) and must **actually compress** large
contexts (failing-fast to passthrough = 0 savings is not a fix). It builds on the
maintainers' own recent direction: routing content to fast Rust compressors
(TABULAR → SmartCrusher, #1128) and keeping the request path off the kompress
cold path (#1161).

| Phase | What | Fixes | New Rust? |
| --- | --- | --- | --- |
| **0** | Token-count gate **inside the ML boundary** → route oversized inputs to the existing `LogCompressor` instead of ModernBERT | Removes the 200–300 s catastrophe immediately | No |
| **1** | Cooperative deadline at the chunk boundary inside `KompressCompressor.compress` | Bounds the leak (any ML that runs exits at budget, not ~300 s) | No |
| **2** | `TextCrusher` — fast Rust extractive scorer (recency + structural salience + keyword relevance + near-dup) for large text; ModernBERT reserved for small/high-value | Root fix: large text compressed at ~1 s ceiling, stays local | Yes |
| **3** | Request path becomes **lookup-or-enqueue** against a content-keyed compressed-segment store; residual ML runs in a single background drain (no request deadline) | Makes the cascade impossible *by construction* | No |
| **4** | Memoize the O(messages) prelude (`read_lifecycle` + tool_map + intent scan) keyed off `frozen_message_count` | The common 2–15 s slowness that surfaces once ML is off the path | No |

Phase 0 ships first as a standalone bug-fix PR (closes the timeout cluster).
Phases 2–3 are the architectural core. Phase 4 is an orthogonal, always-ship win.

> Rejected (with reasons, from a 7-approach adversarial design pass): CDC/rolling-hash
> chunk dedup (breaks byte-identity — kompress is trained on fixed 350-word chunks);
> LLM-API remote compressor (on the trigger there is no small delta → ships the whole
> context off-box, breaks privacy + net-negative cost); message-granularity net-cost
> budgets (one giant message still runs unbounded). CoreML/ANE and GPU-sidecar are
> opt-in *accelerators* layered on **after** a non-ML backstop exists, never primary.

## 4. API / config surface

- `HEADROOM_KOMPRESS_MAX_TOKENS` (env) / `ContentRouterConfig.kompress_max_tokens`
  — Phase 0 gate threshold; inputs above it skip ModernBERT. Default calibrated to
  where ONNX exceeds ~2 s on commodity CPU. Measured in **tokens**, not words.
- `HEADROOM_COMPRESSION_DEADLINE_MS` (env) — Phase 1 cooperative chunk deadline.
- `ContentRouterConfig.enable_text_crusher` (Phase 2, default off until quality
  validated), `headroom.compression.async_store` (Phase 3, default off, opt-in).
- No new CLI flags in Phase 0–1; no new third-party dependency in Phase 0/1/3/4.
  Phase 2 adds Rust-only crates inside the existing `headroom._core` PyO3 boundary.

## 5. Changes to existing behavior

- **Phase 0:** plain text / code / log content above the token gate is compressed
  by `LogCompressor` (fast, lossy-extractive) instead of ModernBERT. Savings on
  those inputs change (LogCompressor ratio vs kompress f1=0.913); but today those
  inputs **time out and forward uncompressed (0 savings)**, so this is strictly
  better. Default **on** for large inputs (flag-gated).
- **Phase 2:** the gate target becomes `TextCrusher` (better quality than
  LogCompressor) once validated on compacted transcripts.
- **Phase 3:** the request path no longer submits ML to the executor; a cold-start
  large turn forwards uncompressed **immediately** (0 s, was +30 s) and the segment
  is compressed in the background for reuse next turn.
- Small/steady-state requests (the 90 % frozen-skip path) are **unchanged**.
- The forwarded **frozen prefix stays byte-identical** in every phase (the upstream
  prompt cache, #327 failure class, is preserved).

## 6. User stories (Given / When / Then)

- **Golden path.** *Given* a Claude Code conversation that grows turn by turn,
  *when* each turn arrives, *then* frozen-skip compresses only the new delta in
  well under the budget — unchanged from today.
- **The fix (cold-start large).** *Given* Claude Code resumes a compacted ~800 k-token
  context (turn 0, `frozen_message_count == 0`), *when* the request hits the proxy,
  *then* (Phase 0) oversized text routes to LogCompressor and returns in ≤ ~2 s with
  real savings — instead of hanging 30 s, failing open, and starving other requests.
- **Edge — genuinely incompressible giant block.** *Given* one 400 k-token block
  that neither LogCompressor nor the gate shrinks, *when* it is processed,
  *then* (Phase 1 deadline + Phase 3 off-path) it never blocks the request thread
  past the budget and never leaks a pool slot.

## 7. Failure modes

- **Quality regression on compacted prose** (the highest-stakes input is summarized
  reasoning, not structured logs). *Mitigation:* Phase 0 uses the conservative
  LogCompressor and **shadow-logs** would-be savings/quality vs kompress before
  Phase 2 defaults `TextCrusher` on; validate against the f1=0.913 /
  must_keep_recall=0.977 labeled split **and** real resumed transcripts.
- **Gate placed too shallow** (on the `PLAIN_TEXT → TEXT` branch) → `KOMPRESS`-direct
  and `CODE_AWARE → KOMPRESS` paths bypass it and re-trigger the catastrophe.
  *Mitigation:* gate inside `_try_ml_compressor` / `compress()`, with a test per path.
- **Background worker (Phase 3) crash / shutdown** leaving a stale `pending` entry →
  a segment never compresses. *Mitigation:* TTL on `pending`, drain-on-shutdown,
  idempotent re-enqueue.
- **Multi-worker uvicorn** duplicating a 300 s compression across processes.
  *Mitigation:* per-process semaphore already serializes; the Phase-3 store uses an
  fcntl-locked shared file or session affinity.

## 8. Recovery / resilience

- Every phase is **flag-gated** and **fails open to today's behavior** (passthrough)
  on any internal error — the existing `pipeline` circuit breaker (#847) and the
  compression timeout remain as the last-resort net.
- Phase 1's deadline guarantees forward progress (partial-or-passthrough, never a
  hung thread). Phase 3 decouples availability from compression entirely.

## 9. Security considerations

- No new network calls and no new at-rest surface in Phase 0/1/2/4. Phase 3's
  optional on-disk segment store holds **already-local** compressed conversation
  bytes under `~/.headroom/`; it must honor existing log/redaction config, ship
  default-off, and offer an opt-out + TTL. No content ever leaves the machine in
  any default-on phase (the rejected LLM-API option is explicitly out of scope).

## 10. Files

- `headroom/transforms/content_router.py` — gate inside `_try_ml_compressor`;
  Phase 3 lookup-or-enqueue; Phase 4 prelude memoization.
- `headroom/transforms/kompress_compressor.py` — Phase 1 cooperative deadline.
- `crates/headroom-core/…` + `headroom/transforms/` — Phase 2 `TextCrusher`.
- `headroom/cache/compression_cache.py` — Phase 3 persisted, content-keyed store.
- `benchmarks/kompress_latency_bench.py` + sub-stage instrumentation — already
  prototyped on the `perf/compression-latency` branch (supporting evidence).

## 11. Roadmap

0. **Phase 0 stopgap** — bug-fix PR (repro + per-path test + real-behavior-proof),
   closes the #1171 timeout cluster. Days.
1. **Cooperative deadline** + shadow-logging quality. ~1–2 weeks.
2. **TextCrusher** with parity/determinism fixtures; validate quality, then default on. ~2–4 weeks.
3. **Off-path store** — cascade impossible by construction; restart-survival warm hits. ~2–4 weeks.
4. **Prelude memoization** — parallel workstream.
5. *(optional, opt-in)* CoreML/ANE + GPU sidecar accelerators, after the backstop exists.
