import { describe, expect, it } from "vitest";

import {
  ANNOTATION_PRESETS,
  ANNOTATION_TONES,
  ANNOTATION_TYPES,
  MAX_ANNOTATIONS,
  MAX_TOTAL_TEXT_LENGTH,
  annotationSpecSchema,
  canonicalizeSpec,
  parseAnnotationSpec,
  resolveAnnotationSpec,
  type AnnotationSpecInput
} from "../src/spec/index.js";

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

describe("AnnotationSpec v1 schema", () => {
  it("accepts every annotation kind and supplies stable IDs and defaults", () => {
    const parsed = parseAnnotationSpec({
      version: "1.0",
      annotations: [
        { type: "rectangle", rect: { x: 1, y: 2, width: 3, height: 4 } },
        { type: "ellipse", rect: { x: 1, y: 2, width: 3, height: 4 } },
        { type: "arrow", start: { x: 1, y: 2 }, target: { x: 3, y: 4 } },
        { type: "text", position: { x: 1, y: 2 }, text: "说明" },
        { type: "callout", target: { x: 1, y: 2 }, text: "Callout" },
        {
          type: "numbered-callout",
          target: { x: 1, y: 2, width: 3, height: 4 },
          text: "Review",
          number: 1
        },
        { type: "highlight", rect: { x: 1, y: 2, width: 3, height: 4 } },
        { type: "spotlight", rect: { x: 1, y: 2, width: 3, height: 4 } },
        { type: "blur", rect: { x: 1, y: 2, width: 3, height: 4 } },
        { type: "redact", rect: { x: 1, y: 2, width: 3, height: 4 } }
      ]
    });

    expect(parsed.version).toBe("1.0");
    expect(parsed.coordinateSpace).toBe("pixel");
    expect(parsed.annotations.map((annotation) => annotation.type)).toEqual(ANNOTATION_TYPES);
    expect(parsed.annotations.map((annotation) => annotation.id)).toEqual(
      ANNOTATION_TYPES.map((_, index) => `a${index + 1}`)
    );
    expect(parsed.annotations[4]).toMatchObject({ placement: "auto" });
    expect(parsed.annotations[8]).toMatchObject({ sigma: 10 });
    expect(parsed.annotations[9]).toMatchObject({ color: "#000000" });
  });

  it("keeps the complete 1.0 resolved style byte-for-byte compatible", () => {
    const result = resolveAnnotationSpec(
      {
        version: "1.0",
        annotations: [
          {
            type: "numbered-callout",
            target: { x: 20, y: 20, width: 40, height: 30 },
            text: "legacy",
            number: 1
          }
        ]
      },
      { width: 200, height: 120 }
    );
    expect(result.spec).toEqual({
      version: "1.0",
      coordinateSpace: "pixel",
      annotations: [
        {
          id: "a1",
          coordinateSpace: "pixel",
          type: "numbered-callout",
          target: { x: 20, y: 20, width: 40, height: 30 },
          text: "legacy",
          number: 1,
          placement: "auto",
          style: {
            strokeColor: "#FF3B30",
            fillColor: "#00000000",
            textColor: "#FFFFFF",
            backgroundColor: "#D92D20",
            strokeWidth: 3,
            fontSize: 24,
            opacity: 1,
            padding: 10,
            cornerRadius: 6,
            lineHeight: 1.25,
            arrowHeadSize: 12
          }
        }
      ]
    });
  });

  it("preserves explicit safe IDs and generates IDs without collisions", () => {
    const parsed = parseAnnotationSpec({
      version: "1.0",
      annotations: [
        { type: "rectangle", rect: { x: 0, y: 0, width: 1, height: 1 } },
        { id: "a1", type: "ellipse", rect: { x: 0, y: 0, width: 1, height: 1 } },
        { type: "highlight", rect: { x: 0, y: 0, width: 1, height: 1 } },
        { id: "review-4", type: "spotlight", rect: { x: 0, y: 0, width: 1, height: 1 } }
      ]
    });

    expect(parsed.annotations.map((annotation) => annotation.id)).toEqual([
      "a2",
      "a1",
      "a3",
      "review-4"
    ]);
  });

  it("rejects duplicate and unsafe IDs", () => {
    const duplicate = annotationSpecSchema.safeParse({
      version: "1.0",
      annotations: [
        { id: "same", type: "rectangle", rect: { x: 0, y: 0, width: 1, height: 1 } },
        { id: "same", type: "ellipse", rect: { x: 0, y: 0, width: 1, height: 1 } }
      ]
    });
    const unsafe = annotationSpecSchema.safeParse({
      version: "1.0",
      annotations: [
        { id: "../secret", type: "rectangle", rect: { x: 0, y: 0, width: 1, height: 1 } }
      ]
    });

    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.issues[0]?.message).toContain("Duplicate annotation ID");
    expect(unsafe.success).toBe(false);
    expect(unsafe.error?.issues[0]?.path).toEqual(["annotations", 0, "id"]);
  });

  it("enforces strict safe colors, style bounds, blur sigma, and opaque redact", () => {
    const valid = parseAnnotationSpec({
      version: "1.0",
      annotations: [
        {
          type: "rectangle",
          rect: { x: 0, y: 0, width: 10, height: 10 },
          style: { strokeColor: "#aabbcc", fillColor: "#11223380", opacity: 0.5 }
        },
        {
          type: "redact",
          rect: { x: 0, y: 0, width: 10, height: 10 },
          color: "#abcdef"
        }
      ]
    });
    expect(valid.annotations[0]?.style).toMatchObject({
      strokeColor: "#AABBCC",
      fillColor: "#11223380"
    });
    expect(valid.annotations[1]).toMatchObject({ color: "#ABCDEF" });
    expect(
      resolveAnnotationSpec(valid, { width: 20, height: 20 }).spec.annotations[1]
    ).toMatchObject({
      color: "#ABCDEF",
      style: { fillColor: "#ABCDEF", opacity: 1 }
    });

    for (const invalidAnnotation of [
      {
        type: "rectangle",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        style: { strokeColor: "red" }
      },
      {
        type: "rectangle",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        style: { fontSize: 257 }
      },
      { type: "blur", rect: { x: 0, y: 0, width: 10, height: 10 }, sigma: 0.2 },
      {
        type: "redact",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        color: "#00000080"
      },
      {
        type: "redact",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        style: { opacity: 0.99 }
      }
    ]) {
      expect(
        annotationSpecSchema.safeParse({ version: "1.0", annotations: [invalidAnnotation] }).success
      ).toBe(false);
    }
  });

  it("rejects unknown fields and non-v1 versions", () => {
    expect(annotationSpecSchema.safeParse({ version: "2.0", annotations: [] }).success).toBe(false);
    expect(
      annotationSpecSchema.safeParse({ version: "1.0", annotations: [], createdAt: "now" }).success
    ).toBe(false);
    expect(
      annotationSpecSchema.safeParse({
        version: "1.0",
        annotations: [
          {
            type: "rectangle",
            rect: { x: 0, y: 0, width: 1, height: 1 },
            script: "alert(1)"
          }
        ]
      }).success
    ).toBe(false);
  });
});

