import type {
  OcrBounds,
  OcrEngineDocument,
  OcrMatchOptions,
  OcrMatchResult,
  OcrTextCandidate
} from "./types.js";

const DEFAULT_OPTIONS: Readonly<OcrMatchOptions> = Object.freeze({
  mode: "exact",
  caseSensitive: false,
  minimumConfidence: 80,
  maxCandidates: 100
});

const MAX_CANDIDATES = 100;
const MAX_QUERY_CODE_UNITS = 512;
const MAX_ENGINE_VERSION_CODE_UNITS = 256;
const MAX_LINES = 10_000;
const MAX_WORDS = 25_000;
const MAX_SYMBOLS = 250_000;
const MAX_TOTAL_TEXT_CODE_UNITS = 2_000_000;
const MAX_LINE_TEXT_CODE_UNITS = 65_536;
const MAX_WORD_TEXT_CODE_UNITS = 4_096;
const MAX_SYMBOL_TEXT_CODE_UNITS = 256;
const MAX_COORDINATE = 100_000_000;

// These caps keep validation and the linear matcher bounded even when an OCR
// adapter is fed hostile structure. Candidate output has a separate hard cap.

const CJK_CHARACTER =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
const CJK_INTERNAL_SPACE =
  /(?<=[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]) (?=[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}])/gu;

interface IndexedSymbol {
  symbolIndex: number;
  rawText: string;
  start: number;
  end: number;
  bbox: OcrBounds;
}

interface IndexedWord {
  wordIndex: number;
  rawText: string;
  normalizedText: string;
  confidence: number;
  bbox: OcrBounds;
  start: number;
  end: number;
  symbols?: IndexedSymbol[];
}

interface IndexedLine {
  lineIndex: number;
  normalizedText: string;
  characterOwners: number[];
  words: IndexedWord[];
  wordAtStart: Map<number, number>;
  wordAtEnd: Map<number, number>;
  confidenceIndex: RangeMinimumIndex;
}

interface RangeMinimumIndex {
  levels: Float64Array[];
}

interface SymbolEvidence {
  indexes: { wordIndex: number; symbolIndex: number }[];
  bounds: OcrBounds[];
  text: string;
}

interface MatchOccurrence {
  mode: OcrMatchOptions["mode"];
  line: IndexedLine;
  start: number;
  end: number;
  firstWordIndex: number;
  lastWordIndex: number;
  confidence: number;
}

interface ValidationBudget {
  words: number;
  symbols: number;
  textCodeUnits: number;
  normalizedTextCodeUnits: number;
  normalizedSymbolTextCodeUnits: number;
}

/**
 * Match a user query against already-produced OCR structure without selecting a
 * candidate. Confidence is an engine heuristic; it only controls confirmation.
 */
export function matchOcrText(
  document: OcrEngineDocument,
  query: string,
  options: Partial<OcrMatchOptions> = {}
): OcrMatchResult {
  const resolvedOptions = resolveOptions(options);
  const normalizedQuery = normalizeQuery(query, resolvedOptions.caseSensitive);
  const lines = validateAndIndexDocument(document, resolvedOptions.caseSensitive);
  const candidates: OcrTextCandidate[] = [];
  let previousCandidateId: string | undefined;
  let totalCandidates = 0;
  let hasLowConfidenceCandidate = false;

  for (const line of lines) {
    for (const occurrence of matchingOccurrences(line, normalizedQuery, resolvedOptions.mode)) {
      const candidateId = candidateIdentity(occurrence);
      if (candidateId === previousCandidateId) continue;
      previousCandidateId = candidateId;
      totalCandidates += 1;
      if (occurrence.confidence < resolvedOptions.minimumConfidence) {
        hasLowConfidenceCandidate = true;
      }
      if (candidates.length < resolvedOptions.maxCandidates) {
        candidates.push(toCandidate(occurrence, candidateId));
      }
    }
  }

  const multipleCandidates = totalCandidates > 1;
  const confirmationReasons: OcrMatchResult["confirmationReasons"] = [
    ...(multipleCandidates ? (["multiple-candidates"] as const) : []),
    ...(hasLowConfidenceCandidate ? (["low-confidence"] as const) : [])
  ];
  const status: OcrMatchResult["status"] =
    totalCandidates === 0
      ? "not-found"
      : multipleCandidates
        ? "ambiguous"
        : hasLowConfidenceCandidate
          ? "low-confidence"
          : "unique";
  return {
    status,
    normalizedQuery,
    requiresConfirmation: confirmationReasons.length > 0,
    confirmationReasons,
    candidates,
    totalCandidates,
    truncated: totalCandidates > candidates.length
  };
}

