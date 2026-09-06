import { createHash } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { paintedSegmentIntersectsRect, renderAnnotations } from "../src/renderer/index.js";
import { resolveAnnotationSpec } from "../src/spec/index.js";
import {
  ARROW_HEAD_PROTECTION_CANVAS,
  ARROW_HEAD_PROTECTION_SPEC,
  BLOCKED_ROUTE_CANVAS,
  BLOCKED_ROUTE_SPEC,
  CALLOUT_HEAD_LABEL_CANVAS,
  CALLOUT_HEAD_LABEL_SPEC,
  CORNER_SMALL_BUTTON_SPEC,
  DENSE_CANVAS,
  DENSE_SCENARIOS,
  FORCED_ORTHOGONAL_ARROW_SPEC,
  FORCED_ORTHOGONAL_ROUTE_SPEC,
  FUTURE_TARGET_SPEC,
  SHORT_LEADER_CANVAS,
  SHORT_LEADER_SPEC,
  TINY_TEXT_CLIPPING_CANVAS,
  TINY_TEXT_CLIPPING_SPEC,
  UNAVOIDABLE_TARGET_CANVAS,
  UNAVOIDABLE_TARGET_SPEC,
  makeDenseSpec,
  type DenseSpecFixture,
  type FixtureRect
} from "./fixtures/dense-callouts.js";

interface Point {
  x: number;
  y: number;
}

interface Segment {
  start: Point;
  end: Point;
}

interface RouteGeometry {
  kind: "straight" | "orthogonal";
  start: Point;
  end: Point;
  /** Compatibility distance between the first and last boundary points. */
  length: number;
  pathLength: number;
  points: Point[];
  segments: Segment[];
  bendCount: number;
  bounds: FixtureRect;
  strokeWidth: number;
  collisionIds?: string[];
}

interface LayoutIssue {
  code: string;
  annotationId: string;
  relatedIds: string[];
  message: string;
  metrics?: Record<string, number>;
}

interface ResolvedDenseAnnotation {
  id: string;
  type: "callout" | "numbered-callout" | "arrow";
  target: Point | FixtureRect;
  box?: FixtureRect;
  label?: {
    box?: FixtureRect;
    paintedBounds?: FixtureRect;
  };
  marker?: {
    center?: Point;
    paintedRadius?: number;
    bounds?: FixtureRect;
  };
  leader?: RouteGeometry;
  path?: RouteGeometry;
  arrowHead?: {
    tip: Point;
    wings: [Point, Point];
    bounds: FixtureRect;
  };
  layout?: {
    status: "ok" | "degraded";
    issues: LayoutIssue[];
  };
}

interface RenderCaseResult {
  buffer: Buffer;
  warnings: string[];
  resolvedAnnotations: ResolvedDenseAnnotation[];
}

interface RawRaster {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

const EPSILON = 1e-6;

async function renderCase(
  spec: DenseSpecFixture,
  canvas: Readonly<{ width: number; height: number }> = DENSE_CANVAS
): Promise<RenderCaseResult> {
  const input = await sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 3,
      background: "#f4f7fb"
    }
  })
    .png()
    .toBuffer();
  const resolution = resolveAnnotationSpec(spec, canvas);
  expect(resolution.warnings).toEqual([]);
  const rendered = await renderAnnotations(input, resolution.spec.annotations, {
    specVersion: "1.1"
  });
  return {
    buffer: rendered.buffer,
    warnings: rendered.warnings,
    resolvedAnnotations: rendered.resolvedAnnotations as unknown as ResolvedDenseAnnotation[]
  };
}

async function rawRaster(buffer: Buffer): Promise<RawRaster> {
  const raw = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    data: raw.data,
    width: raw.info.width,
    height: raw.info.height,
    channels: raw.info.channels
  };
}

function rgbAt(raster: RawRaster, point: Point): [number, number, number] {
  const x = Math.max(0, Math.min(raster.width - 1, Math.round(point.x)));
  const y = Math.max(0, Math.min(raster.height - 1, Math.round(point.y)));
  const offset = (y * raster.width + x) * raster.channels;
  return [raster.data[offset] ?? 0, raster.data[offset + 1] ?? 0, raster.data[offset + 2] ?? 0];
}

function routeMidpoint(segment: Segment): Point {
  return {
    x: (segment.start.x + segment.end.x) / 2,
    y: (segment.start.y + segment.end.y) / 2
  };
}

