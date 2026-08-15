# i18n Compression-Quality Eval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-repo, reproducible eval that proves extractive compression keeps answer-bearing content in Chinese/Japanese/Korean, then make the eval framework CJK-correct and first-class for multilingual data.

**Architecture:** A standalone benchmark script mirroring `benchmarks/text_crusher_quality_eval.py` (no LLM, local, graceful-skip), with a *deterministic in-repo* needle-retention core (Part C) plus optional real-transcript (Part B) and optional natural-data (Part A, `alexandrainst/multi-wiki-qa`) parts. Then two `evals/` bug-fix/registration PRs and a proof update on PR #1504.

**Tech Stack:** Python 3, `headroom.transforms.text_crusher.TextCrusher` (native `_core`), `re`, optional HuggingFace `datasets` (the `[evals]` extra), `pytest`.

## Global Constraints

- **Depends on PR #1504**: the CJK TextCrusher code must be present. Branch PR #6 from #1504's branch (or from `main` after #1504 merges), and rebuild `_core` (`uv pip install -e .`) before running — CJK retention is ~0 without #1504.
- **Squash repo → each PR = exactly 1 merged commit.** Keep each PR independently reviewable.
- **Never vendor external datasets into the repo.** Load at run time; skip gracefully if absent (mirrors how `text_crusher_quality_eval.py:207-222` treats SQuAD, and the `_check_datasets_installed` guard at `headroom/evals/datasets.py:37-45`).
- **`alexandrainst/multi-wiki-qa` is CC-BY-NC-SA-4.0 (non-commercial)** — only the optional Part A touches it; the always-run Part C uses our own data. Flag the license in the PR body.
- **Do NOT commit** this plan or the spec (`docs/superpowers/specs/2026-06-28-i18n-compression-eval-design.md`).
- **Do NOT touch** the parity-locked shared `BM25Scorer` (`relevance/bm25.rs` / `bm25.py`).
- Mirror prior-art conventions: no LLM/API calls; print aggregate metrics only; anonymize transcript content before processing.
- Dev gotcha: rebuild `_core` after any branch switch; run Python via `.venv/bin/python -m pytest`.

---

## File Structure