function resolveOptions(value: Partial<OcrMatchOptions>): OcrMatchOptions {
  if (!isRecord(value)) throw new TypeError("OCR match options must be an object.");
  const allowed = new Set(["mode", "caseSensitive", "minimumConfidence", "maxCandidates"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown OCR match option ${JSON.stringify(key)}.`);
  }
  const options: OcrMatchOptions = {
    mode: value.mode === undefined ? DEFAULT_OPTIONS.mode : value.mode,
    caseSensitive:
      value.caseSensitive === undefined ? DEFAULT_OPTIONS.caseSensitive : value.caseSensitive,
    minimumConfidence:
      value.minimumConfidence === undefined
        ? DEFAULT_OPTIONS.minimumConfidence
        : value.minimumConfidence,
    maxCandidates:
      value.maxCandidates === undefined ? DEFAULT_OPTIONS.maxCandidates : value.maxCandidates
  };
  if (options.mode !== "exact" && options.mode !== "contains") {
    throw new TypeError('OCR match mode must be "exact" or "contains".');
  }
  if (typeof options.caseSensitive !== "boolean") {
    throw new TypeError("OCR caseSensitive must be a boolean.");
  }
  validateConfidence(options.minimumConfidence, "minimumConfidence");
  if (
    !Number.isInteger(options.maxCandidates) ||
    options.maxCandidates < 1 ||
    options.maxCandidates > MAX_CANDIDATES
  ) {
    throw new RangeError(`OCR maxCandidates must be an integer from 1 to ${MAX_CANDIDATES}.`);
  }
  return options;
}

function normalizeQuery(value: unknown, caseSensitive: boolean): string {
  if (typeof value !== "string") throw new TypeError("OCR query must be a string.");
  if (value.length > MAX_QUERY_CODE_UNITS) {
    throw new RangeError(`OCR query exceeds ${MAX_QUERY_CODE_UNITS} UTF-16 code units.`);
  }
  if (!isWellFormedUtf16(value)) {
    throw new RangeError("OCR query must be well-formed UTF-16 text.");
  }
  const normalized = normalizeText(value, caseSensitive);
  if (normalized.length === 0) throw new RangeError("OCR query must contain non-whitespace text.");
  if (normalized.length > MAX_QUERY_CODE_UNITS) {
    throw new RangeError(`Normalized OCR query exceeds ${MAX_QUERY_CODE_UNITS} UTF-16 code units.`);
  }
  return normalized;
}

function normalizeText(value: string, caseSensitive: boolean): string {
  const whitespaceNormalized = value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(CJK_INTERNAL_SPACE, "");
  return caseSensitive ? whitespaceNormalized : whitespaceNormalized.toLowerCase();
}

function validateAndIndexDocument(value: unknown, caseSensitive: boolean): IndexedLine[] {
  if (!isRecord(value)) throw new TypeError("OCR document must be an object.");
  validateBoundedString(
    value.engineVersion,
    "document.engineVersion",
    MAX_ENGINE_VERSION_CODE_UNITS,
    false
  );
  if (!Array.isArray(value.lines)) throw new TypeError("document.lines must be an array.");
  if (value.lines.length > MAX_LINES) {
    throw new RangeError(`OCR document exceeds ${MAX_LINES} lines.`);
  }
  const budget: ValidationBudget = {
    words: 0,
    symbols: 0,
    textCodeUnits: 0,
    normalizedTextCodeUnits: 0,
    normalizedSymbolTextCodeUnits: 0
  };
  return Array.from(value.lines, (line, lineIndex) =>
    validateAndIndexLine(line, lineIndex, caseSensitive, budget)
  );
}

function validateAndIndexLine(
  value: unknown,
  lineIndex: number,
  caseSensitive: boolean,
  budget: ValidationBudget
): IndexedLine {
  if (!isRecord(value)) throw new TypeError(`document.lines[${lineIndex}] must be an object.`);
  const lineText = validateBoundedString(
    value.text,
    `document.lines[${lineIndex}].text`,
    MAX_LINE_TEXT_CODE_UNITS,
    true
  );
  consumeTextBudget(budget, lineText.length);
  if (!Array.isArray(value.words)) {
    throw new TypeError(`document.lines[${lineIndex}].words must be an array.`);
  }
  budget.words += value.words.length;
  if (budget.words > MAX_WORDS) {
    throw new RangeError(`OCR document exceeds ${MAX_WORDS} words.`);
  }

  const words = Array.from(value.words, (word, wordIndex) =>
    validateWord(word, lineIndex, wordIndex, caseSensitive, budget)
  );
  let normalizedText = "";
  const characterOwners: number[] = [];
  const indexedWords: IndexedWord[] = [];
  const wordAtStart = new Map<number, number>();
  const wordAtEnd = new Map<number, number>();
  for (const word of words) {
    if (normalizedText.length > 0) {
      const previousCharacter = lastCodePoint(normalizedText);
      const nextCharacter = firstCodePoint(word.normalizedText);
      if (!isCjk(previousCharacter) || !isCjk(nextCharacter)) {
        normalizedText += " ";
        characterOwners.push(Math.max(0, word.wordIndex - 1));
      }
    }
    const start = normalizedText.length;
    normalizedText += word.normalizedText;
    for (let offset = 0; offset < word.normalizedText.length; offset += 1) {
      characterOwners.push(word.wordIndex);
    }
    const end = normalizedText.length;
    const indexedWord = { ...word, start, end };
    indexedWords.push(indexedWord);
    wordAtStart.set(start, word.wordIndex);
    wordAtEnd.set(end, word.wordIndex);
  }
  return {
    lineIndex,
    normalizedText,
    characterOwners,
    words: indexedWords,
    wordAtStart,
    wordAtEnd,
    confidenceIndex: createRangeMinimumIndex(indexedWords.map((word) => word.confidence))
  };
}

function validateWord(
  value: unknown,
  lineIndex: number,
  wordIndex: number,
  caseSensitive: boolean,
  budget: ValidationBudget
): Omit<IndexedWord, "start" | "end"> {
  const name = `document.lines[${lineIndex}].words[${wordIndex}]`;
  if (!isRecord(value)) throw new TypeError(`${name} must be an object.`);
  const rawText = validateBoundedString(
    value.text,
    `${name}.text`,
    MAX_WORD_TEXT_CODE_UNITS,
    false
  );
  consumeTextBudget(budget, rawText.length);
  const normalizedText = normalizeText(rawText, caseSensitive);
  if (normalizedText.length === 0) {
    throw new RangeError(`${name}.text must contain non-whitespace text.`);
  }
  consumeNormalizedTextBudget(budget, normalizedText.length);
  const confidence = validateConfidence(value.confidence, `${name}.confidence`);
  const bbox = validateBounds(value.bbox, `${name}.bbox`);
  let symbols: IndexedSymbol[] | undefined;
  if (value.symbols !== undefined) {
    if (!Array.isArray(value.symbols)) throw new TypeError(`${name}.symbols must be an array.`);
    budget.symbols += value.symbols.length;
    if (budget.symbols > MAX_SYMBOLS) {
      throw new RangeError(`OCR document exceeds ${MAX_SYMBOLS} symbols.`);
    }
    const indexed = indexSymbols(value.symbols, name, caseSensitive, budget);
    if (
      indexed.usable &&
      indexed.normalizedText === normalizedText &&
      indexed.symbols.length > 0 &&
      indexed.symbols.every((symbol) => boundsContain(bbox, symbol.bbox))
    ) {
      symbols = indexed.symbols;
    }
  }
  return {
    wordIndex,
    rawText,
    normalizedText,
    confidence,
    bbox,
    ...(symbols === undefined ? {} : { symbols })
  };
}

function indexSymbols(
  values: unknown[],
  wordName: string,
  caseSensitive: boolean,
  budget: ValidationBudget
): { normalizedText: string; symbols: IndexedSymbol[]; usable: boolean } {
  let normalizedText = "";
  const symbols: IndexedSymbol[] = [];
  let usable = true;
  for (const [symbolIndex, value] of values.entries()) {
    const name = `${wordName}.symbols[${symbolIndex}]`;
    if (!isRecord(value)) throw new TypeError(`${name} must be an object.`);
    const text = validateBoundedString(
      value.text,
      `${name}.text`,
      MAX_SYMBOL_TEXT_CODE_UNITS,
      true
    );
    consumeTextBudget(budget, text.length);
    const normalizedSymbol = normalizeText(text, caseSensitive);
    if (normalizedSymbol.length === 0) continue;
    consumeNormalizedSymbolTextBudget(budget, normalizedSymbol.length);
    validateConfidence(value.confidence, `${name}.confidence`);
    const bbox = validateSymbolBounds(value.bbox, `${name}.bbox`);
    const start = normalizedText.length;
    normalizedText += normalizedSymbol;
    if (normalizedText.length > MAX_TOTAL_TEXT_CODE_UNITS) {
      throw new RangeError(
        `Normalized OCR symbol evidence exceeds ${MAX_TOTAL_TEXT_CODE_UNITS} UTF-16 code units.`
      );
    }
    const end = normalizedText.length;
    if (bbox === undefined) {
      usable = false;
    } else {
      symbols.push({ symbolIndex, rawText: text, start, end, bbox });
    }
  }
  return { normalizedText, symbols, usable };
}

function* matchingOccurrences(
  line: IndexedLine,
  query: string,
  mode: OcrMatchOptions["mode"]
): Generator<MatchOccurrence> {
  let searchFrom = 0;
  for (;;) {
    const start = line.normalizedText.indexOf(query, searchFrom);
    if (start < 0) return;
    const end = start + query.length;
    searchFrom = start + 1;
    const firstWordIndex = line.characterOwners[start];
    const lastWordIndex = line.characterOwners[end - 1];
    if (firstWordIndex === undefined || lastWordIndex === undefined) continue;
    if (
      mode === "exact" &&
      (line.wordAtStart.get(start) !== firstWordIndex || line.wordAtEnd.get(end) !== lastWordIndex)
    ) {
      continue;
    }
    const confidence = rangeMinimum(line.confidenceIndex, firstWordIndex, lastWordIndex);
    yield { mode, line, start, end, firstWordIndex, lastWordIndex, confidence };
  }
}

function candidateIdentity(occurrence: MatchOccurrence): string {
  if (occurrence.mode === "exact") {
    return `ocr-l${occurrence.line.lineIndex}-w${occurrence.firstWordIndex}-${occurrence.lastWordIndex}`;
  }
  const words = occurrence.line.words.slice(
    occurrence.firstWordIndex,
    occurrence.lastWordIndex + 1
  );
  const symbolEvidence = symbolEvidenceFor(occurrence, words);
  return symbolEvidence === undefined
    ? `ocr-l${occurrence.line.lineIndex}-w${occurrence.firstWordIndex}-${occurrence.lastWordIndex}`
    : `ocr-l${occurrence.line.lineIndex}-s${symbolEvidence.indexes
        .map((index) => `${index.wordIndex}.${index.symbolIndex}`)
        .join("_")}`;
}

function toCandidate(occurrence: MatchOccurrence, id: string): OcrTextCandidate {
  const words = occurrence.line.words.slice(
    occurrence.firstWordIndex,
    occurrence.lastWordIndex + 1
  );
  if (words.length === 0) throw new Error("OCR match has no supporting words.");
  const wordIndexes = words.map((word) => word.wordIndex);
  const symbolEvidence =
    occurrence.mode === "contains" ? symbolEvidenceFor(occurrence, words) : undefined;
  const precision = symbolEvidence === undefined ? "word" : "symbol";
  const bbox = unionBounds(
    symbolEvidence === undefined ? words.map((word) => word.bbox) : symbolEvidence.bounds
  );
  const normalizedText = occurrence.line.normalizedText.slice(occurrence.start, occurrence.end);
  return {
    id,
    text:
      occurrence.mode === "exact"
        ? words.map((word) => word.rawText).join(" ")
        : (symbolEvidence?.text ?? normalizedText),
    normalizedText,
    bbox,
    confidence: occurrence.confidence,
    precision,
    evidence: {
      lineIndex: occurrence.line.lineIndex,
      wordIndexes,
      ...(symbolEvidence === undefined ? {} : { symbolIndexes: symbolEvidence.indexes })
    }
  };
}

function symbolEvidenceFor(
  occurrence: MatchOccurrence,
  words: readonly IndexedWord[]
): SymbolEvidence | undefined {
  const indexes: { wordIndex: number; symbolIndex: number }[] = [];
  const bounds: OcrBounds[] = [];
  const text: string[] = [];
  for (const word of words) {
    if (word.symbols === undefined) return undefined;
    const overlapStart = Math.max(occurrence.start, word.start) - word.start;
    const overlapEnd = Math.min(occurrence.end, word.end) - word.start;
    const selected = word.symbols.filter(
      (symbol) => symbol.end > overlapStart && symbol.start < overlapEnd
    );
    if (selected.length === 0) return undefined;
    for (const symbol of selected) {
      indexes.push({ wordIndex: word.wordIndex, symbolIndex: symbol.symbolIndex });
      bounds.push(symbol.bbox);
      text.push(symbol.rawText);
    }
  }
  return indexes.length === 0 ? undefined : { indexes, bounds, text: text.join("") };
}

function createRangeMinimumIndex(values: readonly number[]): RangeMinimumIndex {
  const levels = [Float64Array.from(values)];
  for (let span = 2; span <= values.length; span *= 2) {
    const previous = levels.at(-1) as Float64Array;
    const half = span / 2;
    const level = new Float64Array(values.length - span + 1);
    for (let index = 0; index < level.length; index += 1) {
      level[index] = Math.min(previous[index] ?? 100, previous[index + half] ?? 100);
    }
    levels.push(level);
  }
  return { levels };
}

function rangeMinimum(index: RangeMinimumIndex, first: number, last: number): number {
  const length = last - first + 1;
  const power = Math.floor(Math.log2(length));
  const span = 2 ** power;
  const level = index.levels[power];
  if (level === undefined) throw new Error("OCR confidence index is internally inconsistent.");
  return Math.min(level[first] ?? 100, level[last - span + 1] ?? 100);
}

function unionBounds(bounds: readonly OcrBounds[]): OcrBounds {
  const first = bounds[0];
  if (first === undefined) throw new Error("OCR candidate has no bounding boxes.");
  return {
    x0: Math.min(...bounds.map((bound) => bound.x0)),
    y0: Math.min(...bounds.map((bound) => bound.y0)),
    x1: Math.max(...bounds.map((bound) => bound.x1)),
    y1: Math.max(...bounds.map((bound) => bound.y1))
  };
}

function validateBounds(value: unknown, name: string): OcrBounds {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object.`);
  const coordinates = [value.x0, value.y0, value.x1, value.y1];
  if (
    coordinates.some(
      (coordinate) =>
        typeof coordinate !== "number" ||
        !Number.isFinite(coordinate) ||
        coordinate < 0 ||
        coordinate > MAX_COORDINATE
    )
  ) {
    throw new RangeError(`${name} coordinates must be finite numbers from 0 to ${MAX_COORDINATE}.`);
  }
  const bounds = value as unknown as OcrBounds;
  if (bounds.x1 <= bounds.x0 || bounds.y1 <= bounds.y0) {
    throw new RangeError(`${name} must have positive width and height.`);
  }
  return { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: bounds.y1 };
}

function validateSymbolBounds(value: unknown, name: string): OcrBounds | undefined {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object.`);
  const coordinates = [value.x0, value.y0, value.x1, value.y1];
  if (
    coordinates.some(
      (coordinate) =>
        typeof coordinate !== "number" ||
        !Number.isFinite(coordinate) ||
        coordinate < 0 ||
        coordinate > MAX_COORDINATE
    )
  ) {
    throw new RangeError(`${name} coordinates must be finite numbers from 0 to ${MAX_COORDINATE}.`);
  }
  const bounds = value as unknown as OcrBounds;
  if (bounds.x1 < bounds.x0 || bounds.y1 < bounds.y0) {
    throw new RangeError(`${name} has reversed coordinates.`);
  }
  if (bounds.x1 === bounds.x0 || bounds.y1 === bounds.y0) return undefined;
  return { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: bounds.y1 };
}

function boundsContain(outer: OcrBounds, inner: OcrBounds): boolean {
  return (
    inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1
  );
}

function validateConfidence(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${name} must be a finite number from 0 to 100.`);
  }
  return value;
}