const BACKGROUND_RGB = [244, 247, 251] as const;

function hasPaintedPixelNear(raster: RawRaster, point: Point, radius = 2): boolean {
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      const rgb = rgbAt(raster, { x: point.x + offsetX, y: point.y + offsetY });
      if (rgb.some((channel, index) => channel !== BACKGROUND_RGB[index])) return true;
    }
  }
  return false;
}

function hasExactPixelNear(
  raster: RawRaster,
  point: Point,
  expected: readonly [number, number, number],
  radius = 1
): boolean {
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      if (
        rgbAt(raster, { x: point.x + offsetX, y: point.y + offsetY }).every(
          (channel, index) => channel === expected[index]
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function countExactPixelsInRect(
  raster: RawRaster,
  rect: FixtureRect,
  expected: readonly [number, number, number]
): number {
  let count = 0;
  for (let y = Math.ceil(rect.y); y < Math.floor(rect.y + rect.height); y += 1) {
    for (let x = Math.ceil(rect.x); x < Math.floor(rect.x + rect.width); x += 1) {
      if (rgbAt(raster, { x, y }).every((channel, index) => channel === expected[index])) {
        count += 1;
      }
    }
  }
  return count;
}

function pointToSegmentDistance(point: Point, segment: Segment): number {
  const deltaX = segment.end.x - segment.start.x;
  const deltaY = segment.end.y - segment.start.y;
  const squaredLength = deltaX * deltaX + deltaY * deltaY;
  if (squaredLength <= EPSILON) {
    return Math.hypot(point.x - segment.start.x, point.y - segment.start.y);
  }
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - segment.start.x) * deltaX + (point.y - segment.start.y) * deltaY) / squaredLength
    )
  );
  return Math.hypot(
    point.x - (segment.start.x + projection * deltaX),
    point.y - (segment.start.y + projection * deltaY)
  );
}

function arrowHeadInteriorProbe(
  arrowHead: NonNullable<ResolvedDenseAnnotation["arrowHead"]>
): Point {
  return {
    x: arrowHead.tip.x * 0.1 + arrowHead.wings[0].x * 0.75 + arrowHead.wings[1].x * 0.15,
    y: arrowHead.tip.y * 0.1 + arrowHead.wings[0].y * 0.75 + arrowHead.wings[1].y * 0.15
  };
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function isRect(value: Point | FixtureRect): value is FixtureRect {
  return "width" in value && "height" in value;
}

function rectsOverlap(left: FixtureRect, right: FixtureRect): boolean {
  return (
    Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x) + EPSILON &&
    Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y) + EPSILON
  );
}

interface MarkerGeometry {
  center: Point;
  paintedRadius: number;
  bounds: FixtureRect;
}

function circleOverlapsRect(marker: MarkerGeometry, rect: FixtureRect): boolean {
  const closestX = Math.min(rect.x + rect.width, Math.max(rect.x, marker.center.x));
  const closestY = Math.min(rect.y + rect.height, Math.max(rect.y, marker.center.y));
  return (
    Math.hypot(marker.center.x - closestX, marker.center.y - closestY) + EPSILON <
    marker.paintedRadius
  );
}

function expectRectInsideCanvas(
  rect: FixtureRect,
  canvas: Readonly<{ width: number; height: number }>
): void {
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.x).toBeGreaterThanOrEqual(-EPSILON);
  expect(rect.y).toBeGreaterThanOrEqual(-EPSILON);
  expect(rect.x + rect.width).toBeLessThanOrEqual(canvas.width + EPSILON);
  expect(rect.y + rect.height).toBeLessThanOrEqual(canvas.height + EPSILON);
}

function labelBounds(annotation: ResolvedDenseAnnotation): FixtureRect {
  const bounds = annotation.label?.paintedBounds ?? annotation.label?.box ?? annotation.box;
  if (!bounds) throw new Error(`Resolved ${annotation.id} is missing label bounds.`);
  return bounds;
}

function markerGeometry(annotation: ResolvedDenseAnnotation): MarkerGeometry | undefined {
  if (annotation.type !== "numbered-callout") return undefined;
  const marker = annotation.marker;
  if (!marker?.bounds || !marker.center || marker.paintedRadius === undefined) {
    throw new Error(`Resolved ${annotation.id} is missing painted marker geometry.`);
  }
  return {
    center: marker.center,
    paintedRadius: marker.paintedRadius,
    bounds: marker.bounds
  };
}

