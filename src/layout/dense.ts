import type {
  CardinalPlacement,
  LayoutPoint,
  LayoutRect,
  LayoutSize,
  PlacementPreference
} from "./index.js";

export const DENSE_LAYOUT_DIAGNOSTIC_CODES = [
  "INSUFFICIENT_SPACE",
  "TARGET_COVERED",
  "CALLOUT_OVERLAP",
  "LEADER_ROUTE_BLOCKED",
  "LEADER_TOO_SHORT"
] as const;

export type DenseLayoutDiagnosticCode = (typeof DENSE_LAYOUT_DIAGNOSTIC_CODES)[number];

export interface LayoutSegment {
  start: LayoutPoint;
  end: LayoutPoint;
}

export interface RouteObstacle {
  id: string;
  rect: LayoutRect;
  /** Override route clearance for an already-painted obstacle footprint. */
  clearance?: number;
}

export interface LeaderRouteDiagnostic {
  code: "LEADER_ROUTE_BLOCKED";
  collisionIds: string[];
  message: string;
}

export interface LeaderRoute {
  points: LayoutPoint[];
  segments: LayoutSegment[];
  directDistance: number;
  pathLength: number;
  bendCount: number;
  bounds: LayoutRect;
  collisionIds: string[];
  diagnostics: LeaderRouteDiagnostic[];
}

export interface RouteLeaderInput {
  canvas: LayoutSize;
  start: LayoutPoint;
  end: LayoutPoint;
  obstacles?: readonly RouteObstacle[];
  clearance?: number;
  strokeWidth?: number;
  /** Exclude a diagonal direct candidate while retaining straight axis-aligned paths. */
  orthogonalOnly?: boolean;
}

export interface DenseProtectedTarget {
  id: string;
  rect: LayoutRect;
}

export interface DenseCalloutItem {
  id: string;
  target: LayoutRect;
  box: LayoutSize;
  placement?: PlacementPreference;
  /** Override the batch gap for this item, for example to reserve numbered-marker space. */
  gap?: number;
  /** Painted pixels extending beyond each edge of the logical label box. */
  paintedOutset?: number;
  /** Occupied depth extending from the logical label edge toward its target. */
  facingDecorationDepth?: number;
  /** Tangential span of the target-facing decoration, such as a marker diameter. */
  facingDecorationSpan?: number;
}

export interface DenseLayoutDiagnostic {
  code: DenseLayoutDiagnosticCode;
  annotationId: string;
  relatedIds: string[];
  message: string;
}

export interface DenseCalloutPlacement {
  id: string;
  placement: CardinalPlacement;
  /** Logical label box used by the renderer for compositing. */
  box: LayoutRect;
  /** Label box including its painted stroke/shadow outset. */
  paintedBox: LayoutRect;
  /** Complete occupied footprint, including any target-facing decoration. */
  collisionBox: LayoutRect;
  anchor: LayoutPoint;
  targetAnchor: LayoutPoint;
  route: LeaderRoute;
  diagnostics: DenseLayoutDiagnostic[];
}

export interface DenseLayoutScore {
  targetOverlapCount: number;
  calloutOverlapCount: number;
  overflowCount: number;
  targetOverlapArea: number;
  calloutOverlapArea: number;
  overflowArea: number;
  leaderDistance: number;
}

export interface DenseCalloutLayoutInput {
  canvas: LayoutSize;
  items: readonly DenseCalloutItem[];
  protectedTargets?: readonly DenseProtectedTarget[];
  obstacles?: readonly RouteObstacle[];
  margin?: number;
  gap?: number;
  clearance?: number;
  leaderStrokeWidth?: number;
  minimumLeaderLength?: number;
  beamWidth?: number;
}

export interface DenseCalloutLayoutResult {
  placements: DenseCalloutPlacement[];
  diagnostics: DenseLayoutDiagnostic[];
  score: DenseLayoutScore;
}

interface LabelCandidate {
  placement: CardinalPlacement;
  box: LayoutRect;
  paintedBox: LayoutRect;
  collisionBox: LayoutRect;
  overflowArea: number;
  targetOverlapCount: number;
  targetOverlapArea: number;
  leaderDistance: number;
  sideViolation: boolean;
  order: number;
  key: string;
}

interface BeamScore extends DenseLayoutScore {
  placementOrder: number;
  sideViolationCount: number;
}

interface BeamState {
  candidates: LabelCandidate[];
  score: BeamScore;
  signature: string;
}

interface RouteCandidate {
  points: LayoutPoint[];
  segments: LayoutSegment[];
  pathLength: number;
  bendCount: number;
  collisionIds: string[];
  order: number;
  signature: string;
}

const PLACEMENT_ORDER: readonly CardinalPlacement[] = ["top", "right", "bottom", "left"];
const DIAGNOSTIC_ORDER = new Map(
  DENSE_LAYOUT_DIAGNOSTIC_CODES.map((code, index) => [code, index] as const)
);
const EPSILON = 1e-7;
export const MAX_DENSE_CALLOUTS = 200;
export const MAX_DENSE_BEAM_WIDTH = 128;
const MAX_CANDIDATES_PER_ITEM = 128;
const MAX_TARGET_CHANNELS_PER_PLACEMENT = 16;
const MAX_ROUTE_CHANNELS_PER_AXIS = 32;
const MAX_ROUTE_PAIR_CHANNELS = 8;

/**
 * Place a complete set of already-measured labels before routing any leaders.
 * This is intentionally separate from the legacy one-at-a-time `placeCallout` API.
 */
