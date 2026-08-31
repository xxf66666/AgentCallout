import { describe, expect, it } from "vitest";

import {
  circleOverlapsTarget,
  connectCircleToTarget,
  layoutCallout,
  placeCallout
} from "../src/layout/index.js";

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

  it("scores a target-facing marker footprint even when the label itself is clear", () => {
    const input = {
      ...centeredInput,
      gap: 60,
      occupied: [{ x: 190, y: 90, width: 20, height: 20 }]
    };

    expect(placeCallout(input).placement).toBe("top");
    expect(placeCallout({ ...input, facingDecorationDepth: 50 }).placement).toBe("right");
  });

  it("scores the exposed leader corridor between a marker footprint and target", () => {
    const input = {
      ...centeredInput,
      gap: 60,
      occupied: [{ x: 190, y: 110, width: 20, height: 10 }],
      facingDecorationSpan: 30
    };

    expect(placeCallout({ ...input, facingDecorationDepth: 30 }).placement).toBe("top");
    expect(placeCallout({ ...input, facingDecorationDepth: 60 }).placement).toBe("right");
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

  it("warns when a facing decoration still overflows after label clamping", () => {
    const result = placeCallout({
      canvas: { width: 100, height: 80 },
      target: { x: 45, y: 2, width: 10, height: 10 },
      box: { width: 50, height: 20 },
      placement: "top",
      margin: 4,
      gap: 60,
      facingDecorationDepth: 60,
      facingDecorationSpan: 40
    });

    expect(
      result.warnings.some((warning) => warning.includes("decoration footprint overflowed"))
    ).toBe(true);
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

describe("numbered-callout boundary leaders", () => {
  it.each([
    ["left", { x: 40, y: 100 }, { x: 80, y: 100 }],
    ["right", { x: 160, y: 100 }, { x: 120, y: 100 }],
    ["top", { x: 100, y: 40 }, { x: 100, y: 80 }],
    ["bottom", { x: 100, y: 160 }, { x: 100, y: 120 }]
  ] as const)(
    "connects a circle to a %s point from the circle boundary",
    (_side, target, start) => {
      expect(connectCircleToTarget({ center: { x: 100, y: 100 }, radius: 20 }, target)).toEqual({
        start,
        end: target,
        length: 40
      });
    }
  );

  it("ends on a rectangular target boundary and reports only exposed length", () => {
    const leader = connectCircleToTarget(
      { center: { x: 100, y: 100 }, radius: 20 },
      { x: 20, y: 80, width: 20, height: 40 }
    );

    expect(leader).toEqual({
      start: { x: 80, y: 100 },
      end: { x: 40, y: 100 },
      length: 40
    });
  });

  it("distinguishes tangency from marker/target overlap", () => {
    const marker = { center: { x: 60, y: 50 }, radius: 20 };
    expect(circleOverlapsTarget(marker, { x: 20, y: 30, width: 20, height: 40 })).toBe(false);
    expect(circleOverlapsTarget(marker, { x: 20.1, y: 30, width: 20, height: 40 })).toBe(true);
    expect(circleOverlapsTarget(marker, { x: 40, y: 50 })).toBe(false);
    expect(circleOverlapsTarget(marker, { x: 40.1, y: 50 })).toBe(true);
  });

  it("reports zero exposed leader when the marker is contained by the target", () => {
    const marker = { center: { x: 50, y: 50 }, radius: 10 };
    const target = { x: 20, y: 20, width: 60, height: 60 };

    expect(circleOverlapsTarget(marker, target)).toBe(true);
    expect(connectCircleToTarget(marker, target)).toEqual({
      start: { x: 50, y: 20 },
      end: { x: 50, y: 20 },
      length: 0
    });
  });

  it("rejects invalid circle and target geometry", () => {
    expect(() =>
      connectCircleToTarget({ center: { x: 10, y: 10 }, radius: 0 }, { x: 20, y: 20 })
    ).toThrow(/circle.radius/u);
    expect(() =>
      connectCircleToTarget(
        { center: { x: 10, y: 10 }, radius: 2 },
        { x: 20, y: 20, width: -1, height: 10 }
      )
    ).toThrow(/target.width/u);
    expect(() =>
      connectCircleToTarget(
        { center: { x: 10, y: 10 }, radius: 2 },
        {
          x: 20,
          y: 20,
          width: 5
        }
      )
    ).toThrow(/both width and height/u);
  });
});
