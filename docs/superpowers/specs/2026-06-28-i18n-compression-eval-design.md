# i18n Compression-Quality Eval — Design Spec

- Date: 2026-06-28
- Status: design (LOCAL ONLY — do not commit, per request)
- Scope: headroomlabs-ai/headroom · contributor fork `lifeodyssey`
- Anchor: extends PR #1504 (CJK-aware TextCrusher)

## 1. Purpose

Make "does compression keep the important content in non-English text" an
objective, reproducible, in-repo measurement for Chinese / Japanese / Korean.

Three goals, in order:
1. **Regression gate** — turn #1504's one-off "34%→93%" claim into a permanent
   test that fails if anyone regresses CJK compression.
2. **Verifiable** — anyone can run it; numbers are reproducible.
3. **Ownership** — be the person who can answer "does compression work for
   language X", which the repo currently cannot answer for any non-English lang.

## 2. Evidence base (every decision is grounded; file:line / citation)

### Repo prior art + patterns (verified, file:line)
- `benchmarks/text_crusher_quality_eval.py` is the template: **3 parts** — Part A
  SQuAD answer-retention with TextCrusher-vs-truncate-vs-random baselines
  (`:89-127`); Part B real anonymized-transcript salient-token retention
  (`:156-186`, salient regex `:32`); Part C synthetic speed, no external data
  (`:189-204`). **No LLM calls**; loads data from a local path and **gracefully
  skips if absent** (`:207-222`).
- `headroom/evals/datasets.py::load_longbench` passes an **arbitrary** task to
  `load_dataset("THUDM/LongBench", task)` (`:374-406`) — generic.
- `DATASET_REGISTRY` entries are 4 keys: `loader`, `description`, `category`,
  `default_n`; dispatched by `load_dataset_by_name` (`:1147-1273`).
- HuggingFace `datasets` is an **optional** dep — declared in the `[evals]` extra
  (`pyproject.toml:215`), guarded by `_check_datasets_installed()` which raises a
  helpful ImportError (`datasets.py:37-45`), tested at `tests/test_evals_datasets.py:29`.
- `EvalCase` = `id, context, query, ground_truth?, metadata?` (`core.py:30-46`).

### Confirmed CJK bugs in the eval layer (real, file:line)
- `headroom/evals/metrics.py:25` — `tokenize()` uses `re.findall(r"\b\w+\b", ...)`.
  On CJK this yields the **whole run as ONE token** (`"你好世界" → ["你好世界"]`),
  so token-F1 is sentence-level all-or-nothing — meaningless for CJK.
- `headroom/evals/core.py:264` — `_estimate_tokens` returns `len(text)//4`,
  which underestimates CJK by ~4–8× (CJK is ~1–2 tokens/char, not 0.25).

### Dataset research (verified, citations)
- LongBench v1 = **en+zh only** (no ja/ko). LongBench v2 = English-only +
  multiple-choice (disqualified: MC breaks substring retention). InfiniteBench =
  en+zh only.
- **Natural ja long-context extractive QA does not exist turnkey on HF**
  (JSQuAD/JaQuAD too short; JDocQA abstractive). **ko** only via KorQuAD 2.0
  (HTML, CC-BY-ND, messy).
- **`alexandrainst/multi-wiki-qa`** is the only HF dataset covering **zh+ja+ko**
  with **paper-guaranteed verbatim-span answers** + full-article (long) contexts,
  plain text. License **CC-BY-NC-SA-4.0 (non-commercial)**.
  (arXiv 2509.04111; HF card.)
- OneRuler covers zh/ja/ko NIAH at 8K–128K but is **GitHub-only, not HF-loadable**
  (local generation) — reserved as future controlled-length study.

## 3. Design

### 3.1 Component: `benchmarks/i18n_compression_eval.py`
A standalone script mirroring `text_crusher_quality_eval.py` exactly (no LLM, all
local), but multilingual. Three parts:

