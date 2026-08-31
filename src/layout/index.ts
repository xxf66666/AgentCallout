export type PlacementPreference = "auto" | "top" | "right" | "bottom" | "left";
export type CardinalPlacement = Exclude<PlacementPreference, "auto">;

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutRect extends LayoutPoint {
  width: number;
  height: number;
}

export interface LayoutSize {
  width: number;
  height: number;
}

export type LayoutTarget = LayoutPoint | LayoutRect;

export interface LayoutCircle {
  center: LayoutPoint;
  radius: number;
}

export interface BoundaryLeader {
  /** Point on the marker circle facing the target. */
  start: LayoutPoint;
  /** Point target, or the point where the leader meets a rectangular target boundary. */
  end: LayoutPoint;
  /** Visible distance between the two shape boundaries. Zero when the shapes overlap. */
  length: number;
}

export interface CalloutPlacementInput {
  canvas: LayoutSize;
  target: LayoutRect;
  box: LayoutSize;
  occupied?: readonly LayoutRect[];
  placement?: PlacementPreference;
  margin?: number;
  gap?: number;
  /** Extra occupied depth extending from the label edge toward its target. */
  facingDecorationDepth?: number;
  /** Tangential span of that decoration, such as a numbered marker diameter. */
  facingDecorationSpan?: number;
}

export interface CalloutPlacementScore {
  overflow: number;
  targetOverlap: number;
  calloutOverlap: number;
  leaderDistance: number;
  total: number;
}

export interface CalloutPlacementResult {
  placement: CardinalPlacement;
  box: LayoutRect;
  /** Anchor on the callout box where its leader starts. */
  anchor: LayoutPoint;
  /** Anchor on the target where the leader ends. */
  targetAnchor: LayoutPoint;
  score: CalloutPlacementScore;
  warnings: string[];
}

interface Candidate {
  placement: CardinalPlacement;
  box: LayoutRect;
  collisionBox: LayoutRect;
  decorationOverflow: number;
  score: CalloutPlacementScore;
  wasClamped: boolean;
  order: number;
}

const AUTO_PLACEMENT_ORDER: readonly CardinalPlacement[] = ["top", "right", "bottom", "left"];

/**
 * Deterministically place one already-measured callout. `occupied` should contain
 * boxes returned by earlier calls, in annotation order.
 */
