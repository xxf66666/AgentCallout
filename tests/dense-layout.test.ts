import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  DENSE_LAYOUT_DIAGNOSTIC_CODES,
  layoutDenseCallouts,
  MAX_DENSE_BEAM_WIDTH,
  MAX_DENSE_CALLOUTS,
  routeLeader,
  type DenseCalloutItem,
  type LayoutRect
} from "../src/layout/index.js";
import { DENSE_CANVAS, DENSE_COUNTS, makeDenseSpec } from "./fixtures/dense-callouts.js";

function intersectionArea(left: LayoutRect, right: LayoutRect): number {
  return (
    Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)) *
    Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  );
}

function denseItems(count: number): DenseCalloutItem[] {
  return makeDenseSpec("mixed", count).annotations.flatMap((annotation) =>
    annotation.type === "callout" || annotation.type === "numbered-callout"
      ? [
          {
            id: annotation.id,
            target: annotation.target,
            box: { width: 112, height: 32 },
            gap: annotation.type === "numbered-callout" ? 38 : 26,
            paintedOutset: 1,
            ...(annotation.type === "numbered-callout"
              ? { facingDecorationDepth: 20, facingDecorationSpan: 20 }
              : {})
          }
        ]
      : []
  );
}

function expectContinuousRoute(
  route: ReturnType<typeof routeLeader>,
  expectedStart: { x: number; y: number },
  expectedEnd: { x: number; y: number }
): void {
  expect(route.points[0]).toEqual(expectedStart);
  expect(route.points.at(-1)).toEqual(expectedEnd);
  expect(route.segments).toHaveLength(Math.max(0, route.points.length - 1));
  for (let index = 0; index < route.segments.length; index += 1) {
    const segment = route.segments[index];
    if (segment === undefined) throw new Error("Missing route segment");
    expect(segment.start).toEqual(route.points[index]);
    expect(segment.end).toEqual(route.points[index + 1]);
    expect(
      Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y)
    ).toBeGreaterThan(0);
  }
}

