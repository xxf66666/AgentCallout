import { describe, expect, it } from "vitest";

import { layoutCallout, placeCallout } from "../src/layout/index.js";

const centeredInput = {
  canvas: { width: 400, height: 300 },
  target: { x: 180, y: 130, width: 40, height: 40 },
  box: { width: 100, height: 50 },
  margin: 0,
  gap: 10
} as const;

describe("deterministic callout placement", () => {
  it.each([
    ["top", { x: 150, y: 70, width: 100, height: 50 }],
    ["right", { x: 230, y: 125, width: 100, height: 50 }],
    ["bottom", { x: 150, y: 180, width: 100, height: 50 }],
    ["left", { x: 70, y: 125, width: 100, height: 50 }]
  ] as const)("honors an explicit %s placement", (placement, expectedBox) => {
    const result = placeCallout({ ...centeredInput, placement });

    expect(result.placement).toBe(placement);
    expect(result.box).toEqual(expectedBox);
    expect(result.score).toMatchObject({ overflow: 0, targetOverlap: 0, calloutOverlap: 0 });
    expect(result.warnings).toEqual([]);
  });

  it("uses the documented top/right/bottom/left order to break auto ties", () => {
    const result = placeCallout({ ...centeredInput, placement: "auto" });

    expect(result.placement).toBe("top");
    expect(result.box).toEqual({ x: 150, y: 70, width: 100, height: 50 });
  });

  it("avoids occupied callouts and then chooses the first equal-scoring side", () => {
    const result = placeCallout({
      ...centeredInput,
      occupied: [{ x: 150, y: 70, width: 100, height: 50 }]
    });

    expect(result.placement).toBe("right");
    expect(result.score.calloutOverlap).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("keeps an explicitly placed box inside the canvas and warns on clamping", () => {
    const result = placeCallout({
      canvas: { width: 200, height: 120 },
      target: { x: 80, y: 2, width: 20, height: 20 },
      box: { width: 100, height: 40 },
      placement: "top",
      margin: 8,
      gap: 12
    });

    expect(result.box).toEqual({ x: 40, y: 8, width: 100, height: 40 });
    expect(result.box.x).toBeGreaterThanOrEqual(8);
    expect(result.box.y).toBeGreaterThanOrEqual(8);
    expect(result.box.x + result.box.width).toBeLessThanOrEqual(192);
    expect(result.box.y + result.box.height).toBeLessThanOrEqual(112);
    expect(result.warnings).toContain("Callout position was clamped to the canvas margin.");
    expect(result.warnings.some((warning) => warning.includes("overlaps its target"))).toBe(true);
  });

  it("reports unavoidable occupied overlap", () => {
    const result = placeCallout({
      canvas: { width: 300, height: 200 },
      target: { x: 130, y: 80, width: 40, height: 40 },
      box: { width: 280, height: 180 },
      occupied: [{ x: 10, y: 10, width: 280, height: 180 }],
      placement: "auto",
      margin: 10,
      gap: 10
    });

    expect(result.box).toEqual({ x: 10, y: 10, width: 280, height: 180 });
    expect(result.score.targetOverlap).toBeGreaterThan(0);
    expect(result.score.calloutOverlap).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.includes("overlaps its target"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("occupied callout"))).toBe(true);
  });

  it("clamps an oversized measured box and retains it fully in canvas", () => {
    const result = placeCallout({
      canvas: { width: 100, height: 80 },
      target: { x: 45, y: 35, width: 10, height: 10 },
      box: { width: 500, height: 300 },
      margin: 5
    });

    expect(result.box).toEqual({ x: 5, y: 5, width: 90, height: 70 });
    expect(result.warnings[0]).toContain("was clamped from 500x300 to 90x70");
  });

  it("returns stable anchors, scores, warnings, and geometry across runs", () => {
    const input = {
      canvas: { width: 321, height: 217 },
      target: { x: 7, y: 83, width: 32, height: 27 },
      box: { width: 121.2, height: 47.1 },
      occupied: [
        { x: 8, y: 20, width: 122, height: 48 },
        { x: 45, y: 82, width: 122, height: 48 }
      ],
      margin: 9,
      gap: 11,
      placement: "auto" as const
    };

    const first = placeCallout(input);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(layoutCallout(input)).toEqual(first);
    }
    expect(Number.isFinite(first.score.total)).toBe(true);
    expect(Number.isInteger(first.box.x)).toBe(true);
    expect(Number.isInteger(first.box.y)).toBe(true);
    expect(Number.isInteger(first.box.width)).toBe(true);
    expect(Number.isInteger(first.box.height)).toBe(true);
  });

  it("rejects invalid canvas and spacing values", () => {
    expect(() => placeCallout({ ...centeredInput, margin: -1 })).toThrow(/margin/);
    expect(() => placeCallout({ ...centeredInput, canvas: { width: 0, height: 300 } })).toThrow(
      /canvas.width/
    );
  });
});