export function placeCallout(input: CalloutPlacementInput): CalloutPlacementResult {
  validateCanvas(input.canvas);
  validateRect(input.target, "target");
  validateSize(input.box, "box");

  const occupied = input.occupied ?? [];
  for (const [index, box] of occupied.entries()) {
    validateRect(box, `occupied[${index}]`);
  }

  const requestedMargin = input.margin ?? 8;
  const requestedGap = input.gap ?? 12;
  const requestedDecorationDepth = input.facingDecorationDepth ?? 0;
  const requestedDecorationSpan = input.facingDecorationSpan ?? 0;
  validateNonNegativeFinite(requestedMargin, "margin");
  validateNonNegativeFinite(requestedGap, "gap");
  validateNonNegativeFinite(requestedDecorationDepth, "facingDecorationDepth");
  validateNonNegativeFinite(requestedDecorationSpan, "facingDecorationSpan");

  const margin = Math.ceil(requestedMargin);
  const gap = Math.ceil(requestedGap);
  const decorationDepth = Math.ceil(requestedDecorationDepth);
  const decorationSpan = Math.ceil(requestedDecorationSpan);
  if (margin * 2 >= input.canvas.width || margin * 2 >= input.canvas.height) {
    throw new RangeError("margin must leave at least one pixel inside the canvas");
  }

  const warnings: string[] = [];
  const requestedBox = {
    width: Math.ceil(input.box.width),
    height: Math.ceil(input.box.height)
  };
  const measuredBox = {
    width: Math.min(requestedBox.width, input.canvas.width - margin * 2),
    height: Math.min(requestedBox.height, input.canvas.height - margin * 2)
  };

  if (measuredBox.width !== requestedBox.width || measuredBox.height !== requestedBox.height) {
    warnings.push(
      `Callout box was clamped from ${requestedBox.width}x${requestedBox.height} to ${measuredBox.width}x${measuredBox.height} to fit the canvas.`
    );
  }

  const preference = input.placement ?? "auto";
  const placements: readonly CardinalPlacement[] =
    preference === "auto" ? AUTO_PLACEMENT_ORDER : [preference];
  const candidates = placements.map((placement, order) =>
    createCandidate(
      placement,
      order,
      input.canvas,
      input.target,
      measuredBox,
      occupied,
      margin,
      gap,
      decorationDepth,
      decorationSpan
    )
  );
  const selected = candidates.reduce((best, candidate) =>
    compareCandidates(candidate, best) < 0 ? candidate : best
  );

  if (selected.wasClamped) {
    warnings.push("Callout position was clamped to the canvas margin.");
  }
  if ((decorationDepth > 0 || decorationSpan > 0) && selected.decorationOverflow > 0) {
    warnings.push("Facing decoration footprint overflowed the canvas margin after clamping.");
  }
  if (selected.score.targetOverlap > 0) {
    warnings.push("Callout overlaps its target because the selected placement cannot avoid it.");
  }

  const occupiedOverlapCount = occupied.filter(
    (box) => intersectionArea(selected.collisionBox, box) > 0
  ).length;
  if (occupiedOverlapCount > 0) {
    warnings.push(
      `Callout overlaps ${occupiedOverlapCount} occupied callout${occupiedOverlapCount === 1 ? "" : "s"}; no collision-free selected placement was available.`
    );
  }

  const anchors = leaderAnchors(selected.placement, selected.box, input.target);
  return {
    placement: selected.placement,
    box: selected.box,
    anchor: anchors.anchor,
    targetAnchor: anchors.targetAnchor,
    score: selected.score,
    warnings
  };
}

/** Alias for consumers that use layout-oriented naming. */
export const layoutCallout = placeCallout;

/**
 * Connect a circular marker to a point or rectangular target without using either
 * shape's center as a visible endpoint.
 */
export function connectCircleToTarget(circle: LayoutCircle, target: LayoutTarget): BoundaryLeader {
  validatePoint(circle.center, "circle.center");
  if (!Number.isFinite(circle.radius) || circle.radius <= 0) {
    throw new RangeError("circle.radius must be a positive finite number");
  }
  if (isLayoutRect(target)) {
    validateRect(target, "target");
  } else {
    validatePoint(target, "target");
  }

  const end = targetBoundaryPoint(circle.center, target);
  const vectorX = end.x - circle.center.x;
  const vectorY = end.y - circle.center.y;
  const boundaryDistance = Math.hypot(vectorX, vectorY);
  if (boundaryDistance <= circle.radius || circleOverlapsTarget(circle, target)) {
    return { start: { x: end.x, y: end.y }, end, length: 0 };
  }
  const scale = circle.radius / boundaryDistance;
  return {
    start: {
      x: circle.center.x + vectorX * scale,
      y: circle.center.y + vectorY * scale
    },
    end,
    length: boundaryDistance - circle.radius
  };
}

/** Return true only when the marker has positive-area overlap with the target. */
export function circleOverlapsTarget(circle: LayoutCircle, target: LayoutTarget): boolean {
  validatePoint(circle.center, "circle.center");
  if (!Number.isFinite(circle.radius) || circle.radius <= 0) {
    throw new RangeError("circle.radius must be a positive finite number");
  }
  if (!isLayoutRect(target)) {
    validatePoint(target, "target");
    return Math.hypot(circle.center.x - target.x, circle.center.y - target.y) < circle.radius;
  }
  validateRect(target, "target");
  const closestX = clamp(circle.center.x, target.x, target.x + target.width);
  const closestY = clamp(circle.center.y, target.y, target.y + target.height);
  return Math.hypot(circle.center.x - closestX, circle.center.y - closestY) < circle.radius;
}

