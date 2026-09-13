import { describe, expect, it } from "vitest";

import { matchOcrText } from "../src/locator/ocr/matching.js";
import type {
  OcrBounds,
  OcrEngineDocument,
  OcrEngineLine,
  OcrEngineSymbol,
  OcrEngineWord
} from "../src/locator/ocr/types.js";

function bbox(x0: number, y0 = 10, width = 10, height = 12): OcrBounds {
  return { x0, y0, x1: x0 + width, y1: y0 + height };
}

function symbols(text: string, x0: number, confidence = 99): OcrEngineSymbol[] {
  return [...text].map((character, index) => ({
    text: character,
    confidence,
    bbox: bbox(x0 + index * 10, 10, 10, 12)
  }));
}

function word(
  text: string,
  x0: number,
  confidence = 95,
  wordSymbols?: OcrEngineSymbol[]
): OcrEngineWord {
  return {
    text,
    confidence,
    bbox: bbox(x0, 10, Math.max(10, [...text].length * 10), 12),
    ...(wordSymbols === undefined ? {} : { symbols: wordSymbols })
  };
}

function line(
  words: OcrEngineWord[],
  text = words.map((item) => item.text).join(" ")
): OcrEngineLine {
  return { text, words };
}

function document(lines: OcrEngineLine[]): OcrEngineDocument {
  return { engineVersion: "test-engine-1.0", lines };
}