function targetBounds(annotation: ResolvedDenseAnnotation): FixtureRect {
  const target = annotation.target;
  return isRect(target) ? target : { x: target.x - 0.5, y: target.y - 0.5, width: 1, height: 1 };
}

function routeGeometry(annotation: ResolvedDenseAnnotation): RouteGeometry {
  const route = annotation.type === "arrow" ? annotation.path : annotation.leader;
  if (!route) {
    throw new Error(
      `Resolved ${annotation.id} is missing ${annotation.type === "arrow" ? "path" : "leader"} geometry.`
    );
  }
  return route;
}

function routeBoundsFromSegments(route: RouteGeometry): FixtureRect {
  const radius = Math.max(0.5, route.strokeWidth / 2);
  const left = Math.min(
    ...route.segments.map((segment) => Math.min(segment.start.x, segment.end.x) - radius)
  );
  const top = Math.min(
    ...route.segments.map((segment) => Math.min(segment.start.y, segment.end.y) - radius)
  );
  const right = Math.max(
    ...route.segments.map((segment) => Math.max(segment.start.x, segment.end.x) + radius)
  );
  const bottom = Math.max(
    ...route.segments.map((segment) => Math.max(segment.start.y, segment.end.y) + radius)
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function expectRectClose(actual: FixtureRect, expected: FixtureRect): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.width).toBeCloseTo(expected.width, 6);
  expect(actual.height).toBeCloseTo(expected.height, 6);
}

function expectCompleteRoute(
  route: RouteGeometry,
  canvas: Readonly<{ width: number; height: number }>
): void {
  expect(["straight", "orthogonal"]).toContain(route.kind);
  expect(route.strokeWidth).toBeGreaterThan(0);
  expect(route.points.length).toBeGreaterThanOrEqual(2);
  expect(route.segments).toHaveLength(route.points.length - 1);
  expect(route.start).toEqual(route.points[0]);
  expect(route.end).toEqual(route.points.at(-1));

  for (const [index, segment] of route.segments.entries()) {
    expect(segment.start).toEqual(route.points[index]);
    expect(segment.end).toEqual(route.points[index + 1]);
    expect(
      Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y)
    ).toBeGreaterThan(0);
    if (route.kind === "orthogonal") {
      expect(
        Math.abs(segment.start.x - segment.end.x) <= EPSILON ||
          Math.abs(segment.start.y - segment.end.y) <= EPSILON
      ).toBe(true);
    }
  }

  const directDistance = Math.hypot(route.end.x - route.start.x, route.end.y - route.start.y);
  const pathLength = route.segments.reduce(
    (total, segment) =>
      total + Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y),
    0
  );
  expect(route.length).toBeCloseTo(directDistance, 6);
  expect(route.pathLength).toBeCloseTo(pathLength, 6);
  expect(route.pathLength + EPSILON).toBeGreaterThanOrEqual(route.length);
  expect(route.bendCount).toBe(route.segments.length - 1);
  expect(route.kind).toBe(route.bendCount === 0 ? "straight" : "orthogonal");
  expectRectClose(route.bounds, routeBoundsFromSegments(route));
  expectRectInsideCanvas(route.bounds, canvas);
}

function expectPaintedArrowHeadAwayFromShaft(
  annotation: ResolvedDenseAnnotation,
  raster: RawRaster,
  expectedColor: readonly [number, number, number]
): NonNullable<ResolvedDenseAnnotation["arrowHead"]> {
  const route = routeGeometry(annotation);
  const arrowHead = annotation.arrowHead;
  const finalSegment = route.segments.at(-1);
  if (!arrowHead || !finalSegment) {
    throw new Error(`Resolved ${annotation.id} is missing complete arrowhead geometry.`);
  }
  expect(arrowHead.tip).toEqual(route.end);
  expect(arrowHead.wings).toHaveLength(2);
  expect(
    arrowHead.wings.every(
      (wing) => Math.hypot(wing.x - arrowHead.tip.x, wing.y - arrowHead.tip.y) > 0
    )
  ).toBe(true);
  const arrowLeft = Math.min(arrowHead.tip.x, ...arrowHead.wings.map((wing) => wing.x));
  const arrowTop = Math.min(arrowHead.tip.y, ...arrowHead.wings.map((wing) => wing.y));
  const arrowRight = Math.max(arrowHead.tip.x, ...arrowHead.wings.map((wing) => wing.x));
  const arrowBottom = Math.max(arrowHead.tip.y, ...arrowHead.wings.map((wing) => wing.y));
  expectRectClose(arrowHead.bounds, {
    x: arrowLeft,
    y: arrowTop,
    width: Math.max(1, arrowRight - arrowLeft),
    height: Math.max(1, arrowBottom - arrowTop)
  });

  const probe = arrowHeadInteriorProbe(arrowHead);
  expect(pointToSegmentDistance(probe, finalSegment)).toBeGreaterThan(route.strokeWidth / 2 + 1);
  expect(hasExactPixelNear(raster, probe, expectedColor)).toBe(true);
  return arrowHead;
}

