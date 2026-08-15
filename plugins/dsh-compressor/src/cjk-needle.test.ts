import { describe, expect, it } from "vitest";

import { crushText, nativeAvailable } from "./native.js";

const NEEDLES = {
  zh: {
    query: "认证令牌缓存淘汰策略",
    key: "最近最少使用淘汰",
    needle: "认证令牌的缓存采用最近最少使用淘汰算法来管理过期条目。",
    distractor: (i: number) =>
      `第${i}号监控服务器的日志显示子系统${i}今天运行平稳没有出现异常。`,
  },
  ja: {
    query: "認証トークン キャッシュ 破棄 アルゴリズム",
    key: "最長未使用",
    needle: "認証トークンのキャッシュは最長未使用アルゴリズムで管理される。",
    distractor: (i: number) =>
      `${i}番目の監視サーバーのログには${i}番のサブシステムが本日も正常に稼働したと記録されている。`,
  },
  ko: {
    query: "인증 토큰 캐시 제거 알고리즘",
    key: "최근 최소 사용",
    needle: "인증 토큰 캐시는 최근 최소 사용 알고리즘으로 관리된다.",
    distractor: (i: number) =>
      `${i}번 모니터링 서버의 로그에는 ${i}번 하위 시스템이 오늘도 정상 작동했다고 기록되어 있다.`,
  },
} as const;

type Lang = keyof typeof NEEDLES;

function haystack(lang: Lang, nDistract = 24): string {
  const spec = NEEDLES[lang];
  const half = Math.floor(nDistract / 2);
  const before = Array.from({ length: half }, (_, i) => spec.distractor(i));
  const after = Array.from({ length: nDistract - half }, (_, i) =>
    spec.distractor(i + half),
  );
  return [...before, spec.needle, ...after].join("");
}

function splitSegs(text: string): string[] {
  return text.split(/(?<=[.!?。！？])\s*|\n+/).filter((part) => part.trim().length > 0);
}

function norm(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

function truncateKeepLast(text: string, ratio: number): string {
  const segs = splitSegs(text);
  const budget = Math.floor(segs.reduce((sum, seg) => sum + seg.length, 0) * ratio);
  const kept: string[] = [];
  let used = 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (used >= budget) {
      break;
    }
    kept.push(segs[i]!);
    used += segs[i]!.length;
  }
  return kept.reverse().join("");
}

function randomKeep(text: string, ratio: number, seed: number): string {
  const segs = splitSegs(text);
  const idx = segs.map((_, i) => i);
  let state = seed;
  for (let i = idx.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    const tmp = idx[i]!;
    idx[i] = idx[j]!;
    idx[j] = tmp;
  }
  const budget = Math.floor(segs.reduce((sum, seg) => sum + seg.length, 0) * ratio);
  const kept = new Set<number>();
  let used = 0;
  for (const i of idx) {
    if (used >= budget) {
      break;
    }
    kept.add(i);
    used += segs[i]!.length;
  }
  return segs.filter((_, i) => kept.has(i)).join("");
}

function retention(lang: Lang, ratio = 0.3): {
  textCrusher: boolean;
  truncate: boolean;
  random: boolean;
} {
  const spec = NEEDLES[lang];
  const hay = haystack(lang);
  const key = norm(spec.key);
  const crushed = crushText(hay, spec.query, ratio).compressed;
  return {
    textCrusher: norm(crushed).includes(key),
    truncate: norm(truncateKeepLast(hay, ratio)).includes(key),
    random: norm(randomKeep(hay, ratio, 0)).includes(key),
  };
}

describe("CJK needle retention (official i18n eval Part C)", () => {
  it("requires the native TextCrusher", () => {
    expect(nativeAvailable()).toBe(true);
  });

  for (const lang of ["zh", "ja", "ko"] as const) {
    it(`keeps the ${lang} query needle and beats truncate/random`, () => {
      const result = retention(lang);
      expect(result.textCrusher, `${lang}: TextCrusher dropped the needle`).toBe(
        true,
      );
      expect(
        Number(result.textCrusher),
        `${lang}: TextCrusher should beat or tie baselines`,
      ).toBeGreaterThanOrEqual(Math.max(Number(result.truncate), Number(result.random)));
    });
  }
});