function createCandidate(
  placement: CardinalPlacement,
  order: number,
  canvas: LayoutSize,
  target: LayoutRect,
  boxSize: LayoutSize,
  occupied: readonly LayoutRect[],
  margin: number,
  gap: number,
  decorationDepth: number,
  decorationSpan: number
): Candidate {
  const targetCenterX = target.x + target.width / 2;
  const targetCenterY = target.y + target.height / 2;
  let rawX: number;
  let rawY: number;

  switch (placement) {
    case "top":
      rawX = targetCenterX - boxSize.width / 2;
      rawY = target.y - gap - boxSize.height;
      break;
    case "right":
      rawX = target.x + target.width + gap;
      rawY = targetCenterY - boxSize.height / 2;
      break;
    case "bottom":
      rawX = targetCenterX - boxSize.width / 2;
      rawY = target.y + target.height + gap;
      break;
    case "left":
      rawX = target.x - gap - boxSize.width;
      rawY = targetCenterY - boxSize.height / 2;
      break;
  }

  rawX = Math.round(rawX);
  rawY = Math.round(rawY);
  const rawBox = { x: rawX, y: rawY, ...boxSize };
  const allowedBounds = {
    x: margin,
    y: margin,
    width: canvas.width - margin * 2,
    height: canvas.height - margin * 2
  };
  const maxX = canvas.width - margin - boxSize.width;
  const maxY = canvas.height - margin - boxSize.height;
  const box = {
    x: clamp(rawX, margin, maxX),
    y: clamp(rawY, margin, maxY),
    ...boxSize
  };
  const rawCollisionBox = facingDecorationBox(placement, rawBox, decorationDepth, decorationSpan);
  const collisionBox = facingDecorationBox(placement, box, decorationDepth, decorationSpan);
  const collisionArea = collisionBox.width * collisionBox.height;
  const overflow = collisionArea - intersectionArea(rawCollisionBox, allowedBounds);
  const decorationOverflow = collisionArea - intersectionArea(collisionBox, allowedBounds);
  const targetOverlap = intersectionArea(collisionBox, target);
  const calloutOverlap = occupied.reduce(
    (total, occupiedBox) => total + intersectionArea(collisionBox, occupiedBox),
    0
  );
  const anchors = leaderAnchors(placement, box, target);
  const leaderDistance = Math.hypot(
    anchors.anchor.x - anchors.targetAnchor.x,
    anchors.anchor.y - anchors.targetAnchor.y
  );
  const area = collisionArea;
  const canvasDiagonal = Math.hypot(canvas.width, canvas.height);
  const targetRatio = targetOverlap / area;
  const calloutRatio = calloutOverlap / area;
  const overflowRatio = overflow / area;
  const leaderRatio = canvasDiagonal === 0 ? 0 : leaderDistance / canvasDiagonal;
  const total =
    (targetOverlap > 0 ? 1_000_000_000_000 : 0) +
    (calloutOverlap > 0 ? 1_000_000_000 : 0) +
    (overflow > 0 ? 1_000_000 : 0) +
    targetRatio * 100_000 +
    calloutRatio * 1_000 +
    overflowRatio * 10 +
    leaderRatio;

  return {
    placement,
    box,
    collisionBox,
    decorationOverflow,
    score: {
      overflow,
      targetOverlap,
      calloutOverlap,
      leaderDistance,
      total
    },
    wasClamped: box.x !== rawX || box.y !== rawY,
    order
  };
}

function facingDecorationBox(
  placement: CardinalPlacement,
  box: LayoutRect,
  depth: number,
  span: number
): LayoutRect {
  const tangentialInset = span / 2;
  switch (placement) {
    case "top":
      return {
        x: box.x - tangentialInset,
        y: box.y,
        width: box.width + span,
        height: box.height + depth
      };
    case "right":
      return {
        x: box.x - depth,
        y: box.y - tangentialInset,
        width: box.width + depth,
        height: box.height + span
      };
    case "bottom":
      return {
        x: box.x - tangentialInset,
        y: box.y - depth,
        width: box.width + span,
        height: box.height + depth
      };
    case "left":
      return {
        x: box.x,
        y: box.y - tangentialInset,
        width: box.width + depth,
        height: box.height + span
      };
  }
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.score.total !== right.score.total) {
    return left.score.total - right.score.total;
  }
  return left.order - right.order;
}