function expectRouteEndsAtTarget(annotation: ResolvedDenseAnnotation): void {
  const end = routeGeometry(annotation).end;
  const target = annotation.target;
  if (!isRect(target)) {
    expect(end.x).toBeCloseTo(target.x, 6);
    expect(end.y).toBeCloseTo(target.y, 6);
    return;
  }
  const onVerticalEdge =
    (Math.abs(end.x - target.x) <= EPSILON ||
      Math.abs(end.x - (target.x + target.width)) <= EPSILON) &&
    end.y >= target.y - EPSILON &&
    end.y <= target.y + target.height + EPSILON;
  const onHorizontalEdge =
    (Math.abs(end.y - target.y) <= EPSILON ||
      Math.abs(end.y - (target.y + target.height)) <= EPSILON) &&
    end.x >= target.x - EPSILON &&
    end.x <= target.x + target.width + EPSILON;
  expect(onVerticalEdge || onHorizontalEdge, `${annotation.id} route must end on its target`).toBe(
    true
  );
}

function expectHealthyLayout(annotations: readonly ResolvedDenseAnnotation[]): void {
  for (const annotation of annotations) {
    expect(annotation.layout, `${annotation.id} must expose renderer layout status`).toEqual({
      status: "ok",
      issues: []
    });
  }
}

function expectNoDecorationOverlap(annotations: readonly ResolvedDenseAnnotation[]): void {
  const callouts = annotations.filter((annotation) => annotation.type !== "arrow");
  const labels = callouts.map((annotation) => ({
    owner: annotation.id,
    rect: labelBounds(annotation)
  }));
  const markers = callouts.flatMap((annotation) => {
    const marker = markerGeometry(annotation);
    return marker ? [{ owner: annotation.id, marker }] : [];
  });
  for (let leftIndex = 0; leftIndex < labels.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < labels.length; rightIndex += 1) {
      const left = labels[leftIndex];
      const right = labels[rightIndex];
      if (!left || !right) continue;
      expect(
        rectsOverlap(left.rect, right.rect),
        `${left.owner} label overlaps ${right.owner} label`
      ).toBe(false);
    }
  }
  for (let leftIndex = 0; leftIndex < markers.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < markers.length; rightIndex += 1) {
      const left = markers[leftIndex];
      const right = markers[rightIndex];
      if (!left || !right) continue;
      expect(
        Math.hypot(
          left.marker.center.x - right.marker.center.x,
          left.marker.center.y - right.marker.center.y
        ) +
          EPSILON <
          left.marker.paintedRadius + right.marker.paintedRadius,
        `${left.owner} marker overlaps ${right.owner} marker`
      ).toBe(false);
    }
  }
  for (const marker of markers) {
    for (const label of labels) {
      expect(
        circleOverlapsRect(marker.marker, label.rect),
        `${marker.owner} marker overlaps ${label.owner} label`
      ).toBe(false);
    }
  }
}

function expectEveryTargetVisible(annotations: readonly ResolvedDenseAnnotation[]): void {
  const callouts = annotations.filter((annotation) => annotation.type !== "arrow");
  const targets = annotations.map((annotation) => ({
    owner: annotation.id,
    rect: targetBounds(annotation)
  }));
  const labels = callouts.map((annotation) => ({
    owner: annotation.id,
    rect: labelBounds(annotation)
  }));
  const markers = callouts.flatMap((annotation) => {
    const marker = markerGeometry(annotation);
    return marker ? [{ owner: annotation.id, marker }] : [];
  });
  for (const label of labels) {
    for (const target of targets) {
      expect(
        rectsOverlap(label.rect, target.rect),
        `${label.owner} label covers target ${target.owner}`
      ).toBe(false);
    }
  }
  for (const marker of markers) {
    for (const target of targets) {
      expect(
        circleOverlapsRect(marker.marker, target.rect),
        `${marker.owner} marker covers target ${target.owner}`
      ).toBe(false);
    }
  }
}