- `benchmarks/i18n_compression_eval.py` — **create** (PR #6). The 3-part standalone eval. One responsibility: measure CJK compression answer-retention locally.
- `tests/test_transforms/test_text_crusher_cjk_eval.py` — **create** (PR #6). The CI regression gate: deterministic asserts that the zh/ja/ko needles survive compression and beat baselines. Imports the eval's pure functions.
- `headroom/evals/metrics.py:25` — **modify** (PR #7). CJK-aware `tokenize()`.
- `headroom/evals/core.py:264` — **modify** (PR #7). CJK-aware `_estimate_tokens`.
- `tests/test_evals_metrics.py` — **create/extend** (PR #7).
- `headroom/evals/datasets.py` — **modify** (PR #8). Add `load_multi_wiki_qa` + registry entry.
- `tests/test_evals_datasets.py` — **extend** (PR #8).

---

# PR #6 — `test(benchmarks): i18n (zh/ja/ko) compression answer-retention eval`

### Task 1: Branch, scaffold the eval file, shared helpers

**Files:**
- Create: `benchmarks/i18n_compression_eval.py`

**Interfaces:**
- Produces: `anon(t: str) -> str`, `norm(s: str) -> str`, `_segs(text) -> list[str]`, `truncate_keep_last(text, ratio) -> str`, `random_keep(text, ratio, seed) -> str` — reused by all three parts.

- [ ] **Step 1: Create the branch off #1504, rebuild `_core`**

```bash
cd /Users/lumimamini/Documents/headroom
git fetch upstream main
# base off the #1504 branch so CJK TextCrusher is present:
git checkout feat/cjk-text-compression
git checkout -b feat/i18n-compression-eval
export PATH="$HOME/.cargo/bin:$PATH" && uv pip install -e .   # rebuild _core
```
Expected: `_core` builds; `python -c "from headroom.transforms.text_crusher import TextCrusher"` succeeds.

- [ ] **Step 2: Write the file header + shared helpers**

```python
#!/usr/bin/env python3
"""i18n compression-quality eval (zh/ja/ko): does extractive compression keep
the answer-bearing content in CJK?  No LLM/API calls -- fully local.

Part C -- our own DETERMINISTIC needle answer-retention (zh/ja/ko): the always-
runs regression gate. Hand-built needle sentences buried in language-matched
distractors; compress query-aware; assert the needle survives. No external data.
Part B -- real-transcript fidelity with CJK-aware salient: optional, anonymized.
Part A -- natural-data answer-retention on alexandrainst/multi-wiki-qa
(zh-cn/ja/ko): optional, via the [evals] datasets extra, skipped if absent.

Usage: python benchmarks/i18n_compression_eval.py [transcript.jsonl]
"""
from __future__ import annotations

import glob
import os
import random
import re
import sys
import time

from headroom.transforms.text_crusher import TextCrusher

_REDACT = [
    (re.compile(r"/Users/[^/\s]+"), "/Users/USER"),
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"), "EMAIL"),
    (re.compile(r"\b(?:sk|pk|ghp|gho|xox[baprs])-[A-Za-z0-9_-]{10,}\b"), "TOKEN"),
    (re.compile(r"\b[A-Fa-f0-9]{40,}\b"), "HEX"),
]
# CJK sentence terminators included so distractor/needle splitting works for CJK.
_SEG = re.compile(r"(?<=[.!?。！？])\s*|\n+")


def anon(t: str) -> str:
    for rx, rep in _REDACT:
        t = rx.sub(rep, t)
    return t


def norm(s: str) -> str:
    # CJK has no spaces; drop all whitespace so substring match is robust.
    return re.sub(r"\s+", "", s.lower())


def _segs(text: str) -> list[str]:
    return [s for s in _SEG.split(text) if s.strip()]


def truncate_keep_last(text: str, ratio: float) -> str:
    segs = _segs(text)
    budget = int(sum(len(s) for s in segs) * ratio)
    kept, c = [], 0
    for s in reversed(segs):
        if c >= budget:
            break
        kept.append(s)
        c += len(s)
    return "".join(reversed(kept))


def random_keep(text: str, ratio: float, seed: int) -> str:
    segs = _segs(text)
    idx = list(range(len(segs)))
    random.Random(seed).shuffle(idx)
    budget = int(sum(len(s) for s in segs) * ratio)
    kept, c = set(), 0
    for i in idx:
        if c >= budget:
            break
        kept.add(i)
        c += len(segs[i])
    return "".join(segs[i] for i in sorted(kept))
```

- [ ] **Step 3: Verify it imports**

Run: `.venv/bin/python -c "import benchmarks.i18n_compression_eval as e; print(e.norm('  你好 世界 '))"`
Expected: prints `你好世界`

- [ ] **Step 4: Commit**

```bash
git add benchmarks/i18n_compression_eval.py
git commit -m "test(benchmarks): scaffold i18n compression eval helpers"
```

---

### Task 2: Part C — deterministic zh/ja/ko needle retention + CI gate (the core)

**Files:**
- Modify: `benchmarks/i18n_compression_eval.py`
- Create: `tests/test_transforms/test_text_crusher_cjk_eval.py`

**Interfaces:**
- Produces: `NEEDLES: dict[str, dict]` (per-lang `{needle, query, key, distractors}`), `retention_synthetic(lang: str, ratio: float = 0.3, seed: int = 0) -> dict[str, bool]` returning `{"text_crusher": bool, "truncate": bool, "random": bool}` (did the needle key survive), and `eval_synthetic() -> None` (prints the table).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_transforms/test_text_crusher_cjk_eval.py
import pytest
from benchmarks.i18n_compression_eval import retention_synthetic

@pytest.mark.parametrize("lang", ["zh", "ja", "ko"])
def test_cjk_needle_survives_compression(lang):
    r = retention_synthetic(lang, ratio=0.3, seed=0)
    assert r["text_crusher"], f"{lang}: query-relevant needle dropped by TextCrusher"

@pytest.mark.parametrize("lang", ["zh", "ja", "ko"])
def test_text_crusher_beats_or_ties_baselines(lang):
    r = retention_synthetic(lang, ratio=0.3, seed=0)
    # query-aware must not lose to keep-recent / random on the planted needle
    assert r["text_crusher"] >= max(r["truncate"], r["random"])
```

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_transforms/test_text_crusher_cjk_eval.py -q`
Expected: FAIL with `ImportError: cannot import name 'retention_synthetic'`

- [ ] **Step 3: Implement Part C in the eval file**

```python
# Each needle carries a distinctive verbatim KEY that must survive. Distractors
# are language-matched, topic-unrelated sentences (hand-built; deterministic).
NEEDLES = {
    "zh": {
        "query": "认证令牌缓存淘汰策略",
        "key": "最近最少使用淘汰",
        "needle": "认证令牌的缓存采用最近最少使用淘汰算法来管理过期条目。",
        "distractors": [
            "今天的天气晴朗，适合外出散步和拍照。",
            "公司年会定在下个月的第三个星期五举行。",
            "这家餐厅的招牌菜是红烧肉和清蒸鱼。",
            "周末我打算去图书馆借几本历史书。",
            "新的地铁线路预计在明年春天开通运营。",
            "他每天早上都会跑步锻炼身体半个小时。",
        ],
    },
    "ja": {
        "query": "認証トークン キャッシュ 破棄",
        "key": "最長未使用",
        "needle": "認証トークンのキャッシュは最長未使用アルゴリズムで管理される。",
        "distractors": [
            "今日は天気が良いので公園を散歩しました。",
            "来月の第三金曜日に会社の懇親会があります。",
            "この店の名物は焼き魚と味噌汁の定食です。",
            "週末は図書館で歴史の本を借りる予定です。",
            "新しい地下鉄の路線は来年の春に開業します。",
            "毎朝三十分のジョギングを習慣にしています。",
        ],
    },
    "ko": {
        "query": "인증 토큰 캐시 제거 전략",
        "key": "최근 최소 사용",
        "needle": "인증 토큰 캐시는 최근 최소 사용 알고리즘으로 관리된다.",
        "distractors": [
            "오늘은 날씨가 맑아서 공원을 산책했습니다.",
            "다음 달 셋째 주 금요일에 회사 모임이 있습니다.",
            "이 식당의 대표 메뉴는 불고기와 된장찌개입니다.",
            "주말에는 도서관에서 역사책을 빌릴 계획입니다.",
            "새 지하철 노선은 내년 봄에 개통될 예정입니다.",
            "매일 아침 삼십 분씩 조깅하는 습관이 있습니다.",
        ],
    },
}


def _haystack(spec: dict, seed: int) -> str:
    docs = list(spec["distractors"]) + [spec["needle"]]
    random.Random(seed).shuffle(docs)
    return "".join(docs)  # CJK: no separators, flowing — the hard case


def retention_synthetic(lang: str, ratio: float = 0.3, seed: int = 0) -> dict[str, bool]:
    spec = NEEDLES[lang]
    hay = _haystack(spec, seed)
    key = norm(spec["key"])
    tc = TextCrusher()
    out_tc = tc.compress(hay, context=spec["query"], target_ratio=ratio).compressed
    return {
        "text_crusher": key in norm(out_tc),
        "truncate": key in norm(truncate_keep_last(hay, ratio)),
        "random": key in norm(random_keep(hay, ratio, seed)),
    }


def eval_synthetic(ratio: float = 0.3) -> None:
    print(f"\n=== Part C: synthetic needle retention (zh/ja/ko, target_ratio={ratio}) ===")
    print(f"  {'lang':5} {'text_crusher':>13} {'truncate':>9} {'random':>7}")
    for lang in ("zh", "ja", "ko"):
        r = retention_synthetic(lang, ratio)
        print(f"  {lang:5} {str(r['text_crusher']):>13} {str(r['truncate']):>9} {str(r['random']):>7}")
    print("  (needle must survive under TextCrusher; baselines are the contrast)")
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_transforms/test_text_crusher_cjk_eval.py -q`
Expected: PASS (6 tests). If a needle fails, widen `ratio` to 0.4 OR confirm `_core` includes #1504; do NOT weaken the assert.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/i18n_compression_eval.py tests/test_transforms/test_text_crusher_cjk_eval.py
git commit -m "test(benchmarks): deterministic zh/ja/ko needle retention + CI gate"
```

---

### Task 3: Part B — real CJK transcript fidelity with CJK-aware salient

**Files:**
- Modify: `benchmarks/i18n_compression_eval.py`

**Interfaces:**
- Produces: `_SALIENT_ASCII` (re), `_cjk_hapax(text) -> set[str]`, `salient_set(text) -> set[str]`, `eval_transcript(jsonl_path, ratio=0.4, min_chars=600, limit=40) -> None`.

- [ ] **Step 1: Implement CJK-aware salient + transcript fidelity**

```python
# ASCII salient (identifiers/numbers/errors) STILL matters in CJK coding context.
_SALIENT_ASCII = re.compile(
    r"\b(?:error|exception|fail(?:ed|ure)?|warning|traceback|assert|todo|fixme)\b"
    r"|\b[A-Z]{2,}\b|\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b|\b\d+\b"
)
_CJK_RUN = re.compile(r"[㐀-鿿぀-ヿ가-힯]+")


def _cjk_hapax(text: str) -> set[str]:
    # distinctive CJK content = char-bigrams occurring exactly once (rare = must-keep)
    grams: dict[str, int] = {}
    for run in _CJK_RUN.findall(text):
        for i in range(len(run) - 1):
            g = run[i : i + 2]
            grams[g] = grams.get(g, 0) + 1
    return {g for g, c in grams.items() if c == 1}


def salient_set(text: str) -> set[str]:
    return set(_SALIENT_ASCII.findall(text)) | _cjk_hapax(text)


def _block_texts(jsonl_path: str, min_chars: int, limit: int) -> list[str]:
    import json

    out: list[str] = []
    with open(jsonl_path, encoding="utf-8") as fh:
        for line in fh:
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            c = (o.get("message") or {}).get("content")
            parts = (
                [c] if isinstance(c, str)
                else [p["text"] for p in c if isinstance(p, dict) and isinstance(p.get("text"), str)]
                if isinstance(c, list) else []
            )
            for t in parts:
                if len(t) >= min_chars and _CJK_RUN.search(t):  # CJK-bearing only
                    out.append(anon(t))
            if len(out) >= limit:
                break
    return out[:limit]


def eval_transcript(jsonl_path: str, ratio: float = 0.4, min_chars: int = 600, limit: int = 40) -> None:
    blocks = _block_texts(jsonl_path, min_chars, limit)
    if not blocks:
        print(f"\n=== Part B: no CJK blocks >= {min_chars} chars in {os.path.basename(jsonl_path)} ===")
        return
    tc = TextCrusher()
    ratios, times, retentions = [], [], []
    for b in blocks:
        sal_before = salient_set(b)
        t0 = time.perf_counter()
        out = tc.compress(b, target_ratio=ratio).compressed
        times.append((time.perf_counter() - t0) * 1000)
        retentions.append(len(sal_before & salient_set(out)) / max(1, len(sal_before)))
        ratios.append(len(out) / max(1, len(b)))
    n = len(blocks)
    print(f"\n=== Part B: real CJK transcript fidelity (n={n}, anonymized, target_ratio={ratio}) ===")
    print(f"  mean char-ratio kept:     {sum(ratios) / n:.2f}")
    print(f"  mean speed:               {sum(times) / n:.1f} ms/block")
    print(f"  CJK-aware salient retention: {sum(retentions) / n:.1%}")
```

- [ ] **Step 2: Smoke-run against the local transcript (if present)**

Run: `.venv/bin/python -c "import benchmarks.i18n_compression_eval as e, glob, os; f=max(glob.glob(os.path.expanduser('~/.claude/projects/*headroom*/*.jsonl')), key=os.path.getsize); e.eval_transcript(f)"`
Expected: prints Part B metrics (or the "no CJK blocks" skip line). Never echoes raw content.

- [ ] **Step 3: Commit**

```bash
git add benchmarks/i18n_compression_eval.py
git commit -m "test(benchmarks): real CJK transcript fidelity with CJK-aware salient"
```

---

### Task 4: Part A — optional `multi-wiki-qa` natural-data retention (VERIFY schema first)

**Files:**
- Modify: `benchmarks/i18n_compression_eval.py`

**Interfaces:**
- Produces: `eval_multiwiki(langs=("zh-cn","ja","ko"), n=150, n_distract=20, ratio=0.3, seed=0) -> None`.

- [ ] **Step 1: VERIFY the dataset schema before coding against it (evidence, not secondhand)**

Run:
```bash
.venv/bin/python - <<'PY'
try:
    from datasets import load_dataset
except ImportError:
    print("datasets not installed; install headroom-ai[evals] to verify"); raise SystemExit
ds = load_dataset("alexandrainst/multi-wiki-qa", "ja", split="train", streaming=True)
row = next(iter(ds))
print("keys:", list(row.keys()))
ctx, ans = row.get("context",""), row.get("answers") or row.get("answer")
print("answer:", ans)
print("answer-is-verbatim-substring:", (ans if isinstance(ans,str) else (ans or [""])[0]) in ctx)
PY
```
Expected: prints the field names and `answer-is-verbatim-substring: True`. **If the schema differs (field names / answer not a substring), adjust the accessor in Step 2 accordingly — do not assume.**

- [ ] **Step 2: Implement the guarded loader + retention (mirror eval_squad)**

```python
def eval_multiwiki(langs=("zh-cn", "ja", "ko"), n=150, n_distract=20, ratio=0.3, seed=0) -> None:
    try:
        from datasets import load_dataset
    except ImportError:
        print("\n=== Part A: HuggingFace `datasets` not installed; skipping (pip install headroom-ai[evals]) ===")
        return
    tc = TextCrusher()
    print(f"\n=== Part A: multi-wiki-qa answer-retention (n={n}/lang, distractors={n_distract}, ratio={ratio}) ===")
    for lang in langs:
        try:
            ds = list(load_dataset("alexandrainst/multi-wiki-qa", lang, split=f"train[:{n * 3}]"))
        except Exception as e:  # noqa: BLE001 — optional path, fail-open
            print(f"  {lang}: load failed ({e}); skipping")
            continue
        # NOTE: field accessors confirmed in Step 1; adjust if schema differs.
        ex = [(r["context"], r["question"], (r["answers"][0] if isinstance(r.get("answers"), list) else r.get("answer", "")))
              for r in ds if r.get("context")]
        rnd = random.Random(seed)
        rnd.shuffle(ex)
        ex = ex[:n]
        all_ctx = [c for c, _, _ in ex]
        hit = {"text_crusher": 0, "truncate": 0, "random": 0}
        for gold, q, ans in ex:
            docs = rnd.sample(all_ctx, min(n_distract, len(all_ctx))) + [gold]
            rnd.shuffle(docs)
            hay = "\n\n".join(docs)
            a = norm(ans)
            if not a:
                continue
            hit["text_crusher"] += a in norm(tc.compress(hay, context=q, target_ratio=ratio).compressed)
            hit["truncate"] += a in norm(truncate_keep_last(hay, ratio))
            hit["random"] += a in norm(random_keep(hay, ratio, seed))
        m = max(1, len(ex))
        print(f"  {lang}: text_crusher {hit['text_crusher']/m:.0%}  truncate {hit['truncate']/m:.0%}  random {hit['random']/m:.0%}")
```

- [ ] **Step 3: Commit**

```bash
git add benchmarks/i18n_compression_eval.py
git commit -m "test(benchmarks): optional multi-wiki-qa zh/ja/ko natural-data retention"
```

---

### Task 5: Wire `__main__`, run end-to-end, open PR #6

**Files:**
- Modify: `benchmarks/i18n_compression_eval.py`

- [ ] **Step 1: Add the `__main__` block (Part C always; B/A optional)**

```python
if __name__ == "__main__":
    eval_synthetic()  # always runs, no external data
    tx = sys.argv[1] if len(sys.argv) > 1 else None
    if tx is None:
        found = glob.glob(os.path.expanduser("~/.claude/projects/*headroom*/*.jsonl"))
        tx = max(found, key=os.path.getsize) if found else None
    if tx and os.path.exists(tx):
        eval_transcript(tx)
    else:
        print("\nno transcript jsonl found; skipping Part B")
    eval_multiwiki()  # self-skips if datasets/data absent
```

- [ ] **Step 2: Full run + lint + the CI gate**

```bash
.venv/bin/python benchmarks/i18n_compression_eval.py
.venv/bin/python -m ruff check benchmarks/i18n_compression_eval.py tests/test_transforms/test_text_crusher_cjk_eval.py
.venv/bin/python -m ruff format --check benchmarks/i18n_compression_eval.py
.venv/bin/python -m pytest tests/test_transforms/test_text_crusher_cjk_eval.py -q
```
Expected: Part C prints True for text_crusher across zh/ja/ko; ruff clean; 6 tests pass.

- [ ] **Step 3: Commit, push, open PR #6**

```bash
git add benchmarks/i18n_compression_eval.py
git commit -m "test(benchmarks): wire i18n eval entrypoint (Part C always; B/A optional)"
git push -u origin feat/i18n-compression-eval
gh pr create --repo headroomlabs-ai/headroom --base main --head lifeodyssey:feat/i18n-compression-eval \
  --title "test(benchmarks): i18n (zh/ja/ko) compression answer-retention eval" \
  --body-file /tmp/pr6_body.md
```
PR body must follow the template (Real Behavior Proof = the Part C run output; note the multi-wiki-qa NC license + that data is never vendored; reference #1504). Keep the `- Observed result:` field non-empty (governance parser requirement).

---

# PR #7 — `fix(evals): CJK-aware tokenization (metrics.py) + token estimate (core.py)`

Independent of #6. Fixes two verified CJK bugs so the `evals/` framework reports correct numbers for non-English text.

### Task 6: CJK-aware `tokenize()` in metrics.py

**Files:**
- Modify: `headroom/evals/metrics.py:25`
- Create/extend: `tests/test_evals_metrics.py`

- [ ] **Step 1: Write the failing test**

```python
from headroom.evals.metrics import tokenize, compute_f1

def test_tokenize_splits_cjk_into_units():
    toks = tokenize("数据库连接失败")
    assert len(toks) >= 3, f"CJK must split into multiple units, got {toks}"

def test_f1_partial_credit_on_cjk():
    # overlapping-but-not-identical CJK answers should score strictly between 0 and 1
    f1 = compute_f1("数据库连接失败", "数据库连接成功")
    assert 0.0 < f1 < 1.0
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_evals_metrics.py -q -k cjk`
Expected: FAIL (current `\b\w+\b` returns `["数据库连接失败"]`, len 1; F1 is 0.0 not partial).

- [ ] **Step 3: Implement CJK-aware tokenize (deterministic, no new dep)**

```python
# headroom/evals/metrics.py — replace the body of tokenize()
_CJK = re.compile(r"[㐀-鿿぀-ヿ가-힯]")

def tokenize(text: str) -> list[str]:
    out: list[str] = []
    for tok in re.findall(r"\b\w+\b", text.lower()):
        if _CJK.search(tok):
            # split CJK runs into overlapping char bigrams (unigram if len 1)
            cjk = [c for c in tok if _CJK.match(c)]
            out.extend(["".join(cjk[i:i+2]) for i in range(max(1, len(cjk)-1))] if len(cjk) > 1 else cjk)
        else:
            out.append(tok)
    return out
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_evals_metrics.py -q`
Expected: PASS. Also run the existing metrics tests to confirm ASCII F1 unchanged: `.venv/bin/python -m pytest tests/test_evals_metrics.py -q` (full file).

- [ ] **Step 5: Commit**

```bash
git add headroom/evals/metrics.py tests/test_evals_metrics.py
git commit -m "fix(evals): CJK-aware F1 tokenization"
```

### Task 7: CJK-aware `_estimate_tokens` in core.py

**Files:**
- Modify: `headroom/evals/core.py:264`

- [ ] **Step 1: Write the failing test** (append to `tests/test_evals_metrics.py` or a core test)

```python
from headroom.evals.core import CompressionEvaluator
def test_estimate_tokens_cjk_not_underestimated():
    est = CompressionEvaluator._estimate_tokens.__func__  # unbound
    # 20 CJK chars: //4 gives 5; CJK-aware should be >= ~13
    assert est(None, "数" * 20) >= 13
```

- [ ] **Step 2: Run to verify it fails** — `pytest -q -k estimate_tokens` → FAIL (`len//4` = 5).

- [ ] **Step 3: Implement** (count CJK chars ~1.5 tokens, others //4)

```python
# headroom/evals/core.py
def _estimate_tokens(self, text: str) -> int:
    cjk = sum(1 for c in text if "㐀" <= c <= "鿿" or "぀" <= c <= "ヿ" or "가" <= c <= "힯")
    return int(cjk * 1.5) + (len(text) - cjk) // 4
```

- [ ] **Step 4: Run to verify it passes**, then **Step 5: Commit + push + open PR #7** (one squash commit; PR body: cite the two file:line bugs + Real Behavior Proof = the before/after estimate).

---

# PR #8 — `feat(evals): register multilingual QA dataset (multi-wiki-qa)`

Depends on #7 (so framework F1 is CJK-correct). Makes zh/ja/ko first-class in `BeforeAfterRunner` via the registry.

### Task 8: `load_multi_wiki_qa` + registry entry

**Files:**
- Modify: `headroom/evals/datasets.py` (add loader near `load_longbench`; add registry entry in `DATASET_REGISTRY`)
- Extend: `tests/test_evals_datasets.py`

- [ ] **Step 1: Write the failing test** (mirror the existing guard test)

```python
def test_multi_wiki_qa_registered():
    from headroom.evals.datasets import DATASET_REGISTRY
    assert "multi_wiki_qa" in DATASET_REGISTRY
    assert DATASET_REGISTRY["multi_wiki_qa"]["category"] == "rag_multilingual"
```

- [ ] **Step 2: Run to verify it fails** — FAIL (KeyError).

- [ ] **Step 3: Implement the loader (guarded) + registry entry**

```python
def load_multi_wiki_qa(n: int = 100, lang: str = "ja") -> EvalSuite:
    """Multilingual SQuAD-style QA with guaranteed verbatim-span answers
    (alexandrainst/multi-wiki-qa). Covers zh-cn/ja/ko. CC-BY-NC-SA-4.0."""
    _check_datasets_installed()
    from datasets import load_dataset
    try:
        ds = load_dataset("alexandrainst/multi-wiki-qa", lang, split=f"train[:{n}]")
    except Exception as e:
        raise ValueError(f"Failed to load multi-wiki-qa '{lang}': {e}") from e
    cases: list[EvalCase] = []
    for i, item in enumerate(ds):
        ctx, q = item.get("context", ""), item.get("question", "")
        ans = item.get("answers") or item.get("answer")
        gt = ans[0] if isinstance(ans, list) and ans else (ans if isinstance(ans, str) else None)
        if not (ctx and q and gt):
            continue
        cases.append(EvalCase(id=f"mwq_{lang}_{i}", context=ctx, query=q, ground_truth=gt,
                              metadata={"source": "multi-wiki-qa", "lang": lang}))
    return EvalSuite(name=f"multi_wiki_qa_{lang}", cases=cases)

# in DATASET_REGISTRY:
"multi_wiki_qa": {"loader": load_multi_wiki_qa, "description": "Multilingual (zh/ja/ko) verbatim-span QA", "category": "rag_multilingual", "default_n": 100},
```

- [ ] **Step 4: Run to verify it passes** (`pytest tests/test_evals_datasets.py -q`), **Step 5: Commit + push + open PR #8** (PR body: cite the field accessors verified in PR #6 Task 4 Step 1; note NC license; reference the new `rag_multilingual` category).

---

# PR #1504 update — Real Behavior Proof refresh

### Task 9: Point #1504's proof at the committed eval

- [ ] **Step 1:** After PR #6 merges, edit the `/tmp/pr_body.md`-equivalent for #1504: in `Real Behavior Proof`, replace the ad-hoc CMRC line with: "Reproducible eval committed in `benchmarks/i18n_compression_eval.py` (Part C, deterministic, runs in CI via `tests/test_transforms/test_text_crusher_cjk_eval.py`); zh/ja/ko needles survive compression while truncate/random drop them." Keep `- Observed result:` non-empty.
- [ ] **Step 2:** `gh pr edit 1504 --repo headroomlabs-ai/headroom --body-file /tmp/pr1504_body.md`
- [ ] **Step 3:** Confirm the `template` governance check re-passes (`gh pr checks 1504`).

---

## Self-Review

**Spec coverage:** Part C (Task 2) ✓, Part B CJK-salient (Task 3) ✓, Part A multi-wiki-qa optional+guarded (Task 4) ✓, license handling = Part C always-runs / NC data load-or-skip (Tasks 4–5, Global Constraints) ✓, metrics.py + core.py bugs (Tasks 6–7) ✓, DATASET_REGISTRY registration (Task 8) ✓, #1504 proof update (Task 9) ✓, #1504 dependency (Global Constraints + Task 1) ✓.

**Placeholder scan:** No "TBD/TODO"; every code step has complete code. Task 4 Step 1 is an explicit *verification* step (not a placeholder) — schema is confirmed at run time before the accessor in Step 2 is trusted, satisfying the "evidence, not secondhand" constraint.

**Type consistency:** `retention_synthetic` returns `dict[str, bool]` and is consumed identically in the test and `eval_synthetic`. `salient_set`/`tokenize`/`_estimate_tokens` signatures match their call sites. `EvalCase(id, context, query, ground_truth, metadata)` matches the verified dataclass (`core.py:30-46`).

**Known risk to watch during execution:** if `multi-wiki-qa` field names differ from `context`/`question`/`answers`, Task 4 Step 1 catches it before Step 2 — adjust accessors there and mirror into Task 8.
