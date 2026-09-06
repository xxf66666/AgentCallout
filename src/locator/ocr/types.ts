/** OCR engine coordinates before the locator maps an optional source region. */
export interface OcrBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrEngineSymbol {
  text: string;
  confidence: number;
  bbox: OcrBounds;
}

export interface OcrEngineWord {
  text: string;
  confidence: number;
  bbox: OcrBounds;
  symbols?: OcrEngineSymbol[];
}

export interface OcrEngineLine {
  text: string;
  words: OcrEngineWord[];
}

export interface OcrEngineDocument {
  engineVersion: string;
  lines: OcrEngineLine[];
}

export interface OcrMatchOptions {
  mode: "exact" | "contains";
  caseSensitive: boolean;
  minimumConfidence: number;
  maxCandidates: number;
}

export interface OcrTextCandidate {
  id: string;
  text: string;
  normalizedText: string;
  bbox: OcrBounds;
  confidence: number;
  precision: "symbol" | "word";
  evidence: {
    lineIndex: number;
    wordIndexes: number[];
    symbolIndexes?: { wordIndex: number; symbolIndex: number }[];
  };
}

export interface OcrMatchResult {
  status: "not-found" | "unique" | "ambiguous" | "low-confidence";
  normalizedQuery: string;
  requiresConfirmation: boolean;
  confirmationReasons: ("multiple-candidates" | "low-confidence")[];
  candidates: OcrTextCandidate[];
  totalCandidates: number;
  truncated: boolean;
}