export function layoutDenseCallouts(input: DenseCalloutLayoutInput): DenseCalloutLayoutResult {
  validateCanvas(input.canvas);
  if (input.items.length > MAX_DENSE_CALLOUTS) {
    throw new RangeError(`items must contain at most ${MAX_DENSE_CALLOUTS} callouts`);
  }
  const maximumGeometryValue = Math.max(input.canvas.width, input.canvas.height) * 4;
  const margin = integerOption(input.margin, 8, "margin", 0, maximumGeometryValue);
  const gap = integerOption(input.gap, 14, "gap", 0, maximumGeometryValue);
  const clearance = integerOption(input.clearance, 6, "clearance", 0, maximumGeometryValue);
  const leaderStrokeWidth = finiteOption(
    input.leaderStrokeWidth,
    2,
    "leaderStrokeWidth",
    0,
    maximumGeometryValue
  );
  const minimumLeaderLength = finiteOption(
    input.minimumLeaderLength,
    24,
    "minimumLeaderLength",
    0,
    maximumGeometryValue
  );
  const beamWidth = integerOption(input.beamWidth, 96, "beamWidth", 1, MAX_DENSE_BEAM_WIDTH);
  if (margin * 2 >= input.canvas.width || margin * 2 >= input.canvas.height) {
    throw new RangeError("margin must leave at least one pixel inside the canvas");
  }

  const itemIds = new Set<string>();
  for (const [index, item] of input.items.entries()) {
    validateIdentifier(item.id, `items[${index}].id`);
    if (itemIds.has(item.id))
      throw new RangeError(`Duplicate callout ID ${JSON.stringify(item.id)}.`);
    itemIds.add(item.id);
    validateRect(item.target, `items[${index}].target`);
    validateSize(item.box, `items[${index}].box`);
    optionalFinite(item.gap, `items[${index}].gap`, 0, maximumGeometryValue);
    optionalFinite(item.paintedOutset, `items[${index}].paintedOutset`, 0, maximumGeometryValue);
    optionalFinite(
      item.facingDecorationDepth,
      `items[${index}].facingDecorationDepth`,
      0,
      maximumGeometryValue
    );
    optionalFinite(
      item.facingDecorationSpan,
      `items[${index}].facingDecorationSpan`,
      0,
      maximumGeometryValue
    );
  }
  const suppliedTargets = input.protectedTargets ?? [];
  for (const [index, target] of suppliedTargets.entries()) {
    validateIdentifier(target.id, `protectedTargets[${index}].id`);
    validateRect(target.rect, `protectedTargets[${index}].rect`);
  }
  const fixedObstacles = input.obstacles ?? [];
  for (const [index, obstacle] of fixedObstacles.entries()) {
    validateIdentifier(obstacle.id, `obstacles[${index}].id`);
    validateRect(obstacle.rect, `obstacles[${index}].rect`);
    optionalFinite(obstacle.clearance, `obstacles[${index}].clearance`, 0, maximumGeometryValue);
  }

  if (input.items.length === 0) {
    return { placements: [], diagnostics: [], score: emptyScore() };
  }

  const allTargets: DenseProtectedTarget[] = [
    ...input.items.map((item) => ({ id: item.id, rect: item.target })),
    ...suppliedTargets.map((target) => ({ id: target.id, rect: target.rect }))
  ];
  const effectiveBeamWidth = boundedBeamWidth(beamWidth, input.items.length);
  let beam: BeamState[] = [
    {
      candidates: [],
      score: { ...emptyScore(), placementOrder: 0, sideViolationCount: 0 },
      signature: ""
    }
  ];

  for (const item of input.items) {
    const candidates = createLabelCandidates(
      input.canvas,
      item,
      allTargets,
      input.items.length,
      margin,
      gap,
      clearance
    );
    const expanded: BeamState[] = [];
    for (const state of beam) {
      for (const candidate of candidates) {
        const calloutIntersections = state.candidates.filter(
          (other) => intersectionArea(candidate.collisionBox, other.collisionBox) > 0
        );
        const fixedIntersections = fixedObstacles.filter(
          (obstacle) =>
            intersectionArea(
              candidate.collisionBox,
              inflateRect(obstacle.rect, obstacle.clearance ?? 0)
            ) > 0
        );
        const calloutOverlapArea =
          calloutIntersections.reduce(
            (total, other) => total + intersectionArea(candidate.collisionBox, other.collisionBox),
            0
          ) +
          fixedIntersections.reduce(
            (total, obstacle) =>
              total +
              intersectionArea(
                candidate.collisionBox,
                inflateRect(obstacle.rect, obstacle.clearance ?? 0)
              ),
            0
          );
        const score: BeamScore = {
          targetOverlapCount: state.score.targetOverlapCount + candidate.targetOverlapCount,
          calloutOverlapCount:
            state.score.calloutOverlapCount +
            calloutIntersections.length +
            fixedIntersections.length,
          overflowCount: state.score.overflowCount + Number(candidate.overflowArea > 0),
          targetOverlapArea: state.score.targetOverlapArea + candidate.targetOverlapArea,
          calloutOverlapArea: state.score.calloutOverlapArea + calloutOverlapArea,
          overflowArea: state.score.overflowArea + candidate.overflowArea,
          leaderDistance: state.score.leaderDistance + candidate.leaderDistance,
          placementOrder: state.score.placementOrder + candidate.order,
          sideViolationCount: state.score.sideViolationCount + Number(candidate.sideViolation)
        };
        expanded.push({
          candidates: [...state.candidates, candidate],
          score,
          signature: `${state.signature}|${candidate.key}`
        });
      }
    }
    expanded.sort(compareBeamStates);
    const unique: BeamState[] = [];
    const seen = new Set<string>();
    for (const state of expanded) {
      if (seen.has(state.signature)) continue;
      seen.add(state.signature);
      unique.push(state);
      if (unique.length >= effectiveBeamWidth) break;
    }
    beam = unique;
  }

  const selected = beam[0];
  if (!selected) throw new Error("Dense callout layout did not produce a candidate state.");
  const placements: DenseCalloutPlacement[] = [];

  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index];
    const candidate = selected.candidates[index];
    if (!item || !candidate) throw new Error("Dense callout layout state is incomplete.");
    const anchors = boundaryAnchors(candidate.box, item.target);
    const routeObstacles: RouteObstacle[] = [
      ...fixedObstacles,
      ...selected.candidates.flatMap((other, otherIndex) => {
        const otherItem = input.items[otherIndex];
        return otherItem && otherItem.id !== item.id
          ? [{ id: otherItem.id, rect: other.collisionBox, clearance: 0 }]
          : [];
      }),
      ...allTargets
        .filter(
          (target, targetIndex) =>
            targetIndex !== index && !sameLayoutRect(target.rect, item.target)
        )
        .map((target) => ({
          id: target.id,
          rect: target.rect,
          clearance: 0
        }))
    ];
    const route = routeLeader({
      canvas: input.canvas,
      start: anchors.anchor,
      end: anchors.targetAnchor,
      obstacles: routeObstacles,
      clearance,
      strokeWidth: leaderStrokeWidth
    });
    const placementDiagnostics = placementDiagnosticsFor(
      item,
      candidate,
      index,
      input.items,
      selected.candidates,
      allTargets,
      fixedObstacles,
      route,
      minimumLeaderLength
    );
    placements.push({
      id: item.id,
      placement: candidate.placement,
      box: candidate.box,
      paintedBox: candidate.paintedBox,
      collisionBox: candidate.collisionBox,
      anchor: anchors.anchor,
      targetAnchor: anchors.targetAnchor,
      route,
      diagnostics: placementDiagnostics
    });
  }

  const diagnostics = placements
    .flatMap((placement) => placement.diagnostics)
    .sort((left, right) => compareDiagnostics(left, right, input.items));
  return {
    placements,
    diagnostics,
    score: {
      targetOverlapCount: selected.score.targetOverlapCount,
      calloutOverlapCount: selected.score.calloutOverlapCount,
      overflowCount: selected.score.overflowCount,
      targetOverlapArea: selected.score.targetOverlapArea,
      calloutOverlapArea: selected.score.calloutOverlapArea,
      overflowArea: selected.score.overflowArea,
      leaderDistance: selected.score.leaderDistance
    }
  };
}