- **Part C — our own synthetic answer-retention (zh/ja/ko)** — *the core; always
  runs; zero external data; license-clean.* Hand-built "needle" sentences (each
  carrying a distinctive verbatim fact) buried in language-matched distractor
  sentences; compress query-aware; assert the needle survives. Run for zh, ja, ko
  + a baseline contrast (TextCrusher vs truncate vs random). This is the
  deterministic regression gate that can run in CI.
- **Part B — real CJK transcript fidelity** — optional; loads an anonymized local
  jsonl (auto-discover like prior art); measures ratio, speed, and **CJK-aware**
  salient-token retention (a CJK-extended salient pattern; the existing one at
  `line 32` is ASCII-only). Skips if no transcript.
- **Part A — natural-data objective signal** — optional; loads
  `alexandrainst/multi-wiki-qa` (`zh-cn`/`ja`/`ko`) via the `[evals]` `datasets`
  path with the `_check_datasets_installed` guard; answer-retention vs baselines.
  Skips if `datasets` or data absent.

Order of importance: **C (always) > B (representative) > A (natural-data confirm)**.

### 3.2 Data flow
`for each language: build/load (context, query, answer) cases → for each method
(text_crusher | truncate | random): compress(context, query, ratio) → normalize →
substring(answer) survives? → aggregate retention rate.` Identical to prior art;
extended over languages and made deterministic in Part C.

### 3.3 Error handling
Fail-open / skip, matching prior art: missing `datasets` → skip Part A with a
message; missing transcript → skip Part B; Part C never depends on anything
external. The script always prints *something* useful and exits 0.

### 3.4 License handling (best practice; evidence-backed)
- **What runs in CI / always = our own synthetic Part C** → license-clean.
- **`multi-wiki-qa` (NC) is never vendored into the repo** — loaded at run time,
  skipped if absent — exactly how the repo already treats SQuAD/LongBench (data
  is not committed). The NC license therefore governs only whoever downloads it
  to run Part A, not the repository.

## 4. PR sequence (squash repo → each = 1 merged commit)

1. **PR #6** `test(benchmarks): i18n (zh/ja/ko) compression answer-retention eval`
   — the standalone script above. Part C always-runs; A/B optional. No production
   code, no parity surface → lowest review risk. **Verify `multi-wiki-qa` actually
   loads + answer is a verbatim span before finalizing** (don't trust secondhand).
2. **PR #7** `fix(evals): CJK-aware tokenization (metrics.py) + token estimate (core.py)`
   — replace `\b\w+\b` F1 tokenization and `len//4` with CJK-aware logic. Real bug
   fixes; independently mergeable.
3. **PR #8** `feat(evals): register multilingual QA dataset in DATASET_REGISTRY`
   — add a `load_multi_wiki_qa(lang=...)` loader + registry entry (4 keys), so the
   framework (`BeforeAfterRunner`, etc.) can run zh/ja/ko first-class. Depends on
   #7 so the framework metrics are CJK-correct.
4. **#1504 update** — replace the ad-hoc CMRC proof in its Real Behavior Proof
   with a reference to the committed eval (#6), upgrading the evidence from a
   one-off number to a reproducible asset.

## 5. Testing
- Part C is itself the test (deterministic asserts that needles survive at the
  target ratio for each language; baselines must do worse).
- For PR #7: unit tests that CJK F1 tokenization splits CJK into word-units and
  that `_estimate_tokens` returns CJK-plausible counts.
- For PR #8: a guarded loader test mirroring `tests/test_evals_datasets.py`.

## 6. YAGNI / explicitly out of scope
- No refactor of `metrics.py` beyond CJK tokenization.
- No OneRuler local-generation pipeline (future controlled-length study only).
- No traditional/simplified or kana normalization unless a measured failure
  demands it.
- Do not touch the shared parity-locked `BM25Scorer`.

## 7. Open risks
- `multi-wiki-qa` NC license — mitigated by load-or-skip + clean synthetic core
  (§3.4); flag for maintainer awareness in the PR.
- multifieldqa_zh remains a fine alternative zh source if a commercial-license zh
  signal is preferred; multi-wiki-qa chosen for uniform zh+ja+ko.