function expectRoutesAvoidOtherGeometry(annotations: readonly ResolvedDenseAnnotation[]): void {
  const labels = annotations
    .filter((annotation) => annotation.type !== "arrow")
    .map((annotation) => ({ owner: annotation.id, kind: "label", rect: labelBounds(annotation) }));
  const markers = annotations.flatMap((annotation) => {
    const bounds = markerGeometry(annotation)?.bounds;
    return bounds ? [{ owner: annotation.id, kind: "marker", rect: bounds }] : [];
  });
  const targets = annotations.map((annotation) => ({
    owner: annotation.id,
    kind: "target",
    rect: targetBounds(annotation)
  }));
  for (const annotation of annotations) {
    const route = routeGeometry(annotation);
    for (const obstacle of [...labels, ...markers, ...targets]) {
      if (
        obstacle.owner === annotation.id &&
        !(annotation.type === "numbered-callout" && obstacle.kind === "label")
      ) {
        continue;
      }
      for (const segment of route.segments) {
        expect(
          paintedSegmentIntersectsRect(
            { ...segment, strokeWidth: route.strokeWidth },
            obstacle.rect
          ),
          `${annotation.id} route crosses ${obstacle.owner} ${obstacle.kind}`
        ).toBe(false);
      }
    }
  }
}

function warningCodes(warnings: readonly string[]): string[] {
  return warnings.flatMap((warning) => {
    const match = /^\[([A-Z_]+)\]\s+\S/u.exec(warning);
    return match?.[1] ? [match[1]] : [];
  });
}

function layoutIssueCodes(annotations: readonly ResolvedDenseAnnotation[]): string[] {
  return annotations.flatMap(
    (annotation) => annotation.layout?.issues.map((issue) => issue.code) ?? []
  );
}

function expectExplicitWarning(result: RenderCaseResult, code: string): void {
  expect(warningCodes(result.warnings)).toContain(code);
  expect(layoutIssueCodes(result.resolvedAnnotations)).toContain(code);
  expect(result.warnings.every((warning) => /^\[[A-Z_]+\]\s+\S/u.test(warning))).toBe(true);
  expect(
    result.resolvedAnnotations.some(
      (annotation) =>
        annotation.layout?.status === "degraded" &&
        annotation.layout.issues.some((issue) => issue.code === code)
    )
  ).toBe(true);
}

