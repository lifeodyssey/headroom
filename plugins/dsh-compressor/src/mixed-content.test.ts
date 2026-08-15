import { describe, expect, it } from "vitest";

import {
  extractJsonBlock,
  isMixedContent,
  splitIntoSections,
} from "./mixed-content.js";

describe("official mixed-content sectioning", () => {
  it("requires multiple signals to classify mixed content", () => {
    const prose = [
      "First sentence has enough words to count.",
      "Second sentence has enough words to count.",
      "Third sentence has enough words to count.",
      "Fourth sentence has enough words to count.",
      "Fifth sentence has enough words to count.",
      "Sixth sentence has enough words to count.",
    ].join("\n");

    expect(isMixedContent(prose)).toBe(false);
    expect(isMixedContent(`${prose}\n\`\`\`python\nprint('x')\n\`\`\``)).toBe(
      true,
    );
  });

  it("preserves typed boundaries when splitting sections", () => {
    const content = [
      "Intro text",
      "```python",
      "print('x')",
      "```",
      '[{"id": 1}]',
      "src/app.py:10:print('x')",
    ].join("\n");

    const sections = splitIntoSections(content);

    expect(sections.map((section) => section.contentType)).toEqual([
      "text",
      "source_code",
      "json_array",
      "search",
    ]);
    expect(sections[1]?.language).toBe("python");
    expect(sections[1]?.content).toBe("print('x')");
    expect(sections[1]?.isCodeFence).toBe(true);
    expect(sections[2]?.content).toBe('[{"id": 1}]');
    expect(sections[3]?.startLine).toBe(5);
  });

  it("extracts a JSON block without treating string delimiters as structure", () => {
    const lines = [
      "[",
      '  {"path": "a]b", "message": "keep {literal} braces"},',
      '  {"path": "c"}',
      "]",
    ];

    const [block, endLine] = extractJsonBlock(lines, 0);

    expect(endLine).toBe(3);
    expect(block).toBe(lines.join("\n"));
  });
});