describe("OCR text matching", () => {
  it("defaults to case-insensitive exact matching after NFKC normalization", () => {
    const input = document([
      line([word("ＳＡＶＥ", 10, 93, symbols("ＳＡＶＥ", 10))], "fullwidth transcript")
    ]);

    const result = matchOcrText(input, "save");

    expect(result).toMatchObject({
      status: "unique",
      normalizedQuery: "save",
      requiresConfirmation: false,
      confirmationReasons: [],
      totalCandidates: 1,
      truncated: false
    });
    expect(result.candidates).toEqual([
      expect.objectContaining({
        text: "ＳＡＶＥ",
        normalizedText: "save",
        confidence: 93,
        precision: "word",
        bbox: bbox(10, 10, 40, 12),
        evidence: { lineIndex: 0, wordIndexes: [0] }
      })
    ]);
    expect(matchOcrText(input, "save", { caseSensitive: true }).status).toBe("not-found");
  });

  it("removes OCR whitespace only between adjacent CJK characters", () => {
    const input = document([
      line([word("校", 10), word("验", 20), word("失", 30), word("败", 40)]),
      line([word("New", 10), word("York", 50)]),
      line([word("スー", 10), word("パー", 40)])
    ]);

    const chinese = matchOcrText(input, "校 验\t失败");
    expect(chinese.status).toBe("unique");
    expect(chinese.normalizedQuery).toBe("校验失败");
    expect(chinese.candidates[0]).toMatchObject({
      normalizedText: "校验失败",
      bbox: { x0: 10, y0: 10, x1: 50, y1: 22 },
      evidence: { lineIndex: 0, wordIndexes: [0, 1, 2, 3] }
    });

    expect(matchOcrText(input, "New York").status).toBe("unique");
    expect(matchOcrText(input, "NewYork").status).toBe("not-found");
    expect(matchOcrText(input, "スーパー").status).toBe("unique");
  });

  it("never joins an exact phrase across different OCR lines", () => {
    const input = document([line([word("New", 10)]), line([word("York", 10)])]);

    expect(matchOcrText(input, "New York")).toEqual({
      status: "not-found",
      normalizedQuery: "new york",
      requiresConfirmation: false,
      confirmationReasons: [],
      candidates: [],
      totalCandidates: 0,
      truncated: false
    });
  });

  it("requires exact matches to end on word boundaries while contains may use a substring", () => {
    const recognized = word("保存失败", 100, 91, symbols("保存失败", 100));
    const input = document([line([recognized])]);

    expect(matchOcrText(input, "保存").status).toBe("not-found");
    expect(matchOcrText(input, "失败").status).toBe("not-found");
    expect(matchOcrText(input, "保存失败").candidates[0]).toMatchObject({
      precision: "word",
      bbox: bbox(100, 10, 40, 12),
      evidence: { lineIndex: 0, wordIndexes: [0] }
    });
    expect(matchOcrText(input, "保存", { mode: "contains" }).candidates[0]).toMatchObject({
      normalizedText: "保存",
      precision: "symbol",
      bbox: bbox(100, 10, 20, 12),
      confidence: 91,
      evidence: {
        lineIndex: 0,
        wordIndexes: [0],
        symbolIndexes: [
          { wordIndex: 0, symbolIndex: 0 },
          { wordIndex: 0, symbolIndex: 1 }
        ]
      }
    });
  });

  it("falls back explicitly to word precision when symbol evidence is unavailable or inconsistent", () => {
    const unavailable = matchOcrText(document([line([word("Save", 10, 88)])]), "av", {
      mode: "contains"
    });
    const inconsistent = matchOcrText(
      document([
        line([
          word("Save", 10, 88, [
            { text: "X", confidence: 99, bbox: bbox(10) },
            { text: "Y", confidence: 99, bbox: bbox(20) }
          ])
        ])
      ]),
      "av",
      { mode: "contains" }
    );
    const spatiallyInconsistent = matchOcrText(
      document([
        line([
          word("Save", 10, 88, [
            { text: "S", confidence: 99, bbox: bbox(500) },
            { text: "a", confidence: 99, bbox: bbox(510) },
            { text: "v", confidence: 99, bbox: bbox(520) },
            { text: "e", confidence: 99, bbox: bbox(530) }
          ])
        ])
      ]),
      "av",
      { mode: "contains" }
    );

    for (const result of [unavailable, inconsistent, spatiallyInconsistent]) {
      expect(result.candidates[0]).toMatchObject({
        precision: "word",
        bbox: bbox(10, 10, 40, 12),
        evidence: { lineIndex: 0, wordIndexes: [0] }
      });
      expect(result.candidates[0]?.evidence).not.toHaveProperty("symbolIndexes");
    }
  });

  it("uses the minimum supporting word confidence and treats the threshold as a heuristic", () => {
    const input = document([line([word("校验", 10, 96), word("失败", 40, 79)])]);

    const defaultResult = matchOcrText(input, "校验失败");
    expect(defaultResult).toMatchObject({
      status: "low-confidence",
      requiresConfirmation: true,
      confirmationReasons: ["low-confidence"]
    });
    expect(defaultResult.candidates[0]?.confidence).toBe(79);

    const acceptedByConfiguredHeuristic = matchOcrText(input, "校验失败", {
      minimumConfidence: 79
    });
    expect(acceptedByConfiguredHeuristic.status).toBe("unique");
    expect(acceptedByConfiguredHeuristic.requiresConfirmation).toBe(false);
    expect(acceptedByConfiguredHeuristic.candidates[0]?.confidence).toBe(79);
  });

  it("preserves repeated candidates in document order with stable unique IDs", () => {
    const input = document([
      line([word("Save", 10, 90)]),
      line([word("SAVE", 200, 99)]),
      line([word("save", 400, 70)])
    ]);

    const first = matchOcrText(input, "save");
    const second = matchOcrText(input, "save");

    expect(first.status).toBe("ambiguous");
    expect(first.requiresConfirmation).toBe(true);
    expect(first.confirmationReasons).toEqual(["multiple-candidates", "low-confidence"]);
    expect(first.totalCandidates).toBe(3);
    expect(first.truncated).toBe(false);
    expect(first.candidates.map((candidate) => candidate.confidence)).toEqual([90, 99, 70]);
    expect(first.candidates.map((candidate) => candidate.evidence.lineIndex)).toEqual([0, 1, 2]);
    expect(new Set(first.candidates.map((candidate) => candidate.id)).size).toBe(3);
    expect(second.candidates.map((candidate) => candidate.id)).toEqual(
      first.candidates.map((candidate) => candidate.id)
    );
  });

  it("counts hidden candidates honestly and does not turn truncation into a unique result", () => {
    const input = document([
      line([word("Save", 10, 90)]),
      line([word("Save", 200, 99)]),
      line([word("Save", 400, 70)])
    ]);

    const result = matchOcrText(input, "save", { maxCandidates: 2 });

    expect(result).toMatchObject({
      status: "ambiguous",
      requiresConfirmation: true,
      confirmationReasons: ["multiple-candidates", "low-confidence"],
      totalCandidates: 3,
      truncated: true
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.confidence)).toEqual([90, 99]);
  });

  it("keeps overlapping contains occurrences distinct with symbol-level boxes", () => {
    const input = document([line([word("aaaa", 10, 95, symbols("aaaa", 10))])]);

    const result = matchOcrText(input, "aa", { mode: "contains" });

    expect(result.totalCandidates).toBe(3);
    expect(result.candidates.map((candidate) => candidate.bbox)).toEqual([
      bbox(10, 10, 20, 12),
      bbox(20, 10, 20, 12),
      bbox(30, 10, 20, 12)
    ]);
    expect(new Set(result.candidates.map((candidate) => candidate.id)).size).toBe(3);
  });

  it("deduplicates NFKC-expanded matches that have identical physical evidence", () => {
    const ligature = word("ﬃ", 10, 94, [{ text: "ﬃ", confidence: 94, bbox: bbox(10) }]);

    const result = matchOcrText(document([line([ligature])]), "f", { mode: "contains" });

    expect(result).toMatchObject({
      status: "unique",
      requiresConfirmation: false,
      totalCandidates: 1,
      truncated: false
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      text: "ﬃ",
      normalizedText: "f",
      precision: "symbol",
      bbox: bbox(10)
    });
  });

  it("returns an explicit not-found state rather than an empty successful selection", () => {
    const result = matchOcrText(document([line([word("Save", 10)])]), "不存在");

    expect(result).toEqual({
      status: "not-found",
      normalizedQuery: "不存在",
      requiresConfirmation: false,
      confirmationReasons: [],
      candidates: [],
      totalCandidates: 0,
      truncated: false
    });
  });

  it("returns only local matching evidence rather than the complete OCR transcript", () => {
    const recognized = "SECRETSavePRIVATE";
    const input = document([
      line(
        [word(recognized, 100, 95, symbols(recognized, 100))],
        "SECRET BEFORE Save PRIVATE AFTER"
      )
    ]);

    const result = matchOcrText(input, "save", { mode: "contains" });
    const serialized = JSON.stringify(result);

    expect(result.candidates[0]?.text).toBe("Save");
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("PRIVATE");
    expect(serialized).not.toContain("test-engine-1.0");
  });

  it("rejects malformed word confidence and finite bounding-box data", () => {
    for (const confidence of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        matchOcrText(document([line([{ ...word("Save", 10), confidence }])]), "save")
      ).toThrow(/confidence.*finite number from 0 to 100/u);
    }
    for (const invalidBounds of [
      { x0: 0, y0: 0, x1: Number.POSITIVE_INFINITY, y1: 10 },
      { x0: -1, y0: 0, x1: 10, y1: 10 },
      { x0: 10, y0: 0, x1: 10, y1: 10 },
      { x0: 0, y0: 20, x1: 10, y1: 10 }
    ]) {
      expect(() =>
        matchOcrText(document([line([{ ...word("Save", 10), bbox: invalidBounds }])]), "save")
      ).toThrow(/bbox/u);
    }
    expect(() =>
      matchOcrText(
        document([
          line([
            word("S", 10, 90, [
              { text: "S", confidence: 90, bbox: { x0: 10, y0: 10, x1: 9, y1: 11 } }
            ])
          ])
        ]),
        "s",
        { mode: "contains" }
      )
    ).toThrow(/symbols\[0\]\.bbox.*reversed/u);
    expect(() => matchOcrText(document([]), "\ud83d")).toThrow(/well-formed UTF-16/u);
    expect(() => matchOcrText(document([line([word("\udc00", 10)])]), "x")).toThrow(
      /well-formed UTF-16/u
    );
  });

  it("ignores empty symbol noise and falls back to word precision for finite zero-area symbols", () => {
    const validSymbols = symbols("Save", 10);
    const withEmptyNoise = matchOcrText(
      document([
        line([
          word("Save", 10, 90, [
            {
              text: " ",
              confidence: Number.NaN,
              bbox: { x0: Number.NaN, y0: 0, x1: 0, y1: 0 }
            },
            ...validSymbols
          ])
        ])
      ]),
      "av",
      { mode: "contains" }
    );
    expect(withEmptyNoise.candidates[0]).toMatchObject({
      precision: "symbol",
      bbox: bbox(20, 10, 20, 12)
    });

    const withZeroAreaCharacter = matchOcrText(
      document([
        line([
          word("Save", 10, 90, [
            { ...validSymbols[0]!, bbox: { x0: 10, y0: 10, x1: 10, y1: 22 } },
            ...validSymbols.slice(1)
          ])
        ])
      ]),
      "av",
      { mode: "contains" }
    );
    expect(withZeroAreaCharacter.candidates[0]).toMatchObject({
      precision: "word",
      bbox: bbox(10, 10, 40, 12)
    });
  });

  it("enforces query, document, and candidate budgets before unbounded work", () => {
    const emptyLine = { text: "", words: [] } satisfies OcrEngineLine;
    const repeatedWord = word("x", 0);
    const repeatedSymbol = { text: "x", confidence: 90, bbox: bbox(0) } satisfies OcrEngineSymbol;

    expect(() => matchOcrText(document([]), "x".repeat(513))).toThrow(/query exceeds 512/u);
    expect(() =>
      matchOcrText({ engineVersion: "v", lines: Array<OcrEngineLine>(10_001).fill(emptyLine) }, "x")
    ).toThrow(/exceeds 10000 lines/u);
    expect(() => matchOcrText({ engineVersion: "v".repeat(257), lines: [] }, "x")).toThrow(
      /engineVersion.*exceeds 256/u
    );
    expect(() => matchOcrText(document([{ text: "x".repeat(65_537), words: [] }]), "x")).toThrow(
      /text.*exceeds 65536/u
    );
    expect(() =>
      matchOcrText(
        document([{ text: "x", words: Array<OcrEngineWord>(25_001).fill(repeatedWord) }]),
        "x"
      )
    ).toThrow(/exceeds 25000 words/u);
    expect(() =>
      matchOcrText(
        document([
          line([
            {
              ...repeatedWord,
              symbols: Array<OcrEngineSymbol>(250_001).fill(repeatedSymbol)
            }
          ])
        ]),
        "x"
      )
    ).toThrow(/exceeds 250000 symbols/u);
    expect(() =>
      matchOcrText(
        document(Array.from({ length: 31 }, () => ({ text: "x".repeat(65_536), words: [] }))),
        "x"
      )
    ).toThrow(/exceeds 2000000 total/u);
    expect(() => matchOcrText(document([line([word("x".repeat(4_097), 0)])]), "x")).toThrow(
      /words\[0\]\.text.*exceeds 4096/u
    );
    expect(() =>
      matchOcrText(
        document([line([word("x", 0, 90, [{ ...repeatedSymbol, text: "x".repeat(257) }])])]),
        "x"
      )
    ).toThrow(/symbols\[0\]\.text.*exceeds 256/u);
    expect(() =>
      matchOcrText(
        document([
          line(
            Array.from({ length: 28 }, () => word("\ufdfa".repeat(4_096), 0)),
            ""
          )
        ]),
        "x"
      )
    ).toThrow(/Normalized OCR word text exceeds 2000000/u);
    for (const maxCandidates of [0, 1.5, 101]) {
      expect(() => matchOcrText(document([]), "x", { maxCandidates })).toThrow(
        /maxCandidates.*1 to 100/u
      );
    }
    expect(() => matchOcrText(document([]), "x", { unexpected: true } as never)).toThrow(
      /Unknown OCR match option/u
    );
  });
});