describe("v0.2.1 dense renderer acceptance", () => {
  it.each(DENSE_SCENARIOS)(
    "$name lays out $count labels deterministically without hiding a target",
    async ({ spec, count }) => {
      const [first, second] = await Promise.all([renderCase(spec), renderCase(spec)]);

      expect(first.resolvedAnnotations).toHaveLength(count);
      expect(first.warnings).toEqual([]);
      expectHealthyLayout(first.resolvedAnnotations);
      expectNoDecorationOverlap(first.resolvedAnnotations);
      expectEveryTargetVisible(first.resolvedAnnotations);
      expectRoutesAvoidOtherGeometry(first.resolvedAnnotations);
      const raster = await rawRaster(first.buffer);
      for (const annotation of first.resolvedAnnotations) {
        const route = routeGeometry(annotation);
        expectCompleteRoute(route, DENSE_CANVAS);
        expectRouteEndsAtTarget(annotation);
        for (const segment of route.segments) {
          expect(hasPaintedPixelNear(raster, routeMidpoint(segment))).toBe(true);
        }
        const label = labelBounds(annotation);
        expect(
          hasPaintedPixelNear(raster, {
            x: label.x + label.width / 2,
            y: label.y + label.height / 2
          })
        ).toBe(true);
        const marker = annotation.marker?.center;
        if (marker) expect(hasPaintedPixelNear(raster, marker)).toBe(true);
        const target = targetBounds(annotation);
        expect(
          rgbAt(raster, { x: target.x + target.width / 2, y: target.y + target.height / 2 })
        ).toEqual([...BACKGROUND_RGB]);
      }

      expect(sha256(first.buffer)).toBe(sha256(second.buffer));
      expect(second.resolvedAnnotations).toEqual(first.resolvedAnnotations);
      expect(second.warnings).toEqual(first.warnings);
    }
  );

  it("lays out ten mixed multi-line labels without relying on short single-line fixtures", async () => {
    const base = makeDenseSpec("mixed", 10);
    const spec: DenseSpecFixture = {
      ...base,
      annotations: base.annotations.map((annotation, index) => ({
        ...annotation,
        text:
          index % 2 === 0
            ? `检查项 ${index + 1} 需要核对状态与操作路径`
            : `Check ${index + 1} status and operation path`
      }))
    };
    const [first, second] = await Promise.all([renderCase(spec), renderCase(spec)]);

    expect(first.warnings).toEqual([]);
    expectHealthyLayout(first.resolvedAnnotations);
    expectNoDecorationOverlap(first.resolvedAnnotations);
    expectEveryTargetVisible(first.resolvedAnnotations);
    expectRoutesAvoidOtherGeometry(first.resolvedAnnotations);
    expect(sha256(second.buffer)).toBe(sha256(first.buffer));
    expect(second.resolvedAnnotations).toEqual(first.resolvedAnnotations);
  });

  it("keeps an auto callout away from an explicitly positioned text label", async () => {
    const spec: DenseSpecFixture = {
      version: "1.1",
      coordinateSpace: "pixel",
      preset: "docs-light",
      defaults: { fontSize: 12, maxWidth: 112, padding: 4, strokeWidth: 2 },
      annotations: [
        {
          id: "fixed-text",
          type: "text",
          position: { x: 150, y: 100 },
          text: "Fixed text area"
        },
        {
          id: "callout-near-text",
          type: "callout",
          target: { x: 190, y: 150, width: 12, height: 10 },
          text: "Must avoid text",
          placement: "top"
        }
      ]
    };
    const result = await renderCase(spec, { width: 400, height: 300 });
    const text = result.resolvedAnnotations.find((annotation) => annotation.id === "fixed-text") as
      (ResolvedDenseAnnotation & { box?: FixtureRect }) | undefined;
    const callout = result.resolvedAnnotations.find(
      (annotation) => annotation.id === "callout-near-text"
    );
    if (!text?.box || !callout) throw new Error("Missing text/callout resolved geometry.");

    expect(result.warnings).toEqual([]);
    expect(rectsOverlap(text.box, labelBounds(callout))).toBe(false);
  });

  it("changes the final approach when the unobstructed arrowhead would cover a future target", async () => {
    const primaryFixture = ARROW_HEAD_PROTECTION_SPEC.annotations[0];
    if (!primaryFixture) throw new Error("Missing head-primary fixture.");
    const baselineSpec: DenseSpecFixture = {
      ...ARROW_HEAD_PROTECTION_SPEC,
      annotations: [primaryFixture]
    };
    const [baseline, result] = await Promise.all([
      renderCase(baselineSpec, ARROW_HEAD_PROTECTION_CANVAS),
      renderCase(ARROW_HEAD_PROTECTION_SPEC, ARROW_HEAD_PROTECTION_CANVAS)
    ]);
    const baselineArrow = baseline.resolvedAnnotations.find(
      (annotation) => annotation.id === "head-primary"
    );
    const arrow = result.resolvedAnnotations.find((annotation) => annotation.id === "head-primary");
    const protectedAnnotation = result.resolvedAnnotations.find(
      (annotation) => annotation.id === "head-protected"
    );
    if (!baselineArrow?.arrowHead || !arrow?.arrowHead || !protectedAnnotation) {
      throw new Error("Missing baseline/final arrowhead or protected target geometry.");
    }
    const protectedTarget = targetBounds(protectedAnnotation);
    const [baselineRaster, raster] = await Promise.all([
      rawRaster(baseline.buffer),
      rawRaster(result.buffer)
    ]);

    expect(routeGeometry(baselineArrow).kind).toBe("straight");
    expect(rectsOverlap(baselineArrow.arrowHead.bounds, protectedTarget)).toBe(true);
    expect(countExactPixelsInRect(baselineRaster, protectedTarget, [255, 0, 0])).toBeGreaterThan(0);
    expect(routeGeometry(arrow).points).not.toEqual(routeGeometry(baselineArrow).points);
    expect(arrow.arrowHead.bounds).not.toEqual(baselineArrow.arrowHead.bounds);
    expect(rectsOverlap(arrow.arrowHead.bounds, protectedTarget)).toBe(false);
    expect(countExactPixelsInRect(raster, protectedTarget, [255, 0, 0])).toBe(0);
    expectPaintedArrowHeadAwayFromShaft(arrow, raster, [255, 0, 0]);
    expect(result.warnings).toEqual([]);
  });

  it("paints a plain-callout arrowhead off its shaft and reports unavoidable label overlap", async () => {
    const result = await renderCase(CALLOUT_HEAD_LABEL_SPEC, CALLOUT_HEAD_LABEL_CANVAS);
    const callout = result.resolvedAnnotations.find(
      (annotation) => annotation.id === "callout-head-label"
    );
    if (!callout?.arrowHead) throw new Error("Missing plain-callout arrowhead geometry.");
    const label = labelBounds(callout);
    const raster = await rawRaster(result.buffer);

    expect(rectsOverlap(callout.arrowHead.bounds, label)).toBe(true);
    expectPaintedArrowHeadAwayFromShaft(callout, raster, [255, 0, 0]);
    const target = targetBounds(callout);
    expect(
      rgbAt(raster, { x: target.x + target.width / 2, y: target.y + target.height / 2 })
    ).toEqual([...BACKGROUND_RGB]);
    expectExplicitWarning(result, "CALLOUT_OVERLAP");
    expectExplicitWarning(result, "INSUFFICIENT_SPACE");
  });

  it("protects a target declared after the label that would otherwise cover it", async () => {
    const result = await renderCase(FUTURE_TARGET_SPEC);

    expect(result.warnings).toEqual([]);
    expectHealthyLayout(result.resolvedAnnotations);
    expectNoDecorationOverlap(result.resolvedAnnotations);
    expectEveryTargetVisible(result.resolvedAnnotations);
    expectRoutesAvoidOtherGeometry(result.resolvedAnnotations);
  });

  it("keeps labels, markers, and complete routes in bounds for four 8px corner targets", async () => {
    const result = await renderCase(CORNER_SMALL_BUTTON_SPEC);

    expect(result.warnings).toEqual([]);
    expectHealthyLayout(result.resolvedAnnotations);
    expectNoDecorationOverlap(result.resolvedAnnotations);
    expectEveryTargetVisible(result.resolvedAnnotations);
    expectRoutesAvoidOtherGeometry(result.resolvedAnnotations);
    for (const annotation of result.resolvedAnnotations) {
      expectRectInsideCanvas(labelBounds(annotation), DENSE_CANVAS);
      const marker = markerGeometry(annotation);
      if (marker) expectRectInsideCanvas(marker.bounds, DENSE_CANVAS);
      expectCompleteRoute(routeGeometry(annotation), DENSE_CANVAS);
      expectRouteEndsAtTarget(annotation);
    }
  });

  it("routes a callout leader orthogonally around a protected future target", async () => {
    const result = await renderCase(FORCED_ORTHOGONAL_ROUTE_SPEC);
    const primary = result.resolvedAnnotations.find(
      (annotation) => annotation.id === "route-primary"
    );
    if (!primary) throw new Error("Missing route-primary resolved annotation.");

    const route = routeGeometry(primary);
    expect(route.kind).toBe("orthogonal");
    expect(route.bendCount).toBeGreaterThan(0);
    expect(route.segments.length).toBeGreaterThan(1);
    expectCompleteRoute(route, DENSE_CANVAS);
    expectRouteEndsAtTarget(primary);
    expectRoutesAvoidOtherGeometry(result.resolvedAnnotations);
  });

  it("routes an arrow orthogonally around a protected future target", async () => {
    const result = await renderCase(FORCED_ORTHOGONAL_ARROW_SPEC);
    const primary = result.resolvedAnnotations.find(
      (annotation) => annotation.id === "arrow-primary"
    );
    if (!primary) throw new Error("Missing arrow-primary resolved annotation.");

    const route = routeGeometry(primary);
    expect(route.kind).toBe("orthogonal");
    expect(route.bendCount).toBeGreaterThan(0);
    expect(route.segments.length).toBeGreaterThan(1);
    expectCompleteRoute(route, DENSE_CANVAS);
    expectRouteEndsAtTarget(primary);
    expectRoutesAvoidOtherGeometry(result.resolvedAnnotations);

    const raster = await rawRaster(result.buffer);
    for (const segment of route.segments) {
      expect(hasPaintedPixelNear(raster, routeMidpoint(segment))).toBe(true);
    }
    expectPaintedArrowHeadAwayFromShaft(primary, raster, [37, 99, 235]);
    const blockedDirectMidpoint = {
      x: (route.start.x + route.end.x) / 2,
      y: (route.start.y + route.end.y) / 2
    };
    expect(rgbAt(raster, blockedDirectMidpoint)).toEqual([...BACKGROUND_RGB]);
    const target = targetBounds(primary);
    expect(
      rgbAt(raster, { x: target.x + target.width / 2, y: target.y + target.height / 2 })
    ).toEqual([...BACKGROUND_RGB]);
  });

  it("emits TEXT_CLIPPED when even the minimum-font text cannot fit", async () => {
    const result = await renderCase(TINY_TEXT_CLIPPING_SPEC, TINY_TEXT_CLIPPING_CANVAS);
    expectExplicitWarning(result, "TEXT_CLIPPED");
    const clipped = result.resolvedAnnotations.find((annotation) =>
      annotation.layout?.issues.some((issue) => issue.code === "TEXT_CLIPPED")
    );
    const issue = clipped?.layout?.issues.find((candidate) => candidate.code === "TEXT_CLIPPED");
    if (!clipped || !issue?.metrics) throw new Error("Missing TEXT_CLIPPED metrics.");
    expect(issue.metrics.clippedAlphaPixelCount).toBeGreaterThan(0);
    expect(
      (issue.metrics.unclippedWidth ?? 0) > (issue.metrics.clippedWidth ?? 0) ||
        (issue.metrics.unclippedHeight ?? 0) > (issue.metrics.clippedHeight ?? 0)
    ).toBe(true);
    const raster = await rawRaster(result.buffer);
    const label = labelBounds(clipped);
    let darkInteriorPixels = 0;
    for (let y = Math.ceil(label.y + 4); y < Math.floor(label.y + label.height - 4); y += 1) {
      for (let x = Math.ceil(label.x + 4); x < Math.floor(label.x + label.width - 4); x += 1) {
        const [red, green, blue] = rgbAt(raster, { x, y });
        if (red < 150 && green < 150 && blue < 150) darkInteriorPixels += 1;
      }
    }
    expect(darkInteriorPixels).toBeGreaterThan(0);
  });

  it("emits TARGET_COVERED when no placement can leave the target visible", async () => {
    const result = await renderCase(UNAVOIDABLE_TARGET_SPEC, UNAVOIDABLE_TARGET_CANVAS);
    expectExplicitWarning(result, "TARGET_COVERED");
  });

  it("emits INSUFFICIENT_SPACE instead of silently accepting degraded placement", async () => {
    const result = await renderCase(UNAVOIDABLE_TARGET_SPEC, UNAVOIDABLE_TARGET_CANVAS);
    expectExplicitWarning(result, "INSUFFICIENT_SPACE");
  });

  it("emits LEADER_TOO_SHORT with the actual short path geometry", async () => {
    const result = await renderCase(SHORT_LEADER_SPEC, SHORT_LEADER_CANVAS);
    expectExplicitWarning(result, "LEADER_TOO_SHORT");
    expect(
      routeGeometry(result.resolvedAnnotations[0] as ResolvedDenseAnnotation).pathLength
    ).toBeLessThan(24);
  });

  it("emits LEADER_ROUTE_BLOCKED when every route crosses a protected target", async () => {
    const [result, repeated] = await Promise.all([
      renderCase(BLOCKED_ROUTE_SPEC, BLOCKED_ROUTE_CANVAS),
      renderCase(BLOCKED_ROUTE_SPEC, BLOCKED_ROUTE_CANVAS)
    ]);
    expectExplicitWarning(result, "LEADER_ROUTE_BLOCKED");
    const primary = result.resolvedAnnotations.find(
      (annotation) => annotation.id === "blocked-primary"
    );
    if (!primary) throw new Error("Missing blocked-primary resolved annotation.");
    expect(routeGeometry(primary).collisionIds?.length).toBeGreaterThan(0);
    expect(sha256(repeated.buffer)).toBe(sha256(result.buffer));
    expect(repeated.resolvedAnnotations).toEqual(result.resolvedAnnotations);
    expect(repeated.warnings).toEqual(result.warnings);
  });
});