/**
 * Route one leader using a deterministic candidate set: direct, HV/VH, then
 * vertical/horizontal doglegs through canvas and obstacle-derived safe channels.
 */
export function routeLeader(input: RouteLeaderInput): LeaderRoute {
  validateCanvas(input.canvas);
  validatePoint(input.start, "start");
  validatePoint(input.end, "end");
  const maximumGeometryValue = Math.max(input.canvas.width, input.canvas.height) * 4;
  const clearance = finiteOption(input.clearance, 4, "clearance", 0, maximumGeometryValue);
  const strokeWidth = finiteOption(input.strokeWidth, 2, "strokeWidth", 0, maximumGeometryValue);
  const obstacles = input.obstacles ?? [];
  for (const [index, obstacle] of obstacles.entries()) {
    validateIdentifier(obstacle.id, `obstacles[${index}].id`);
    validateRect(obstacle.rect, `obstacles[${index}].rect`);
    optionalFinite(obstacle.clearance, `obstacles[${index}].clearance`, 0, maximumGeometryValue);
  }

  const halfStroke = strokeWidth / 2;
  const channelInset = Math.max(halfStroke + 1, 1);
  const xChannels = new Set<number>([
    channelInset,
    input.canvas.width - channelInset,
    ...obstacles.flatMap((obstacle) => [
      obstacle.rect.x - (obstacle.clearance ?? clearance) - halfStroke - 1,
      obstacle.rect.x + obstacle.rect.width + (obstacle.clearance ?? clearance) + halfStroke + 1
    ])
  ]);
  const yChannels = new Set<number>([
    channelInset,
    input.canvas.height - channelInset,
    ...obstacles.flatMap((obstacle) => [
      obstacle.rect.y - (obstacle.clearance ?? clearance) - halfStroke - 1,
      obstacle.rect.y + obstacle.rect.height + (obstacle.clearance ?? clearance) + halfStroke + 1
    ])
  ]);
  const pointCandidates: LayoutPoint[][] = [
    ...(input.orthogonalOnly === true ? [] : [[input.start, input.end]]),
    [input.start, { x: input.end.x, y: input.start.y }, input.end],
    [input.start, { x: input.start.x, y: input.end.y }, input.end]
  ];
  const xRouteChannels = boundedRouteChannels(
    xChannels,
    input.start.x,
    input.end.x,
    channelInset,
    input.canvas.width - channelInset
  );
  const yRouteChannels = boundedRouteChannels(
    yChannels,
    input.start.y,
    input.end.y,
    channelInset,
    input.canvas.height - channelInset
  );
  for (const x of xRouteChannels) {
    pointCandidates.push([input.start, { x, y: input.start.y }, { x, y: input.end.y }, input.end]);
  }
  for (const y of yRouteChannels) {
    pointCandidates.push([input.start, { x: input.start.x, y }, { x: input.end.x, y }, input.end]);
  }
  const pairedChannelLimit = obstacles.length <= 64 ? MAX_ROUTE_PAIR_CHANNELS : 4;
  const pairedXChannels = nearestRouteChannels(
    xRouteChannels,
    input.start.x,
    input.end.x,
    pairedChannelLimit
  );
  const pairedYChannels = nearestRouteChannels(
    yRouteChannels,
    input.start.y,
    input.end.y,
    pairedChannelLimit
  );
  for (const x of pairedXChannels) {
    for (const y of pairedYChannels) {
      pointCandidates.push([
        input.start,
        { x, y: input.start.y },
        { x, y },
        { x: input.end.x, y },
        input.end
      ]);
      pointCandidates.push([
        input.start,
        { x: input.start.x, y },
        { x, y },
        { x, y: input.end.y },
        input.end
      ]);
    }
  }

  const candidates: RouteCandidate[] = [];
  const seen = new Set<string>();
  for (const [order, rawPoints] of pointCandidates.entries()) {
    const points = simplifyPoints(rawPoints);
    const signature = points.map(pointKey).join(";");
    if (seen.has(signature)) continue;
    seen.add(signature);
    const segments = pointsToSegments(points);
    const collisionIds = uniqueSorted(
      obstacles
        .filter((obstacle) =>
          segments.some((segment) =>
            segmentIntersectsRect(
              segment,
              obstacle.rect,
              (obstacle.clearance ?? clearance) + halfStroke
            )
          )
        )
        .map((obstacle) => obstacle.id)
    );
    candidates.push({
      points,
      segments,
      pathLength: segments.reduce((total, segment) => total + segmentLength(segment), 0),
      bendCount: Math.max(0, segments.length - 1),
      collisionIds,
      order,
      signature
    });
  }
  candidates.sort(compareRouteCandidates);
  const selected = candidates[0];
  if (!selected) throw new Error("Leader router did not produce a candidate route.");
  const directDistance = Math.hypot(input.end.x - input.start.x, input.end.y - input.start.y);
  const diagnostics: LeaderRouteDiagnostic[] =
    selected.collisionIds.length === 0
      ? []
      : [
          {
            code: "LEADER_ROUTE_BLOCKED",
            collisionIds: selected.collisionIds,
            message: `No collision-free leader route was available; the least-blocked route intersects ${selected.collisionIds.length} obstacle${selected.collisionIds.length === 1 ? "" : "s"}.`
          }
        ];
  return {
    points: selected.points,
    segments: selected.segments,
    directDistance,
    pathLength: selected.pathLength,
    bendCount: selected.bendCount,
    bounds: routeBounds(selected.points, selected.segments, strokeWidth),
    collisionIds: selected.collisionIds,
    diagnostics
  };
}

