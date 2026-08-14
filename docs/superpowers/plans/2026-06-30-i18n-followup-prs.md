# i18n Compression Follow-up PRs — Plan

- Date: 2026-06-30
- Status: LOCAL planning doc (do not commit)
- Base: **all on `main`**, after #1504 merges (each builds on #1504's CJK path: `is_cjk`, the split/tokens/relevance/salience CJK dispatch). Independent PRs, but all touch `crusher.rs` → sequence them to avoid self-conflict.
- Conflict scan (2026-06-30): `crusher.rs` (TextCrusher) and `relevance/bm25.rs` are clear — no open PR touches them except #1504. peterlodri-sec is active but only in the **kompress** lane (different files). No external collisions.

## Shared prerequisites (every PR)
- #1504 merged into `main` (provides `is_cjk` + the CJK dispatch all four build on). #1527 (eval metrics) and #1530 (multi-wiki-qa dataset) also merged ideally.
- Rebuild `_core` after each branch switch (`uv pip install -e .`); ruff is pinned at **0.15.17** (match CI); run Python via `.venv/bin/python -m pytest`.
- Validate every PR with the committed i18n eval (`benchmarks/i18n_compression_eval.py`) — Part C deterministic gate + Part A multi-wiki-qa numbers. Show before/after in the Real Behavior Proof.

---

## PR A — anchor-aware salience  ★ recommended first (highest value)

**Goal:** make compression preferentially keep "do-not-drop" anchors — file paths, URLs, commands, ports/env vars, identifiers, numbers, error keywords — the spans agent workflows depend on (headroom-zh's central insight; your eval Part B salient retention is only **37.9%**, clear room to lift).

**Files:** `crates/headroom-core/src/transforms/text_crusher/crusher.rs` — `is_salient` (and re-recorded fixtures).

**Approach:** extend `is_salient` (a per-token predicate) beyond today's ASCII keywords / ALLCAPS / dotted-identifiers / digits to also recognize: paths (`/a/b/c`, `a\\b\\c`), URLs (`http(s)://…`), and command/flag-ish tokens. Benefits English immediately AND CJK (since #1504 routes CJK salience through `is_salient` over the icu tokens).

**Care:** `is_salient` is SHARED with the English path → must not regress English. Re-record the English parity fixtures + the CJK `unicode` fixture. Gate: existing Rust+Python text_crusher tests stay green; the i18n eval Part B salient retention should rise.

**Effort:** M · **Conflict:** none.

---

## PR B — fullwidth/halfwidth NFKC fold in `tokens_icu`

**Goal:** normalize fullwidth ASCII (`ＡＰＩ`→`API`, `０`→`0`) and halfwidth kana so width variants tokenize/match like their normal forms (real CJK content mixes these).

**Files:** `crusher.rs` — `tokens_icu` only (the CJK-gated token path; isolated).

**Approach:** NFKC-fold each token before lowercasing inside `tokens_icu`. Only the internal token KEY is normalized — the kept output stays verbatim (byte-faithful contract preserved).

**Care:** touches only the CJK path; English untouched. Re-record the CJK `unicode` fixture if dedup/relevance shifts. Add a Rust unit test (`ＡＰＩ` and `API` produce the same token).

**Effort:** S · **Conflict:** none. *(Smallest — good warm-up / quick merged commit.)*

---

## PR C — Korean (Hangul) improvement

**Goal:** lift Korean answer-retention (eval measured **ko 50%** vs zh 74% / ja 70% — ICU has no Korean dictionary, falls back to UAX#29 space-breaking → coarse word units).

**Files:** `crusher.rs` — the CJK tokenization path for Hangul (+ a Korean eval case).

**Approach (experiment first):** Korean is space-delimited at the eojeol level, so UAX#29 splits on spaces but the units are coarse for relevance. Try sub-eojeol Hangul bigrams (the same overlapping-bigram idiom used elsewhere) to get finer relevance/dedup tokens for Hangul runs; measure against the eval's `ko` number. Keep whatever the eval shows is better; don't ship a change that doesn't move `ko`.

**Care:** Korean-specific; don't regress zh/ja. Validate with the eval's per-language numbers + a Korean Rust unit test.

**Effort:** M–L (needs experimentation) · **Conflict:** none.

---

## PR D — shared `BM25Scorer` CJK relevance  (capstone; do LAST)

**Goal:** make the SHARED `BM25Scorer` score CJK (its `TOKEN_PATTERN` is ASCII-only → CJK = 0 terms), so CJK relevance works for its OTHER consumers (e.g. SmartCrusher), not just TextCrusher's local `relevance_cjk`.

**Files:** `crates/headroom-core/src/relevance/bm25.rs` **and** `headroom/relevance/bm25.py` (parity-locked — MUST mirror byte-exactly) + a new CJK parity fixture.

**Approach:** add a CJK pre-tokenization arm to the shared tokenizer, mirrored byte-exactly in Python and Rust, pinned by a new CJK parity fixture proving token-for-token agreement.

**Care:** HIGHEST risk — parity is the binding constraint; an asymmetric edit breaks the byte-exact mirror. Only attempt after A/B/C build the track record. Marginal value note: #1504's local `relevance_cjk` already covers TextCrusher, so this is specifically for the shared-scorer consumers — confirm SmartCrusher actually sees CJK content before investing.

**Effort:** L · **Conflict:** none external, but the parity surface is delicate.

---

## Recommended order

1. **PR B** (fullwidth fold) — smallest, cleanest, fast merged commit; warms up the crusher.rs surface.
2. **PR A** (anchor salience) — highest value, aligns with headroom-zh; the headline follow-up.
3. **PR C** (Korean) — closes the measured ko gap.
4. **PR D** (shared BM25 CJK) — only if SmartCrusher-on-CJK demand is real; heaviest.

Each is an independent PR off `main`; do them one at a time (they share `crusher.rs`). Out of scope for now (separate sweep): CJK gaps in other compressors (search/diff/log/adaptive_sizer) — independent of #1504, can be picked up anytime.