function leaderAnchors(
  placement: CardinalPlacement,
  box: LayoutRect,
  target: LayoutRect
): { anchor: LayoutPoint; targetAnchor: LayoutPoint } {
  const boxCenterX = box.x + box.width / 2;
  const boxCenterY = box.y + box.height / 2;
  const targetCenterX = target.x + target.width / 2;
  const targetCenterY = target.y + target.height / 2;

  switch (placement) {
    case "top":
      return {
        anchor: {
          x: Math.round(clamp(targetCenterX, box.x, box.x + box.width)),
          y: box.y + box.height
        },
        targetAnchor: {
          x: Math.round(clamp(boxCenterX, target.x, target.x + target.width)),
          y: target.y
        }
      };
    case "right":
      return {
        anchor: {
          x: box.x,
          y: Math.round(clamp(targetCenterY, box.y, box.y + box.height))
        },
        targetAnchor: {
          x: target.x + target.width,
          y: Math.round(clamp(boxCenterY, target.y, target.y + target.height))
        }
      };
    case "bottom":
      return {
        anchor: {
          x: Math.round(clamp(targetCenterX, box.x, box.x + box.width)),
          y: box.y
        },
        targetAnchor: {
          x: Math.round(clamp(boxCenterX, target.x, target.x + target.width)),
          y: target.y + target.height
        }
      };
    case "left":
      return {
        anchor: {
          x: box.x + box.width,
          y: Math.round(clamp(targetCenterY, box.y, box.y + box.height))
        },
        targetAnchor: {
          x: target.x,
          y: Math.round(clamp(boxCenterY, target.y, target.y + target.height))
        }
      };
  }
}

function targetBoundaryPoint(origin: LayoutPoint, target: LayoutTarget): LayoutPoint {
  if (!isLayoutRect(target)) return { x: target.x, y: target.y };
  const centerX = target.x + target.width / 2;
  const centerY = target.y + target.height / 2;
  const vectorX = origin.x - centerX;
  const vectorY = origin.y - centerY;
  if (vectorX === 0 && vectorY === 0) {
    return { x: centerX, y: target.y };
  }
  const halfWidth = target.width / 2;
  const halfHeight = target.height / 2;
  const scale = 1 / Math.max(Math.abs(vectorX) / halfWidth, Math.abs(vectorY) / halfHeight);
  return {
    x: centerX + vectorX * scale,
    y: centerY + vectorY * scale
  };
}

function isLayoutRect(target: LayoutTarget): target is LayoutRect {
  const hasWidth = Object.prototype.hasOwnProperty.call(target, "width");
  const hasHeight = Object.prototype.hasOwnProperty.call(target, "height");
  if (hasWidth !== hasHeight) {
    throw new RangeError("target must contain both width and height, or neither");
  }
  return hasWidth && hasHeight;
}

function intersectionArea(left: LayoutRect, right: LayoutRect): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  );
  return width * height;
}

function validateCanvas(canvas: LayoutSize): void {
  if (!Number.isInteger(canvas.width) || canvas.width <= 0) {
    throw new RangeError("canvas.width must be a positive integer");
  }
  if (!Number.isInteger(canvas.height) || canvas.height <= 0) {
    throw new RangeError("canvas.height must be a positive integer");
  }
}

function validateSize(size: LayoutSize, name: string): void {
  if (!Number.isFinite(size.width) || size.width <= 0) {
    throw new RangeError(`${name}.width must be a positive finite number`);
  }
  if (!Number.isFinite(size.height) || size.height <= 0) {
    throw new RangeError(`${name}.height must be a positive finite number`);
  }
}

function validateRect(rect: LayoutRect, name: string): void {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
    throw new RangeError(`${name} coordinates must be finite numbers`);
  }
  validateSize(rect, name);
}

function validatePoint(point: LayoutPoint, name: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError(`${name} coordinates must be finite numbers`);
  }
}

function validateNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