function createLabelCandidates(
  canvas: LayoutSize,
  item: DenseCalloutItem,
  targets: readonly DenseProtectedTarget[],
  itemCount: number,
  margin: number,
  gap: number,
  clearance: number
): LabelCandidate[] {
  const placements: readonly CardinalPlacement[] =
    (item.placement ?? "auto") === "auto" ? PLACEMENT_ORDER : [item.placement as CardinalPlacement];
  const tangentialLimit = Math.min(4, Math.max(2, Math.ceil(itemCount / 3)));
  const ringLimit = Math.min(3, Math.max(2, Math.ceil(itemCount / 6)));
  const box = { width: Math.ceil(item.box.width), height: Math.ceil(item.box.height) };
  const itemGap = Math.ceil(item.gap ?? gap);
  const paintedOutset = item.paintedOutset ?? 0;
  const decorationDepth = item.facingDecorationDepth ?? 0;
  const decorationSpan = item.facingDecorationSpan ?? 0;
  const tangentialOffsets = [0];
  for (let offset = 1; offset <= tangentialLimit; offset += 1) {
    tangentialOffsets.push(-offset, offset);
  }
  const result: LabelCandidate[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const placement of placements) {
    const targetDerivedTangentialPositions =
      placement === "top" || placement === "bottom"
        ? [
            ...targets.flatMap((target) => [
              target.rect.x - box.width - clearance,
              target.rect.x + target.rect.width + clearance
            ])
          ]
        : [
            ...targets.flatMap((target) => [
              target.rect.y - box.height - clearance,
              target.rect.y + target.rect.height + clearance
            ])
          ];
    for (let ring = 0; ring < ringLimit; ring += 1) {
      const tangentStep =
        (placement === "top" || placement === "bottom" ? box.width : box.height) + clearance;
      const base = rawLabelPosition(item.target, box, placement, itemGap, clearance, ring);
      const baseTangent = placement === "top" || placement === "bottom" ? base.x : base.y;
      const edgeTangentialPositions =
        placement === "top" || placement === "bottom"
          ? [margin + paintedOutset, canvas.width - margin - paintedOutset - box.width]
          : [margin + paintedOutset, canvas.height - margin - paintedOutset - box.height];
      const extraTangentialPositions = [
        ...edgeTangentialPositions,
        ...nearestDistinctNumbers(
          targetDerivedTangentialPositions,
          baseTangent,
          MAX_TARGET_CHANNELS_PER_PLACEMENT
        )
      ];
      const positions = [
        ...tangentialOffsets.map((offset) =>
          placement === "top" || placement === "bottom"
            ? { x: base.x + offset * tangentStep, y: base.y }
            : { x: base.x, y: base.y + offset * tangentStep }
        ),
        ...extraTangentialPositions.map((position) =>
          placement === "top" || placement === "bottom"
            ? { x: position, y: base.y }
            : { x: base.x, y: position }
        )
      ];
      for (const raw of positions) {
        const rawBox = { ...raw, ...box };
        const candidateBox = clampBoxForFootprint(
          rawBox,
          placement,
          canvas,
          margin,
          paintedOutset,
          decorationDepth,
          decorationSpan
        );
        const paintedBox = inflateRect(candidateBox, paintedOutset);
        const collisionBox = targetFacingCollisionBox(
          placement,
          candidateBox,
          paintedBox,
          decorationDepth,
          decorationSpan
        );
        const key = `${placement}:${rectKey(candidateBox)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let targetOverlapCount = 0;
        let targetOverlapArea = 0;
        for (const target of targets) {
          const area = intersectionArea(collisionBox, target.rect);
          if (area <= 0) continue;
          targetOverlapCount += 1;
          targetOverlapArea += area;
        }
        result.push({
          placement,
          box: candidateBox,
          paintedBox,
          collisionBox,
          overflowArea: overflowArea(collisionBox, canvas, margin),
          targetOverlapCount,
          targetOverlapArea,
          leaderDistance: Math.hypot(
            center(candidateBox).x - center(item.target).x,
            center(candidateBox).y - center(item.target).y
          ),
          sideViolation: violatesPlacementSide(placement, collisionBox, item.target),
          order,
          key
        });
        order += 1;
      }
    }
  }
  return limitLabelCandidates(result, placements, candidateBudget(itemCount));
}

function rawLabelPosition(
  target: LayoutRect,
  box: LayoutSize,
  placement: CardinalPlacement,
  gap: number,
  clearance: number,
  ring: number
): LayoutPoint {
  const targetCenter = center(target);
  switch (placement) {
    case "top":
      return {
        x: Math.round(targetCenter.x - box.width / 2),
        y: Math.round(target.y - gap - box.height - ring * (box.height + clearance))
      };
    case "right":
      return {
        x: Math.round(target.x + target.width + gap + ring * (box.width + clearance)),
        y: Math.round(targetCenter.y - box.height / 2)
      };
    case "bottom":
      return {
        x: Math.round(targetCenter.x - box.width / 2),
        y: Math.round(target.y + target.height + gap + ring * (box.height + clearance))
      };
    case "left":
      return {
        x: Math.round(target.x - gap - box.width - ring * (box.width + clearance)),
        y: Math.round(targetCenter.y - box.height / 2)
      };
  }
}

function candidateBudget(itemCount: number): number {
  if (itemCount <= 10) return MAX_CANDIDATES_PER_ITEM;
  if (itemCount <= 32) return 64;
  if (itemCount <= 96) return 32;
  return 16;
}

function boundedBeamWidth(requestedBeamWidth: number, itemCount: number): number {
  if (itemCount <= 10) return requestedBeamWidth;
  if (itemCount <= 32) return Math.min(requestedBeamWidth, 32);
  if (itemCount <= 96) return Math.min(requestedBeamWidth, 12);
  return Math.min(requestedBeamWidth, 4);
}

function limitLabelCandidates(
  candidates: readonly LabelCandidate[],
  placements: readonly CardinalPlacement[],
  requestedLimit: number
): LabelCandidate[] {
  const limit = Math.max(placements.length, requestedLimit);
  if (candidates.length <= limit) return [...candidates];
  const baseAllocation = Math.floor(limit / placements.length);
  let remainder = limit % placements.length;
  const selected: LabelCandidate[] = [];
  for (const placement of placements) {
    const allocation = baseAllocation + Number(remainder > 0);
    remainder = Math.max(0, remainder - 1);
    selected.push(
      ...candidates
        .filter((candidate) => candidate.placement === placement)
        .sort(compareLocalCandidates)
        .slice(0, allocation)
    );
  }
  return selected.sort((left, right) => left.order - right.order);
}

function compareLocalCandidates(left: LabelCandidate, right: LabelCandidate): number {
  const comparison = compareNumberLists(
    [
      left.targetOverlapCount,
      Number(left.overflowArea > 0),
      Number(left.sideViolation),
      left.targetOverlapArea,
      left.overflowArea,
      left.leaderDistance,
      left.order
    ],
    [
      right.targetOverlapCount,
      Number(right.overflowArea > 0),
      Number(right.sideViolation),
      right.targetOverlapArea,
      right.overflowArea,
      right.leaderDistance,
      right.order
    ]
  );
  return comparison !== 0 ? comparison : left.key.localeCompare(right.key, "en");
}

function nearestDistinctNumbers(
  values: readonly number[],
  origin: number,
  limit: number
): number[] {
  return uniqueNumbers(values)
    .sort((left, right) => Math.abs(left - origin) - Math.abs(right - origin) || left - right)
    .slice(0, limit);
}

function uniqueNumbers(values: readonly number[]): number[] {
  const distinct = new Map<string, number>();
  for (const value of values) {
    const normalized = Number(value.toFixed(3));
    distinct.set(String(normalized), normalized);
  }
  return [...distinct.values()];
}

function clampBoxForFootprint(
  rawBox: LayoutRect,
  placement: CardinalPlacement,
  canvas: LayoutSize,
  margin: number,
  paintedOutset: number,
  decorationDepth: number,
  decorationSpan: number
): LayoutRect {
  const rawPaintedBox = inflateRect(rawBox, paintedOutset);
  const rawCollisionBox = targetFacingCollisionBox(
    placement,
    rawBox,
    rawPaintedBox,
    decorationDepth,
    decorationSpan
  );
  const relativeLeft = rawCollisionBox.x - rawBox.x;
  const relativeTop = rawCollisionBox.y - rawBox.y;
  const relativeRight = rawCollisionBox.x + rawCollisionBox.width - (rawBox.x + rawBox.width);
  const relativeBottom = rawCollisionBox.y + rawCollisionBox.height - (rawBox.y + rawBox.height);
  return {
    x: clampFootprintAxis(
      rawBox.x,
      Math.ceil(margin - relativeLeft),
      Math.floor(canvas.width - margin - rawBox.width - relativeRight),
      margin,
      canvas.width - margin - rawBox.width
    ),
    y: clampFootprintAxis(
      rawBox.y,
      Math.ceil(margin - relativeTop),
      Math.floor(canvas.height - margin - rawBox.height - relativeBottom),
      margin,
      canvas.height - margin - rawBox.height
    ),
    width: rawBox.width,
    height: rawBox.height
  };
}

function clampFootprintAxis(
  rawPosition: number,
  footprintMinimum: number,
  footprintMaximum: number,
  logicalMinimum: number,
  logicalMaximum: number
): number {
  const rounded = Math.round(rawPosition);
  if (footprintMaximum >= footprintMinimum) {
    return clamp(rounded, footprintMinimum, footprintMaximum);
  }
  if (logicalMaximum >= logicalMinimum) {
    return clamp(rounded, logicalMinimum, logicalMaximum);
  }
  return logicalMinimum;
}

function inflateRect(rect: LayoutRect, outset: number): LayoutRect {
  return {
    x: rect.x - outset,
    y: rect.y - outset,
    width: rect.width + outset * 2,
    height: rect.height + outset * 2
  };
}

function targetFacingCollisionBox(
  placement: CardinalPlacement,
  logicalBox: LayoutRect,
  paintedBox: LayoutRect,
  depth: number,
  span: number
): LayoutRect {
  if (depth <= 0 || span <= 0) return paintedBox;
  const boxCenter = center(logicalBox);
  const decoration: LayoutRect = (() => {
    switch (placement) {
      case "top":
        return {
          x: boxCenter.x - span / 2,
          y: logicalBox.y + logicalBox.height,
          width: span,
          height: depth
        };
      case "right":
        return {
          x: logicalBox.x - depth,
          y: boxCenter.y - span / 2,
          width: depth,
          height: span
        };
      case "bottom":
        return {
          x: boxCenter.x - span / 2,
          y: logicalBox.y - depth,
          width: span,
          height: depth
        };
      case "left":
        return {
          x: logicalBox.x + logicalBox.width,
          y: boxCenter.y - span / 2,
          width: depth,
          height: span
        };
    }
  })();
  return unionRects(paintedBox, decoration);
}

function violatesPlacementSide(
  placement: CardinalPlacement,
  collisionBox: LayoutRect,
  target: LayoutRect
): boolean {
  switch (placement) {
    case "top":
      return collisionBox.y + collisionBox.height > target.y + EPSILON;
    case "right":
      return collisionBox.x < target.x + target.width - EPSILON;
    case "bottom":
      return collisionBox.y < target.y + target.height - EPSILON;
    case "left":
      return collisionBox.x + collisionBox.width > target.x + EPSILON;
  }
}

function unionRects(left: LayoutRect, right: LayoutRect): LayoutRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maximumX = Math.max(left.x + left.width, right.x + right.width);
  const maximumY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maximumX - x, height: maximumY - y };
}

function placementDiagnosticsFor(
  item: DenseCalloutItem,
  candidate: LabelCandidate,
  itemIndex: number,
  items: readonly DenseCalloutItem[],
  candidates: readonly LabelCandidate[],
  targets: readonly DenseProtectedTarget[],
  fixedObstacles: readonly RouteObstacle[],
  route: LeaderRoute,
  minimumLeaderLength: number
): DenseLayoutDiagnostic[] {
  const diagnostics: DenseLayoutDiagnostic[] = [];
  const targetIds = uniqueSorted(
    targets
      .filter((target) => intersectionArea(candidate.collisionBox, target.rect) > 0)
      .map((target) => target.id)
  );
  const calloutIds = uniqueSorted([
    ...candidates.flatMap((other, otherIndex) => {
      if (
        otherIndex === itemIndex ||
        intersectionArea(candidate.collisionBox, other.collisionBox) <= 0
      ) {
        return [];
      }
      const otherItem = items[otherIndex];
      return otherItem === undefined ? [] : [otherItem.id];
    }),
    ...fixedObstacles
      .filter(
        (obstacle) =>
          intersectionArea(
            candidate.collisionBox,
            inflateRect(obstacle.rect, obstacle.clearance ?? 0)
          ) > 0
      )
      .map((obstacle) => obstacle.id)
  ]);
  if (targetIds.length > 0) {
    diagnostics.push({
      code: "TARGET_COVERED",
      annotationId: item.id,
      relatedIds: targetIds,
      message: `Callout ${item.id} covers ${targetIds.length} protected target${targetIds.length === 1 ? "" : "s"}.`
    });
  }
  if (calloutIds.length > 0) {
    diagnostics.push({
      code: "CALLOUT_OVERLAP",
      annotationId: item.id,
      relatedIds: calloutIds,
      message: `Callout ${item.id} overlaps ${calloutIds.length} protected label or obstacle${calloutIds.length === 1 ? "" : "s"}.`
    });
  }
  if (
    candidate.overflowArea > 0 ||
    candidate.sideViolation ||
    targetIds.length > 0 ||
    calloutIds.length > 0
  ) {
    diagnostics.push({
      code: "INSUFFICIENT_SPACE",
      annotationId: item.id,
      relatedIds: uniqueSorted([...targetIds, ...calloutIds]),
      message: `Callout ${item.id} could not satisfy all canvas, target, and callout clearances.`
    });
  }
  if (route.collisionIds.length > 0) {
    diagnostics.push({
      code: "LEADER_ROUTE_BLOCKED",
      annotationId: item.id,
      relatedIds: route.collisionIds,
      message: `Callout ${item.id} has no collision-free leader route.`
    });
  }
  if (route.pathLength + EPSILON < minimumLeaderLength) {
    diagnostics.push({
      code: "LEADER_TOO_SHORT",
      annotationId: item.id,
      relatedIds: [],
      message: `Callout ${item.id} has only ${Number(route.pathLength.toFixed(1))}px of visible leader; ${minimumLeaderLength}px was requested.`
    });
  }
  return diagnostics.sort(
    (left, right) =>
      (DIAGNOSTIC_ORDER.get(left.code) ?? 0) - (DIAGNOSTIC_ORDER.get(right.code) ?? 0)
  );
}

function boundaryAnchors(
  box: LayoutRect,
  target: LayoutRect
): { anchor: LayoutPoint; targetAnchor: LayoutPoint } {
  const boxCenter = center(box);
  const targetCenter = center(target);
  return {
    anchor: boundaryPoint(box, targetCenter),
    targetAnchor: boundaryPoint(target, boxCenter)
  };
}

function boundaryPoint(rect: LayoutRect, toward: LayoutPoint): LayoutPoint {
  const origin = center(rect);
  const deltaX = toward.x - origin.x;
  const deltaY = toward.y - origin.y;
  if (Math.abs(deltaX) < EPSILON && Math.abs(deltaY) < EPSILON) {
    return { x: origin.x, y: rect.y };
  }
  const scale =
    1 / Math.max(Math.abs(deltaX) / (rect.width / 2), Math.abs(deltaY) / (rect.height / 2));
  return { x: origin.x + deltaX * scale, y: origin.y + deltaY * scale };
}

function compareBeamStates(left: BeamState, right: BeamState): number {
  const scoreComparison = compareNumberLists(
    beamScoreTuple(left.score),
    beamScoreTuple(right.score)
  );
  return scoreComparison !== 0
    ? scoreComparison
    : left.signature.localeCompare(right.signature, "en");
}

function beamScoreTuple(score: BeamScore): number[] {
  return [
    score.targetOverlapCount,
    score.calloutOverlapCount,
    score.overflowCount,
    score.sideViolationCount,
    score.targetOverlapArea,
    score.calloutOverlapArea,
    score.overflowArea,
    score.leaderDistance,
    score.placementOrder
  ];
}

function compareRouteCandidates(left: RouteCandidate, right: RouteCandidate): number {
  const comparison = compareNumberLists(
    [left.collisionIds.length, left.bendCount, left.pathLength, left.order],
    [right.collisionIds.length, right.bendCount, right.pathLength, right.order]
  );
  return comparison !== 0 ? comparison : left.signature.localeCompare(right.signature, "en");
}

function boundedRouteChannels(
  channels: ReadonlySet<number>,
  start: number,
  end: number,
  minimum: number,
  maximum: number
): number[] {
  const inside = [...channels].filter((channel) => channel >= minimum && channel <= maximum);
  const boundary = uniqueNumbers(
    inside.filter(
      (channel) => Math.abs(channel - minimum) < EPSILON || Math.abs(channel - maximum) < EPSILON
    )
  );
  const ranked = nearestRouteChannels(
    inside.filter((channel) => !boundary.includes(channel)),
    start,
    end,
    Math.max(0, MAX_ROUTE_CHANNELS_PER_AXIS - boundary.length)
  );
  return uniqueNumbers([...boundary, ...ranked]).sort((left, right) => left - right);
}

function nearestRouteChannels(
  channels: readonly number[],
  start: number,
  end: number,
  limit: number
): number[] {
  const midpoint = (start + end) / 2;
  return [...channels]
    .sort((left, right) => {
      const leftDetour = Math.abs(left - start) + Math.abs(end - left);
      const rightDetour = Math.abs(right - start) + Math.abs(end - right);
      return (
        leftDetour - rightDetour ||
        Math.abs(left - midpoint) - Math.abs(right - midpoint) ||
        left - right
      );
    })
    .slice(0, limit);
}

function compareDiagnostics(
  left: DenseLayoutDiagnostic,
  right: DenseLayoutDiagnostic,
  items: readonly DenseCalloutItem[]
): number {
  const leftIndex = items.findIndex((item) => item.id === left.annotationId);
  const rightIndex = items.findIndex((item) => item.id === right.annotationId);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  return (DIAGNOSTIC_ORDER.get(left.code) ?? 0) - (DIAGNOSTIC_ORDER.get(right.code) ?? 0);
}

function compareNumberLists(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (Math.abs(difference) > EPSILON) return difference;
  }
  return 0;
}

function simplifyPoints(points: readonly LayoutPoint[]): LayoutPoint[] {
  const unique: LayoutPoint[] = [];
  for (const point of points) {
    const previous = unique.at(-1);
    if (
      !previous ||
      Math.abs(previous.x - point.x) > EPSILON ||
      Math.abs(previous.y - point.y) > EPSILON
    ) {
      unique.push({ x: point.x, y: point.y });
    }
  }
  const simplified: LayoutPoint[] = [];
  for (const point of unique) {
    while (simplified.length >= 2) {
      const first = simplified.at(-2);
      const second = simplified.at(-1);
      if (!first || !second || !collinear(first, second, point)) break;
      simplified.pop();
    }
    simplified.push(point);
  }
  return simplified;
}

function collinear(first: LayoutPoint, second: LayoutPoint, third: LayoutPoint): boolean {
  return (
    Math.abs(
      (second.x - first.x) * (third.y - second.y) - (second.y - first.y) * (third.x - second.x)
    ) < EPSILON
  );
}

function pointsToSegments(points: readonly LayoutPoint[]): LayoutSegment[] {
  const segments: LayoutSegment[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (start && end) segments.push({ start, end });
  }
  return segments;
}

function segmentIntersectsRect(
  segment: LayoutSegment,
  rect: LayoutRect,
  inflation: number
): boolean {
  const left = rect.x - inflation;
  const right = rect.x + rect.width + inflation;
  const top = rect.y - inflation;
  const bottom = rect.y + rect.height + inflation;
  const deltaX = segment.end.x - segment.start.x;
  const deltaY = segment.end.y - segment.start.y;
  const xInterval = openAxisInterval(segment.start.x, deltaX, left, right);
  const yInterval = openAxisInterval(segment.start.y, deltaY, top, bottom);
  if (xInterval === undefined || yInterval === undefined) return false;
  const minimum = Math.max(0, xInterval[0], yInterval[0]);
  const maximum = Math.min(1, xInterval[1], yInterval[1]);
  return minimum + EPSILON < maximum;
}

function openAxisInterval(
  start: number,
  delta: number,
  minimum: number,
  maximum: number
): readonly [number, number] | undefined {
  if (Math.abs(delta) < EPSILON) {
    return start > minimum && start < maximum
      ? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
      : undefined;
  }
  const first = (minimum - start) / delta;
  const second = (maximum - start) / delta;
  return first < second ? [first, second] : [second, first];
}

function routeBounds(
  points: readonly LayoutPoint[],
  segments: readonly LayoutSegment[],
  strokeWidth: number
): LayoutRect {
  if (segments.length === 0) {
    const point = points[0] ?? { x: 0, y: 0 };
    const radius = Math.max(0.5, strokeWidth / 2);
    return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
  }
  const boxes = segments.map((segment) => segmentBounds(segment, strokeWidth));
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function segmentBounds(segment: LayoutSegment, strokeWidth: number): LayoutRect {
  const radius = Math.max(0.5, strokeWidth / 2);
  return {
    x: Math.min(segment.start.x, segment.end.x) - radius,
    y: Math.min(segment.start.y, segment.end.y) - radius,
    width: Math.abs(segment.end.x - segment.start.x) + radius * 2,
    height: Math.abs(segment.end.y - segment.start.y) + radius * 2
  };
}

function segmentLength(segment: LayoutSegment): number {
  return Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y);
}

function overflowArea(rect: LayoutRect, canvas: LayoutSize, margin: number): number {
  const allowed = {
    x: margin,
    y: margin,
    width: canvas.width - margin * 2,
    height: canvas.height - margin * 2
  };
  return rect.width * rect.height - intersectionArea(rect, allowed);
}

function intersectionArea(left: LayoutRect, right: LayoutRect): number {
  return (
    Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)) *
    Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  );
}

function sameLayoutRect(left: LayoutRect, right: LayoutRect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function center(rect: LayoutRect): LayoutPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function emptyScore(): DenseLayoutScore {
  return {
    targetOverlapCount: 0,
    calloutOverlapCount: 0,
    overflowCount: 0,
    targetOverlapArea: 0,
    calloutOverlapArea: 0,
    overflowArea: 0,
    leaderDistance: 0
  };
}

function pointKey(point: LayoutPoint): string {
  return `${Number(point.x.toFixed(3))},${Number(point.y.toFixed(3))}`;
}

function rectKey(rect: LayoutRect): string {
  return `${pointKey(rect)}:${Number(rect.width.toFixed(3))},${Number(rect.height.toFixed(3))}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
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
  validatePoint(rect, name);
  validateSize(rect, name);
}

function validatePoint(point: LayoutPoint, name: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError(`${name} coordinates must be finite numbers`);
  }
}

function validateIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`${name} must be a non-empty string`);
  }
}

function finiteOption(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY
): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new RangeError(`${name} must be a finite number between ${minimum} and ${maximum}`);
  }
  return result;
}

function optionalFinite(
  value: number | undefined,
  name: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY
): void {
  if (value !== undefined) finiteOption(value, value, name, minimum, maximum);
}

function integerOption(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY
): number {
  const result = finiteOption(value, fallback, name, minimum, maximum);
  if (!Number.isInteger(result)) throw new RangeError(`${name} must be an integer`);
  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
