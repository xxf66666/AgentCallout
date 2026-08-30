import { describe, expect, it } from "vitest";

import {
  ANNOTATION_TYPES,
  MAX_ANNOTATIONS,
  MAX_TOTAL_TEXT_LENGTH,
  annotationSpecSchema,
  canonicalizeSpec,
  parseAnnotationSpec,
  resolveAnnotationSpec,
  type AnnotationSpecInput
} from "../src/spec/index.js";

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