function validateBoundedString(
  value: unknown,
  name: string,
  maximumCodeUnits: number,
  allowEmpty: boolean
): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
  if (!allowEmpty && value.length === 0) throw new RangeError(`${name} must not be empty.`);
  if (!isWellFormedUtf16(value)) throw new RangeError(`${name} must be well-formed UTF-16 text.`);
  if (value.length > maximumCodeUnits) {
    throw new RangeError(`${name} exceeds ${maximumCodeUnits} UTF-16 code units.`);
  }
  return value;
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function consumeTextBudget(budget: ValidationBudget, amount: number): void {
  budget.textCodeUnits += amount;
  if (budget.textCodeUnits > MAX_TOTAL_TEXT_CODE_UNITS) {
    throw new RangeError(
      `OCR document exceeds ${MAX_TOTAL_TEXT_CODE_UNITS} total UTF-16 text code units.`
    );
  }
}

function consumeNormalizedTextBudget(budget: ValidationBudget, amount: number): void {
  budget.normalizedTextCodeUnits += amount;
  if (budget.normalizedTextCodeUnits > MAX_TOTAL_TEXT_CODE_UNITS) {
    throw new RangeError(
      `Normalized OCR word text exceeds ${MAX_TOTAL_TEXT_CODE_UNITS} UTF-16 code units.`
    );
  }
}

function consumeNormalizedSymbolTextBudget(budget: ValidationBudget, amount: number): void {
  budget.normalizedSymbolTextCodeUnits += amount;
  if (budget.normalizedSymbolTextCodeUnits > MAX_TOTAL_TEXT_CODE_UNITS) {
    throw new RangeError(
      `Normalized OCR symbol text exceeds ${MAX_TOTAL_TEXT_CODE_UNITS} UTF-16 code units.`
    );
  }
}

function firstCodePoint(value: string): string {
  return String.fromCodePoint(value.codePointAt(0) as number);
}

function lastCodePoint(value: string): string {
  const finalIndex = value.length - 1;
  const finalUnit = value.charCodeAt(finalIndex);
  if (finalIndex > 0 && finalUnit >= 0xdc00 && finalUnit <= 0xdfff) {
    const previousUnit = value.charCodeAt(finalIndex - 1);
    if (previousUnit >= 0xd800 && previousUnit <= 0xdbff) return value.slice(finalIndex - 1);
  }
  return value.slice(finalIndex);
}

function isCjk(value: string): boolean {
  return CJK_CHARACTER.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