describe("dense callout beam layout", () => {
  it.each(DENSE_COUNTS)("lays out %i mixed callouts deterministically", (count) => {
    const items = denseItems(count);
    const input = { canvas: DENSE_CANVAS, items, margin: 8, clearance: 6 } as const;
    const first = layoutDenseCallouts(input);

    expect(layoutDenseCallouts(input)).toEqual(first);
    expect(layoutDenseCallouts(input)).toEqual(first);
    expect(first.placements).toHaveLength(count);
    expect(first.score).toMatchObject({
      targetOverlapCount: 0,
      calloutOverlapCount: 0,
      overflowCount: 0,
      targetOverlapArea: 0,
      calloutOverlapArea: 0,
      overflowArea: 0
    });

    for (const [index, placement] of first.placements.entries()) {
      expect(placement.collisionBox.x).toBeGreaterThanOrEqual(8);
      expect(placement.collisionBox.y).toBeGreaterThanOrEqual(8);
      expect(placement.collisionBox.x + placement.collisionBox.width).toBeLessThanOrEqual(
        DENSE_CANVAS.width - 8
      );
      expect(placement.collisionBox.y + placement.collisionBox.height).toBeLessThanOrEqual(
        DENSE_CANVAS.height - 8
      );
      for (const target of items) {
        expect(intersectionArea(placement.collisionBox, target.target)).toBe(0);
      }
      for (const other of first.placements.slice(index + 1)) {
        expect(intersectionArea(placement.collisionBox, other.collisionBox)).toBe(0);
      }
      expectContinuousRoute(placement.route, placement.anchor, placement.targetAnchor);
      expect(placement.route.collisionIds.length > 0).toBe(
        placement.diagnostics.some((diagnostic) => diagnostic.code === "LEADER_ROUTE_BLOCKED")
      );
    }
  });

  it("protects a future target while honoring a fixed side", () => {
    const protectedTarget = {
      id: "future-target-real-id",
      rect: { x: 150, y: 140, width: 100, height: 30 }
    };
    const result = layoutDenseCallouts({
      canvas: { width: 400, height: 300 },
      items: [
        {
          id: "primary-real-id",
          target: { x: 190, y: 200, width: 20, height: 20 },
          box: { width: 120, height: 40 },
          placement: "top",
          paintedOutset: 2
        }
      ],
      protectedTargets: [protectedTarget]
    });

    expect(result.placements[0]?.placement).toBe("top");
    expect(
      intersectionArea(result.placements[0]?.collisionBox as LayoutRect, protectedTarget.rect)
    ).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps logical, painted, and decoration footprints distinct and applies a per-item gap", () => {
    const placement = layoutDenseCallouts({
      canvas: { width: 400, height: 300 },
      margin: 8,
      gap: 10,
      items: [
        {
          id: "numbered",
          target: { x: 190, y: 200, width: 20, height: 20 },
          box: { width: 100, height: 40 },
          placement: "top",
          gap: 30,
          paintedOutset: 2,
          facingDecorationDepth: 14,
          facingDecorationSpan: 24
        }
      ]
    }).placements[0];

    expect(placement).toMatchObject({
      placement: "top",
      box: { x: 150, y: 130, width: 100, height: 40 },
      paintedBox: { x: 148, y: 128, width: 104, height: 44 },
      collisionBox: { x: 148, y: 128, width: 104, height: 56 }
    });
    expect(placement?.route.pathLength).toBe(30);
  });

  it("chooses inward-facing placements for tiny corner targets and keeps painted footprints in bounds", () => {
    const targets = [
      { x: 2, y: 2, width: 8, height: 8 },
      { x: 390, y: 2, width: 8, height: 8 },
      { x: 2, y: 290, width: 8, height: 8 },
      { x: 390, y: 290, width: 8, height: 8 }
    ];
    const result = layoutDenseCallouts({
      canvas: { width: 400, height: 300 },
      margin: 4,
      clearance: 3,
      items: targets.map((target, index) => ({
        id: `corner-${index}`,
        target,
        box: { width: 90, height: 28 },
        gap: 24,
        paintedOutset: 2,
        facingDecorationDepth: 12,
        facingDecorationSpan: 16
      }))
    });

    expect(result.placements.map((placement) => placement.placement)).toEqual([
      "bottom",
      "bottom",
      "top",
      "top"
    ]);
    expect(result.diagnostics).toEqual([]);
    for (const placement of result.placements) {
      expect(placement.collisionBox.x).toBeGreaterThanOrEqual(4);
      expect(placement.collisionBox.y).toBeGreaterThanOrEqual(4);
      expect(placement.collisionBox.x + placement.collisionBox.width).toBeLessThanOrEqual(396);
      expect(placement.collisionBox.y + placement.collisionBox.height).toBeLessThanOrEqual(296);
    }
  });

  it("reports deterministic warnings in annotation/code order using real IDs", () => {
    const result = layoutDenseCallouts({
      canvas: { width: 120, height: 80 },
      margin: 4,
      minimumLeaderLength: 100,
      items: [
        {
          id: "alpha-real",
          target: { x: 10, y: 10, width: 12, height: 12 },
          box: { width: 108, height: 68 },
          placement: "top",
          paintedOutset: 2
        },
        {
          id: "beta-real",
          target: { x: 90, y: 55, width: 12, height: 12 },
          box: { width: 108, height: 68 },
          placement: "top",
          paintedOutset: 2
        }
      ]
    });
    const expectedCodes = [...DENSE_LAYOUT_DIAGNOSTIC_CODES];

    expect(result.diagnostics.map((diagnostic) => diagnostic.annotationId)).toEqual([
      ...Array<string>(5).fill("alpha-real"),
      ...Array<string>(5).fill("beta-real")
    ]);
    expect(result.diagnostics.slice(0, 5).map((diagnostic) => diagnostic.code)).toEqual(
      expectedCodes
    );
    expect(result.diagnostics.slice(5).map((diagnostic) => diagnostic.code)).toEqual(expectedCodes);
    expect(
      result.placements[0]?.diagnostics.find((diagnostic) => diagnostic.code === "CALLOUT_OVERLAP")
        ?.relatedIds
    ).toEqual(["beta-real"]);
    expect(
      result.placements[1]?.diagnostics.find((diagnostic) => diagnostic.code === "CALLOUT_OVERLAP")
        ?.relatedIds
    ).toEqual(["alpha-real"]);
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/label:\d|target:target:/u);
  });

  it("bounds candidate and beam work for the supported 200-callout ceiling", () => {
    const items: DenseCalloutItem[] = Array.from(
      { length: MAX_DENSE_CALLOUTS },
      (_value, index) => ({
        id: `bounded-${index}`,
        target: {
          x: 100 + (index % 20) * 40,
          y: 80 + Math.floor(index / 20) * 40,
          width: 8,
          height: 8
        },
        box: { width: 72, height: 24 },
        gap: index % 2 === 0 ? 14 : 36,
        paintedOutset: 1,
        ...(index % 2 === 0 ? {} : { facingDecorationDepth: 18, facingDecorationSpan: 18 })
      })
    );
    const startedAt = performance.now();
    const result = layoutDenseCallouts({ canvas: DENSE_CANVAS, items });
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(result.placements).toHaveLength(MAX_DENSE_CALLOUTS);
    expect(elapsedMilliseconds).toBeLessThan(10_000);
    expect(() =>
      layoutDenseCallouts({
        canvas: DENSE_CANVAS,
        items: [...items, { ...items[0]!, id: "one-too-many" }]
      })
    ).toThrow(/at most 200/u);
    expect(() =>
      layoutDenseCallouts({
        canvas: DENSE_CANVAS,
        items: items.slice(0, 3),
        beamWidth: MAX_DENSE_BEAM_WIDTH + 1
      })
    ).toThrow(/beamWidth.*between/u);
    expect(() =>
      layoutDenseCallouts({
        canvas: DENSE_CANVAS,
        items: [{ ...items[0]!, paintedOutset: Number.MAX_VALUE }]
      })
    ).toThrow(/paintedOutset.*between/u);
  });

  it("keeps labels away from premeasured text obstacles", () => {
    const textRect = { x: 150, y: 100, width: 108, height: 22 };
    const result = layoutDenseCallouts({
      canvas: { width: 400, height: 300 },
      items: [
        {
          id: "callout-near-text",
          target: { x: 190, y: 145, width: 12, height: 10 },
          box: { width: 50, height: 20 },
          gap: 26,
          paintedOutset: 1
        }
      ],
      obstacles: [{ id: "text-existing", rect: textRect, clearance: 0 }]
    });
    const placement = result.placements[0];
    if (!placement) throw new Error("Missing text-obstacle placement.");

    expect(intersectionArea(placement.collisionBox, textRect)).toBe(0);
    expect(placement.diagnostics).toEqual([]);
  });

  it("allows multiple callouts to share one target without false route-blocked warnings", () => {
    const target = { x: 190, y: 145, width: 20, height: 10 };
    const result = layoutDenseCallouts({
      canvas: { width: 400, height: 300 },
      items: [
        { id: "shared-a", target, box: { width: 72, height: 24 }, gap: 26 },
        { id: "shared-b", target, box: { width: 72, height: 24 }, gap: 26 }
      ]
    });

    expect(result.placements).toHaveLength(2);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === "LEADER_ROUTE_BLOCKED")
    ).toBe(false);
  });
});