describe("AnnotationSpec 1.1 readable style contract", () => {
  const callout = {
    type: "numbered-callout" as const,
    target: { x: 120, y: 90, width: 80, height: 50 },
    text: "普通说明",
    number: 1
  };

  it("defaults to docs-light with a high-contrast label and independent blue marker", () => {
    const parsed = parseAnnotationSpec({ version: "1.1", annotations: [callout] });
    const resolved = resolveAnnotationSpec(parsed, { width: 640, height: 420 });
    const annotation = resolved.spec.annotations[0];

    expect(parsed).toMatchObject({ version: "1.1", preset: "docs-light" });
    expect(annotation?.style).toEqual({
      strokeColor: "#2563EB",
      fillColor: "#00000000",
      textColor: "#0F172A",
      backgroundColor: "#EFF6FF",
      markerStrokeColor: "#2563EB",
      markerFillColor: "#2563EB",
      markerTextColor: "#FFFFFF",
      strokeWidth: 2,
      fontSize: 22,
      opacity: 1,
      padding: 12,
      maxWidth: 360,
      cornerRadius: 8,
      lineHeight: 1.35,
      arrowHeadSize: 12
    });
    expect(contrastRatio("#0F172A", "#EFF6FF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#FFFFFF", "#2563EB")).toBeGreaterThanOrEqual(4.5);
  });

  it("resolves complete readable palettes for every preset and tone", () => {
    const presetStyles = {
      "docs-light": {
        strokeColor: "#2563EB",
        fillColor: "#00000000",
        textColor: "#0F172A",
        backgroundColor: "#EFF6FF",
        markerStrokeColor: "#2563EB",
        markerFillColor: "#2563EB",
        markerTextColor: "#FFFFFF",
        strokeWidth: 2,
        fontSize: 22,
        opacity: 1,
        padding: 12,
        maxWidth: 360,
        cornerRadius: 8,
        lineHeight: 1.35,
        arrowHeadSize: 12
      },
      "docs-dark": {
        strokeColor: "#60A5FA",
        fillColor: "#00000000",
        textColor: "#F8FAFC",
        backgroundColor: "#1E293B",
        markerStrokeColor: "#60A5FA",
        markerFillColor: "#2563EB",
        markerTextColor: "#FFFFFF",
        strokeWidth: 2,
        fontSize: 22,
        opacity: 1,
        padding: 12,
        maxWidth: 360,
        cornerRadius: 8,
        lineHeight: 1.35,
        arrowHeadSize: 12
      },
      "high-contrast": {
        strokeColor: "#FACC15",
        fillColor: "#00000000",
        textColor: "#FFFFFF",
        backgroundColor: "#000000",
        markerStrokeColor: "#FACC15",
        markerFillColor: "#FACC15",
        markerTextColor: "#000000",
        strokeWidth: 3,
        fontSize: 22,
        opacity: 1,
        padding: 12,
        maxWidth: 360,
        cornerRadius: 8,
        lineHeight: 1.35,
        arrowHeadSize: 12
      },
      "classic-red": {
        strokeColor: "#FF3B30",
        fillColor: "#00000000",
        textColor: "#FFFFFF",
        backgroundColor: "#D92D20",
        markerStrokeColor: "#FF3B30",
        markerFillColor: "#D92D20",
        markerTextColor: "#FFFFFF",
        strokeWidth: 3,
        fontSize: 24,
        opacity: 1,
        padding: 10,
        maxWidth: 360,
        cornerRadius: 6,
        lineHeight: 1.25,
        arrowHeadSize: 12
      }
    } as const;
    for (const preset of ANNOTATION_PRESETS) {
      const first = resolveAnnotationSpec(
        { version: "1.1", preset, annotations: [callout] },
        { width: 640, height: 420 }
      );
      const second = resolveAnnotationSpec(
        { annotations: [callout], preset, version: "1.1" },
        { width: 640, height: 420 }
      );
      expect(first).toEqual(second);
      const style = first.spec.annotations[0]?.style;
      expect(style).toEqual(presetStyles[preset]);
      if (
        style === undefined ||
        style.markerTextColor === undefined ||
        style.markerFillColor === undefined
      ) {
        throw new Error(`Preset ${preset} did not resolve a complete style.`);
      }
      expect(contrastRatio(style.textColor, style.backgroundColor)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(style.markerTextColor, style.markerFillColor)).toBeGreaterThanOrEqual(
        4.5
      );
    }

    const tonePatches = {
      neutral: {
        strokeColor: "#64748B",
        textColor: "#0F172A",
        backgroundColor: "#F1F5F9",
        markerStrokeColor: "#475569",
        markerFillColor: "#475569",
        markerTextColor: "#FFFFFF"
      },
      info: {
        strokeColor: "#2563EB",
        textColor: "#0F172A",
        backgroundColor: "#EFF6FF",
        markerStrokeColor: "#2563EB",
        markerFillColor: "#2563EB",
        markerTextColor: "#FFFFFF"
      },
      success: {
        strokeColor: "#15803D",
        textColor: "#14532D",
        backgroundColor: "#F0FDF4",
        markerStrokeColor: "#15803D",
        markerFillColor: "#15803D",
        markerTextColor: "#FFFFFF"
      },
      warning: {
        strokeColor: "#B45309",
        textColor: "#78350F",
        backgroundColor: "#FFFBEB",
        markerStrokeColor: "#B45309",
        markerFillColor: "#B45309",
        markerTextColor: "#FFFFFF"
      },
      danger: {
        strokeColor: "#DC2626",
        textColor: "#7F1D1D",
        backgroundColor: "#FEF2F2",
        markerStrokeColor: "#DC2626",
        markerFillColor: "#DC2626",
        markerTextColor: "#FFFFFF"
      }
    } as const;
    for (const tone of ANNOTATION_TONES) {
      const result = resolveAnnotationSpec(
        {
          version: "1.1",
          defaults: {
            strokeColor: "#010101",
            textColor: "#010101",
            backgroundColor: "#010101",
            markerStrokeColor: "#010101",
            markerFillColor: "#010101",
            markerTextColor: "#010101"
          },
          annotations: [{ ...callout, tone }]
        },
        { width: 640, height: 420 }
      );
      const style = result.spec.annotations[0]?.style;
      expect(style).toEqual({ ...presetStyles["docs-light"], ...tonePatches[tone] });
      if (
        style === undefined ||
        style.markerTextColor === undefined ||
        style.markerFillColor === undefined
      ) {
        throw new Error(`Tone ${tone} did not resolve a complete style.`);
      }
      expect(contrastRatio(style.textColor, style.backgroundColor)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(style.markerTextColor, style.markerFillColor)).toBeGreaterThanOrEqual(
        4.5
      );
    }
  });

  it("applies precedence independently for every style field", () => {
    const fields = [
      { field: "strokeColor", root: "#111111", local: "#212121" },
      { field: "fillColor", root: "#121212", local: "#222222" },
      { field: "textColor", root: "#131313", local: "#232323" },
      { field: "backgroundColor", root: "#141414", local: "#242424" },
      { field: "markerStrokeColor", root: "#151515", local: "#252525" },
      { field: "markerFillColor", root: "#161616", local: "#262626" },
      { field: "markerTextColor", root: "#171717", local: "#272727" },
      { field: "strokeWidth", root: 4, local: 5 },
      { field: "fontSize", root: 30, local: 31 },
      { field: "opacity", root: 0.6, local: 0.7 },
      { field: "padding", root: 20, local: 21 },
      { field: "maxWidth", root: 500, local: 501 },
      { field: "cornerRadius", root: 12, local: 13 },
      { field: "lineHeight", root: 1.5, local: 1.6 },
      { field: "arrowHeadSize", root: 20, local: 21 }
    ] as const;

    for (const { field, root, local } of fields) {
      const rootResult = resolveAnnotationSpec(
        {
          version: "1.1",
          preset: "docs-dark",
          defaults: { [field]: root },
          annotations: [callout]
        },
        { width: 640, height: 420 }
      );
      expect(rootResult.spec.annotations[0]?.style[field]).toBe(root);

      const localResult = resolveAnnotationSpec(
        {
          version: "1.1",
          preset: "docs-dark",
          defaults: { [field]: root },
          annotations: [{ ...callout, tone: "danger", style: { [field]: local } }]
        },
        { width: 640, height: 420 }
      );
      expect(localResult.spec.annotations[0]?.style[field]).toBe(local);
    }
  });

  it("keeps redact opaque and bound to its explicit replacement color", () => {
    const resolved = resolveAnnotationSpec(
      {
        version: "1.1",
        preset: "classic-red",
        defaults: { fillColor: "#FF000080", opacity: 0.2 },
        annotations: [
          {
            type: "redact",
            rect: { x: 10, y: 10, width: 30, height: 20 },
            color: "#123456",
            tone: "danger"
          }
        ]
      },
      { width: 100, height: 80 }
    );
    expect(resolved.spec.annotations[0]).toMatchObject({
      color: "#123456",
      style: { fillColor: "#123456", opacity: 1, strokeWidth: 0 }
    });

    expect(
      annotationSpecSchema.safeParse({
        version: "1.1",
        annotations: [
          {
            type: "redact",
            rect: { x: 0, y: 0, width: 10, height: 10 },
            style: { opacity: 0.5 }
          }
        ]
      }).success
    ).toBe(false);
  });

  it("accepts maxWidth boundaries and rejects invalid 1.1 fields without weakening 1.0", () => {
    for (const maxWidth of [48, 4_096]) {
      expect(
        annotationSpecSchema.safeParse({
          version: "1.1",
          defaults: { maxWidth },
          annotations: [callout]
        }).success
      ).toBe(true);
    }

    for (const value of [47, 4_097, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        annotationSpecSchema.safeParse({
          version: "1.1",
          annotations: [{ ...callout, style: { maxWidth: value } }]
        }).success
      ).toBe(false);
    }

    for (const invalid of [
      { version: "1.2", annotations: [] },
      { version: "1.1", preset: "paper", annotations: [] },
      { version: "1.1", annotations: [{ ...callout, tone: "urgent" }] },
      { version: "1.1", defaults: { markerFillColor: "blue" }, annotations: [] },
      { version: "1.1", defaults: { mystery: 1 }, annotations: [] },
      { version: "1.1", annotations: [{ ...callout, mystery: 1 }] },
      { version: "1.1", annotations: [{ ...callout, style: { mystery: 1 } }] },
      { version: "1.0", preset: "docs-light", annotations: [] },
      { version: "1.0", defaults: { maxWidth: 200 }, annotations: [] },
      { version: "1.0", annotations: [{ ...callout, tone: "info" }] },
      { version: "1.0", annotations: [{ ...callout, style: { maxWidth: 200 } }] },
      {
        version: "1.0",
        annotations: [{ ...callout, style: { markerFillColor: "#2563EB" } }]
      }
    ]) {
      expect(annotationSpecSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("canonicalizes 1.1 defaults and colors while preserving repeated output", () => {
    const input = {
      annotations: [
        {
          ...callout,
          tone: "neutral",
          style: { markerFillColor: "#abcdef", maxWidth: 180 }
        }
      ],
      defaults: { backgroundColor: "#f8fafc" },
      version: "1.1"
    };
    const canonical = canonicalizeSpec(input);
    expect(canonicalizeSpec(input)).toBe(canonical);
    expect(canonical).toContain('"preset":"docs-light"');
    expect(canonical).toContain('"markerFillColor":"#ABCDEF"');
  });
});

describe("coordinate resolution", () => {
  it("converts normalized rectangles and points to integer pixels", () => {
    const result = resolveAnnotationSpec(
      {
        version: "1.0",
        coordinateSpace: "normalized",
        annotations: [
          { type: "rectangle", rect: { x: 0.1, y: 0.2, width: 0.25, height: 0.3 } },
          { type: "arrow", start: { x: 0, y: 0 }, target: { x: 1, y: 1 } },
          {
            type: "text",
            coordinateSpace: "pixel",
            position: { x: 17.4, y: 23.6 },
            text: "pixel override"
          }
        ]
      },
      { width: 200, height: 100 }
    );

    expect(result.spec.coordinateSpace).toBe("pixel");
    expect(result.spec.annotations[0]).toMatchObject({
      rect: { x: 20, y: 20, width: 50, height: 30 },
      coordinateSpace: "pixel"
    });
    expect(result.spec.annotations[1]).toMatchObject({
      start: { x: 0, y: 0 },
      target: { x: 199, y: 99 }
    });
    expect(result.spec.annotations[2]).toMatchObject({ position: { x: 17, y: 24 } });
    expect(result.warnings).toEqual([]);
  });

  it("does not add pixels or warnings because of normalized floating-point noise", () => {
    const result = resolveAnnotationSpec(
      {
        version: "1.0",
        coordinateSpace: "normalized",
        annotations: [
          { type: "rectangle", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
          { type: "ellipse", rect: { x: 0.7, y: 0.7, width: 0.3, height: 0.3 } }
        ]
      },
      { width: 300, height: 300 }
    );

    expect(result.spec.annotations[0]).toMatchObject({
      rect: { x: 30, y: 30, width: 60, height: 60 }
    });
    expect(result.spec.annotations[1]).toMatchObject({
      rect: { x: 210, y: 210, width: 90, height: 90 }
    });
    expect(result.warnings).toEqual([]);
  });

  it("clamps partially out-of-bounds regions and reports stable warnings", () => {
    const result = resolveAnnotationSpec(
      {
        version: "1.0",
        annotations: [
          { id: "edge", type: "rectangle", rect: { x: -10, y: 90, width: 30, height: 30 } },
          {
            id: "norm",
            type: "highlight",
            coordinateSpace: "normalized",
            rect: { x: 0.9, y: 0.9, width: 0.2, height: 0.2 }
          }
        ]
      },
      { width: 100, height: 100 }
    );

    expect(result.spec.annotations[0]).toMatchObject({
      rect: { x: 0, y: 90, width: 20, height: 10 }
    });
    expect(result.spec.annotations[1]).toMatchObject({
      rect: { x: 90, y: 90, width: 10, height: 10 }
    });
    expect(result.warnings).toEqual([
      'Annotation "edge" rect was clamped to the 100x100 canvas.',
      'Annotation "norm" rect was clamped to the 100x100 canvas.'
    ]);
  });

  it("rejects empty, wholly outside, and out-of-canvas point geometry", () => {
    expect(() =>
      parseAnnotationSpec({
        version: "1.0",
        annotations: [{ type: "rectangle", rect: { x: 0, y: 0, width: 0, height: 10 } }]
      })
    ).toThrow();
    expect(() =>
      resolveAnnotationSpec(
        {
          version: "1.0",
          annotations: [{ type: "rectangle", rect: { x: 100, y: 0, width: 10, height: 10 } }]
        },
        { width: 100, height: 100 }
      )
    ).toThrow(/wholly outside/);
    expect(() =>
      resolveAnnotationSpec(
        {
          version: "1.0",
          annotations: [{ type: "text", position: { x: -1, y: 0 }, text: "outside" }]
        },
        { width: 100, height: 100 }
      )
    ).toThrow(/outside/);
  });

  it("requires normalized components to be between zero and one", () => {
    const result = annotationSpecSchema.safeParse({
      version: "1.0",
      coordinateSpace: "normalized",
      annotations: [{ type: "rectangle", rect: { x: -0.1, y: 0, width: 0.5, height: 0.5 } }]
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("between 0 and 1");
  });

  it("bounds annotation count and aggregate text size", () => {
    const rectangle = { type: "rectangle" as const, rect: { x: 0, y: 0, width: 1, height: 1 } };
    expect(() =>
      parseAnnotationSpec({
        version: "1.0",
        annotations: Array.from({ length: MAX_ANNOTATIONS + 1 }, () => rectangle)
      })
    ).toThrow();
    expect(() =>
      parseAnnotationSpec({
        version: "1.0",
        annotations: Array.from({ length: 11 }, () => ({
          type: "text",
          position: { x: 0, y: 0 },
          text: "x".repeat(Math.ceil(MAX_TOTAL_TEXT_LENGTH / 11))
        }))
      })
    ).toThrow(/Total annotation text/);
  });

  it("uses identical geometry for Chinese and English callout text", () => {
    const makeSpec = (text: string): AnnotationSpecInput => ({
      version: "1.0",
      coordinateSpace: "normalized",
      annotations: [
        {
          type: "callout",
          target: { x: 0.25, y: 0.4, width: 0.2, height: 0.1 },
          text
        }
      ]
    });
    const english = resolveAnnotationSpec(makeSpec("Save failed"), { width: 800, height: 600 });
    const chinese = resolveAnnotationSpec(makeSpec("保存失败"), { width: 800, height: 600 });

    expect(english.spec.annotations[0]).toMatchObject({
      target: (chinese.spec.annotations[0] as { target: unknown }).target
    });
  });
});

describe("canonical JSON", () => {
  it("is stable across input key order and repeated calls", () => {
    const left = {
      annotations: [
        {
          style: { opacity: 0.5, strokeColor: "#ff0000" },
          rect: { height: 20, width: 10, y: 2, x: 1 },
          type: "rectangle"
        }
      ],
      coordinateSpace: "pixel",
      version: "1.0"
    };
    const right = {
      version: "1.0",
      coordinateSpace: "pixel",
      annotations: [
        {
          type: "rectangle",
          rect: { x: 1, y: 2, width: 10, height: 20 },
          style: { strokeColor: "#FF0000", opacity: 0.5 }
        }
      ]
    };

    const canonical = canonicalizeSpec(left);
    expect(canonicalizeSpec(right)).toBe(canonical);
    expect(canonicalizeSpec(left)).toBe(canonical);
    expect(canonical).toBe(
      '{"annotations":[{"id":"a1","rect":{"height":20,"width":10,"x":1,"y":2},"style":{"opacity":0.5,"strokeColor":"#FF0000"},"type":"rectangle"}],"coordinateSpace":"pixel","version":"1.0"}'
    );
    expect(canonical).not.toMatch(/createdAt|timestamp|random/i);
  });
});