describe("deterministic obstacle-aware leader routing", () => {
  it("treats painted-boundary tangency as safe but routes around positive interior overlap", () => {
    const common = {
      canvas: { width: 100, height: 100 },
      start: { x: 10, y: 39 },
      end: { x: 90, y: 39 },
      obstacles: [{ id: "painted-box", rect: { x: 40, y: 40, width: 20, height: 20 } }],
      clearance: 0,
      strokeWidth: 2
    } as const;
    const tangent = routeLeader(common);
    const interior = routeLeader({
      ...common,
      start: { x: 10, y: 39.01 },
      end: { x: 90, y: 39.01 }
    });

    expect(tangent.bendCount).toBe(0);
    expect(tangent.collisionIds).toEqual([]);
    expect(interior.bendCount).toBeGreaterThan(0);
    expect(interior.collisionIds).toEqual([]);
  });

  it("uses direct, horizontal-then-vertical, vertical-then-horizontal, and dogleg routes", () => {
    const direct = routeLeader({
      canvas: { width: 100, height: 100 },
      start: { x: 10, y: 10 },
      end: { x: 90, y: 90 },
      clearance: 0,
      strokeWidth: 2
    });
    const horizontalVertical = routeLeader({
      canvas: { width: 100, height: 100 },
      start: { x: 10, y: 10 },
      end: { x: 90, y: 90 },
      obstacles: [{ id: "center", rect: { x: 38, y: 38, width: 10, height: 10 } }],
      clearance: 0,
      strokeWidth: 0
    });
    const verticalHorizontal = routeLeader({
      canvas: { width: 100, height: 100 },
      start: { x: 10, y: 10 },
      end: { x: 90, y: 90 },
      obstacles: [{ id: "upper-column", rect: { x: 45, y: 5, width: 10, height: 60 } }],
      clearance: 0,
      strokeWidth: 0
    });
    const dogleg = routeLeader({
      canvas: { width: 200, height: 100 },
      start: { x: 20, y: 50 },
      end: { x: 180, y: 50 },
      obstacles: [{ id: "barrier", rect: { x: 90, y: 30, width: 20, height: 40 } }],
      clearance: 0,
      strokeWidth: 2
    });

    expect(direct.points).toEqual([
      { x: 10, y: 10 },
      { x: 90, y: 90 }
    ]);
    expect(horizontalVertical.points).toEqual([
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 90 }
    ]);
    expect(verticalHorizontal.points).toEqual([
      { x: 10, y: 10 },
      { x: 10, y: 90 },
      { x: 90, y: 90 }
    ]);
    expect(dogleg.points).toEqual([
      { x: 20, y: 50 },
      { x: 20, y: 28 },
      { x: 180, y: 28 },
      { x: 180, y: 50 }
    ]);
    expect([
      direct.bendCount,
      horizontalVertical.bendCount,
      verticalHorizontal.bendCount,
      dogleg.bendCount
    ]).toEqual([0, 1, 1, 2]);
    expect(dogleg.collisionIds).toEqual([]);
    expect(dogleg.bounds.x).toBeGreaterThanOrEqual(0);
    expect(dogleg.bounds.y).toBeGreaterThanOrEqual(0);
    expect(dogleg.bounds.x + dogleg.bounds.width).toBeLessThanOrEqual(200);
    expect(dogleg.bounds.y + dogleg.bounds.height).toBeLessThanOrEqual(100);
  });

  it("returns the least-blocked complete route with an explicit warning when no route exists", () => {
    const input = {
      canvas: { width: 200, height: 100 },
      start: { x: 20, y: 50 },
      end: { x: 180, y: 50 },
      obstacles: [{ id: "wall-real-id", rect: { x: 90, y: 0, width: 20, height: 100 } }],
      clearance: 0,
      strokeWidth: 2
    } as const;
    const first = routeLeader(input);

    expect(routeLeader(input)).toEqual(first);
    expectContinuousRoute(first, input.start, input.end);
    expect(first.collisionIds).toEqual(["wall-real-id"]);
    expect(first.diagnostics).toEqual([
      expect.objectContaining({
        code: "LEADER_ROUTE_BLOCKED",
        collisionIds: ["wall-real-id"]
      })
    ]);
  });
});
