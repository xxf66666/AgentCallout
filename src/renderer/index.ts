import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp, { type OverlayOptions, type PngOptions } from "sharp";

import {
  circleOverlapsTarget,
  connectCircleToTarget,
  layoutDenseCallouts,
  placeCallout,
  routeLeader,
  type CardinalPlacement,
  type DenseCalloutPlacement,
  type DenseLayoutDiagnostic,
  type DenseLayoutDiagnosticCode,
  type LeaderRoute,
  type RouteObstacle
} from "../layout/index.js";

export const RENDERER_NAME = "sharp-svg-pango";
export const RENDERER_VERSION = "0.2.1";
export const BUNDLED_FONT_FILENAME = "NotoSansCJKsc-Regular.otf";
export const BUNDLED_FONT_SHA256 =
  "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b";

export const STABLE_PNG_OPTIONS: PngOptions = Object.freeze({
  adaptiveFiltering: false,
  compressionLevel: 9,
  force: true,
  palette: false,
  progressive: false
});

export interface PixelPoint {
  x: number;
  y: number;
}

export interface PixelRect extends PixelPoint {
  width: number;
  height: number;
}

export interface RendererVersions {
  name: string;
  version: string;
  sharp: string;
  libvips: string;
  font: {
    family: string;
    file: string;
    version: string;
    sha256: string;
  };
}

export interface RenderAnnotationsOptions {
  fontPath?: string;
  limitInputPixels?: number;
  specVersion?: "1.0" | "1.1";
}

export interface RenderAnnotationsResult {
  buffer: Buffer;
  width: number;
  height: number;
  warnings: string[];
  usesBlur: boolean;
  usesRedact: boolean;
  resolvedAnnotations: Record<string, unknown>[];
  renderer: RendererVersions;
}

interface RenderStyle {
  strokeColor: string;
  fillColor: string;
  textColor: string;
  backgroundColor: string;
  markerStrokeColor?: string;
  markerFillColor?: string;
  markerTextColor?: string;
  strokeWidth: number;
  fontSize: number;
  opacity: number;
  padding: number;
  blurSigma: number;
  maxWidth: number;
  cornerRadius: number;
  lineHeight: number;
  arrowHeadSize: number;
}

interface RenderableAnnotation {
  id: string;
  type:
    | "rectangle"
    | "ellipse"
    | "arrow"
    | "text"
    | "callout"
    | "numbered-callout"
    | "highlight"
    | "spotlight"
    | "blur"
    | "redact";
  rect?: PixelRect;
  position?: PixelPoint;
  start?: PixelPoint;
  target?: PixelPoint | PixelRect;
  text?: string;
  number?: number;
  placement?: "auto" | "top" | "right" | "bottom" | "left";
  style: RenderStyle;
}

interface TextSprite {
  buffer: Buffer;
  width: number;
  height: number;
  fontSize: number;
  wasShrunk: boolean;
  wasClipped: boolean;
  unclippedDimensions: { width: number; height: number };
  clippedAlphaPixelCount: number;
}

export interface PaintedSegment {
  start: PixelPoint;
  end: PixelPoint;
  strokeWidth: number;
}

interface OccupiedGeometry {
  annotationId: string;
  rects: PixelRect[];
  segments: PaintedSegment[];
}

interface NumberedGeometryCandidate {
  placement: CardinalPlacement;
  placementOrder: number;
  faceOrder: number;
  box: PixelRect;
  paintedLabelBox: PixelRect;
  marker: {
    center: PixelPoint;
    radius: number;
    paintedRadius: number;
    strokeWidth: number;
    labelSide: CardinalPlacement;
  };
  markerBox: PixelRect;
  leader: { start: PixelPoint; end: PixelPoint; length: number };
  leaderBox?: PixelRect;
  leaderSegment?: PaintedSegment;
  collisionIds: string[];
  decorationOverflow: boolean;
  hardCollisionCount: number;
  labelTargetOverlap: boolean;
  markerLabelOverlap: boolean;
  markerTargetOverlap: boolean;
  labelClipped: boolean;
  markerClipped: boolean;
  leaderClipped: boolean;
  placementWarnings: string[];
  placementScore: number;
  markerWasClamped: boolean;
  preferredFace: CardinalPlacement;
}

type RendererLayoutIssueCode =
  DenseLayoutDiagnosticCode | "TEXT_CLIPPED" | "TEXT_SIZE_REDUCED" | "GEOMETRY_CLIPPED";

interface RendererLayoutIssue {
  code: RendererLayoutIssueCode;
  annotationId: string;
  relatedIds: string[];
  message: string;
  metrics?: Record<string, number>;
}

interface PreparedTextAnnotation {
  annotation: RenderableAnnotation;
  position: PixelPoint;
  box: PixelRect;
  sprite: TextSprite;
  issues: RendererLayoutIssue[];
}

interface PreparedMarker {
  center: PixelPoint;
  radius: number;
  paintedRadius: number;
  strokeWidth: number;
  labelSide: CardinalPlacement;
  bounds: PixelRect;
}

interface PreparedDenseAnnotation {
  annotation: RenderableAnnotation;
  target: PixelPoint | PixelRect;
  layoutTarget: PixelRect;
  text: string;
  number?: number;
  padding: number;
  sprite: TextSprite;
  labelStrokeWidth: number;
  leaderStrokeWidth: number;
  placement: DenseCalloutPlacement;
  paintedLabelBox: PixelRect;
  marker?: PreparedMarker;
  route: LeaderRoute;
  arrowHead?: PreparedArrowAnnotation["arrowHead"];
  issues: RendererLayoutIssue[];
}

interface PreparedArrowAnnotation {
  annotation: RenderableAnnotation;
  start: PixelPoint;
  target: PixelPoint | PixelRect;
  end: PixelPoint;
  route: LeaderRoute;
  arrowHead: {
    tip: PixelPoint;
    wings: [PixelPoint, PixelPoint];
    bounds: PixelRect;
  };
  issues: RendererLayoutIssue[];
}

interface ArrowRouteEndpointCandidate {
  end: PixelPoint;
  approach?: PixelPoint;
  ownTarget?: RouteObstacle;
}

interface Version11LayoutPlan {
  text: Map<string, PreparedTextAnnotation>;
  dense: Map<string, PreparedDenseAnnotation>;
  arrows: Map<string, PreparedArrowAnnotation>;
  warnings: string[];
}

interface DenseAnnotationMeasurement {
  annotation: RenderableAnnotation;
  target: PixelPoint | PixelRect;
  layoutTarget: PixelRect;
  text: string;
  number?: number;
  padding: number;
  sprite: TextSprite;
  labelStrokeWidth: number;
  leaderStrokeWidth: number;
  labelWidth: number;
  labelHeight: number;
  gap: number;
  paintedOutset: number;
  facingDecorationDepth: number;
  facingDecorationSpan: number;
  markerSize?: ReturnType<typeof numberedMarkerRadius>;
  issues: RendererLayoutIssue[];
}

interface ArrowMeasurement {
  annotation: RenderableAnnotation;
  start: PixelPoint;
  target: PixelPoint | PixelRect;
  end: PixelPoint;
}

const DEFAULT_STROKE = "#ff2d20";
const DEFAULT_TEXT = "#ffffff";
const MINIMUM_VISIBLE_NUMBERED_LEADER = 24;
const NUMBERED_LEADER_RENDERING_ALLOWANCE = 2;
const DEFAULT_BACKGROUND = "#d7263d";
const TRANSPARENT = "#00000000";
const SAFE_NAMED_COLORS = new Set([
  "black",
  "blue",
  "gray",
  "green",
  "grey",
  "orange",
  "purple",
  "red",
  "transparent",
  "white",
  "yellow"
]);

let bundledFontPathPromise: Promise<string> | undefined;
let bundledFontInfoPromise: Promise<RendererVersions["font"]> | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = finite(value);
  return numeric === undefined ? fallback : Math.min(maximum, Math.max(minimum, numeric));
}

function safeColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const candidate = value.trim().toLowerCase();
  if (/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}(?:[0-9a-f]{2})?)$/.test(candidate)) {
    return candidate;
  }
  return SAFE_NAMED_COLORS.has(candidate) ? candidate : fallback;
}

function opaqueColor(value: string): string {
  if (/^#[0-9a-f]{8}$/i.test(value)) {
    return value.slice(0, 7);
  }
  if (/^#[0-9a-f]{4}$/i.test(value)) {
    return value.slice(0, 4);
  }
  return value === "transparent" ? "#000000" : value;
}

function normalizeStyle(
  annotation: Record<string, unknown>,
  type: RenderableAnnotation["type"]
): RenderStyle {
  const style = asRecord(annotation.style) ?? {};
  const defaultFill =
    type === "highlight" ? "#ffeb3b" : type === "redact" ? "#000000" : TRANSPARENT;
  const defaultOpacity = type === "highlight" ? 0.36 : type === "spotlight" ? 0.62 : 1;
  const strokeColor = safeColor(style.strokeColor ?? style.color, DEFAULT_STROKE);
  const textColor = safeColor(style.textColor, DEFAULT_TEXT);
  const backgroundColor = safeColor(style.backgroundColor, DEFAULT_BACKGROUND);
  const normalized: RenderStyle = {
    strokeColor,
    fillColor: safeColor(annotation.color ?? style.fillColor ?? style.fill, defaultFill),
    textColor,
    backgroundColor,
    strokeWidth: boundedNumber(style.strokeWidth, 4, 0, 64),
    fontSize: boundedNumber(style.fontSize, 22, 6, 256),
    opacity: boundedNumber(style.opacity, defaultOpacity, 0, 1),
    padding: boundedNumber(style.padding, 10, 0, 128),
    blurSigma: boundedNumber(annotation.sigma ?? style.blurSigma ?? style.sigma, 10, 0.3, 1_000),
    maxWidth: boundedNumber(style.maxWidth, 360, 48, 4096),
    cornerRadius: boundedNumber(style.cornerRadius, 6, 0, 256),
    lineHeight: boundedNumber(style.lineHeight, 1.25, 1, 3),
    arrowHeadSize: boundedNumber(style.arrowHeadSize, 12, 1, 128)
  };
  if (style.markerStrokeColor !== undefined) {
    normalized.markerStrokeColor = safeColor(style.markerStrokeColor, strokeColor);
  }
  if (style.markerFillColor !== undefined) {
    normalized.markerFillColor = safeColor(style.markerFillColor, backgroundColor);
  }
  if (style.markerTextColor !== undefined) {
    normalized.markerTextColor = safeColor(style.markerTextColor, textColor);
  }
  return normalized;
}

function pointFrom(value: unknown): PixelPoint | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const x = finite(record.x);
  const y = finite(record.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function rectFrom(value: unknown): PixelRect | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const x = finite(record.x);
  const y = finite(record.y);
  const width = finite(record.width);
  const height = finite(record.height);
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
}

function targetFrom(value: unknown, index: number): PixelPoint | PixelRect | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) {
    throw new Error(`Annotation at index ${index} target must be a point or rectangle object.`);
  }
  const hasWidth = Object.prototype.hasOwnProperty.call(record, "width");
  const hasHeight = Object.prototype.hasOwnProperty.call(record, "height");
  if (hasWidth !== hasHeight) {
    throw new Error(
      `Annotation at index ${index} target must contain both width and height, or neither.`
    );
  }
  const expectedKeys = hasWidth ? ["height", "width", "x", "y"] : ["x", "y"];
  if (Object.keys(record).sort().join(",") !== expectedKeys.join(",")) {
    throw new Error(
      `Annotation at index ${index} target must contain only ${hasWidth ? "x, y, width, and height" : "x and y"}.`
    );
  }
  const target = hasWidth ? rectFrom(record) : pointFrom(record);
  if (!target) {
    throw new Error(`Annotation at index ${index} target coordinates must be finite numbers.`);
  }
  if (isPixelRect(target) && (target.width <= 0 || target.height <= 0)) {
    throw new Error(`Annotation at index ${index} target width and height must be positive.`);
  }
  return target;
}

function normalizeType(value: unknown): RenderableAnnotation["type"] | undefined {
  if (typeof value !== "string") return undefined;
  const type = value.trim().replaceAll("_", "-").toLowerCase();
  if (type === "numberedcallout" || type === "number-callout") return "numbered-callout";
  if (
    type === "rectangle" ||
    type === "ellipse" ||
    type === "arrow" ||
    type === "text" ||
    type === "callout" ||
    type === "numbered-callout" ||
    type === "highlight" ||
    type === "spotlight" ||
    type === "blur" ||
    type === "redact"
  ) {
    return type;
  }
  return undefined;
}

function normalizePlacement(value: unknown): RenderableAnnotation["placement"] | undefined {
  return value === "auto" ||
    value === "top" ||
    value === "right" ||
    value === "bottom" ||
    value === "left"
    ? value
    : undefined;
}

function normalizeAnnotation(value: unknown, index: number): RenderableAnnotation {
  const annotation = asRecord(value);
  if (!annotation) {
    throw new Error(`Annotation at index ${index} must be an object.`);
  }
  const type = normalizeType(annotation.type);
  if (!type) {
    throw new Error(`Annotation at index ${index} has an unsupported type.`);
  }
  const geometry = asRecord(annotation.geometry) ?? {};
  const targetValue = annotation.target ?? geometry.target;
  const target = targetFrom(targetValue, index);
  const rawNumber = finite(annotation.number ?? geometry.number);
  const text = annotation.text ?? geometry.text;
  const result: RenderableAnnotation = {
    id:
      typeof annotation.id === "string" && annotation.id.length > 0
        ? annotation.id
        : `annotation-${index + 1}`,
    type,
    style: normalizeStyle(annotation, type)
  };
  const rect = rectFrom(annotation.rect) ?? rectFrom(geometry.rect) ?? rectFrom(geometry);
  const position =
    pointFrom(annotation.position) ??
    pointFrom(geometry.position) ??
    (type === "text" ? pointFrom(geometry) : undefined);
  const start = pointFrom(annotation.start) ?? pointFrom(geometry.start);
  const placement = normalizePlacement(annotation.placement ?? geometry.placement);
  if (rect) result.rect = rect;
  if (position) result.position = position;
  if (start) result.start = start;
  if (target) result.target = target;
  if (typeof text === "string") result.text = text;
  if (rawNumber !== undefined) result.number = Math.max(1, Math.round(rawNumber));
  if (placement) result.placement = placement;
  return result;
}

function pointInCanvas(point: PixelPoint, width: number, height: number): PixelPoint {
  return {
    x: Math.min(width - 1, Math.max(0, Math.round(point.x))),
    y: Math.min(height - 1, Math.max(0, Math.round(point.y)))
  };
}

function integerRect(rect: PixelRect, width: number, height: number): PixelRect {
  const left = Math.min(width - 1, Math.max(0, Math.round(rect.x)));
  const top = Math.min(height - 1, Math.max(0, Math.round(rect.y)));
  const right = Math.min(width, Math.max(left + 1, Math.round(rect.x + rect.width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.round(rect.y + rect.height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function targetPoint(target: PixelPoint | PixelRect | undefined): PixelPoint | undefined {
  if (!target) return undefined;
  return isPixelRect(target)
    ? { x: target.x + target.width / 2, y: target.y + target.height / 2 }
    : target;
}

function targetRect(target: PixelPoint | PixelRect | undefined): PixelRect | undefined {
  if (!target) return undefined;
  return isPixelRect(target) ? target : { x: target.x - 2, y: target.y - 2, width: 4, height: 4 };
}

function isPixelRect(value: PixelPoint | PixelRect): value is PixelRect {
  return "width" in value && "height" in value;
}

function arrowEndpointOnRect(start: PixelPoint, rect: PixelRect): PixelPoint {
  const center = targetPoint(rect);
  if (!center) return start;
  const vectorX = start.x - center.x;
  const vectorY = start.y - center.y;
  if (vectorX === 0 && vectorY === 0) return center;
  const halfWidth = Math.max(0.5, rect.width / 2);
  const halfHeight = Math.max(0.5, rect.height / 2);
  const scale = 1 / Math.max(Math.abs(vectorX) / halfWidth, Math.abs(vectorY) / halfHeight);
  return {
    x: center.x + vectorX * scale,
    y: center.y + vectorY * scale
  };
}

function escapePango(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function svgNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Cannot encode a non-finite SVG number.");
  return Number(value.toFixed(3)).toString();
}

function controlledSvg(width: number, height: number, body: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
  );
}

function rectangleBody(rect: PixelRect, style: RenderStyle, radius = 0): string {
  return `<rect x="${svgNumber(rect.x)}" y="${svgNumber(rect.y)}" width="${svgNumber(rect.width)}" height="${svgNumber(rect.height)}" rx="${svgNumber(radius)}" fill="${style.fillColor}" fill-opacity="${svgNumber(style.opacity)}" stroke="${style.strokeColor}" stroke-opacity="${svgNumber(style.opacity)}" stroke-width="${svgNumber(style.strokeWidth)}"/>`;
}

function ellipseBody(rect: PixelRect, style: RenderStyle): string {
  return `<ellipse cx="${svgNumber(rect.x + rect.width / 2)}" cy="${svgNumber(rect.y + rect.height / 2)}" rx="${svgNumber(rect.width / 2)}" ry="${svgNumber(rect.height / 2)}" fill="${style.fillColor}" fill-opacity="${svgNumber(style.opacity)}" stroke="${style.strokeColor}" stroke-opacity="${svgNumber(style.opacity)}" stroke-width="${svgNumber(style.strokeWidth)}"/>`;
}

function arrowBody(start: PixelPoint, end: PixelPoint, style: RenderStyle): string {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const headLength = Math.max(style.arrowHeadSize, style.strokeWidth * 2);
  const wing = Math.PI / 7;
  const first = {
    x: end.x - headLength * Math.cos(angle - wing),
    y: end.y - headLength * Math.sin(angle - wing)
  };
  const second = {
    x: end.x - headLength * Math.cos(angle + wing),
    y: end.y - headLength * Math.sin(angle + wing)
  };
  return `<path d="M ${svgNumber(start.x)} ${svgNumber(start.y)} L ${svgNumber(end.x)} ${svgNumber(end.y)}" fill="none" stroke="${style.strokeColor}" stroke-opacity="${svgNumber(style.opacity)}" stroke-width="${svgNumber(style.strokeWidth)}" stroke-linecap="round"/><path d="M ${svgNumber(end.x)} ${svgNumber(end.y)} L ${svgNumber(first.x)} ${svgNumber(first.y)} L ${svgNumber(second.x)} ${svgNumber(second.y)} Z" fill="${style.strokeColor}" fill-opacity="${svgNumber(style.opacity)}"/>`;
}

function leaderBody(start: PixelPoint, end: PixelPoint, style: RenderStyle): string {
  return `<path d="M ${svgNumber(start.x)} ${svgNumber(start.y)} L ${svgNumber(end.x)} ${svgNumber(end.y)}" fill="none" stroke="${style.strokeColor}" stroke-opacity="${svgNumber(style.opacity)}" stroke-width="${svgNumber(style.strokeWidth)}" stroke-linecap="round"/>`;
}

function routedPathData(points: readonly PixelPoint[]): string {
  if (points.length < 2) throw new Error("A routed path requires at least two points.");
  return points
    .map((point, index) =>
      index === 0
        ? `M ${svgNumber(point.x)} ${svgNumber(point.y)}`
        : `L ${svgNumber(point.x)} ${svgNumber(point.y)}`
    )
    .join(" ");
}

function routedLeaderBody(points: readonly PixelPoint[], style: RenderStyle): string {
  return `<path d="${routedPathData(points)}" fill="none" stroke="${style.strokeColor}" stroke-opacity="${svgNumber(style.opacity)}" stroke-width="${svgNumber(style.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function arrowHeadGeometry(
  points: readonly PixelPoint[],
  style: RenderStyle
): { tip: PixelPoint; wings: [PixelPoint, PixelPoint]; bounds: PixelRect } {
  const end = points.at(-1);
  if (end === undefined) throw new Error("A routed arrow is missing its endpoint.");
  let previous: PixelPoint | undefined;
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const candidate = points[index];
    if (candidate !== undefined && (candidate.x !== end.x || candidate.y !== end.y)) {
      previous = candidate;
      break;
    }
  }
  if (previous === undefined) {
    const radius = Math.max(0.5, style.strokeWidth / 2);
    return {
      tip: end,
      wings: [end, end],
      bounds: { x: end.x - radius, y: end.y - radius, width: radius * 2, height: radius * 2 }
    };
  }
  const angle = Math.atan2(end.y - previous.y, end.x - previous.x);
  const headLength = Math.max(style.arrowHeadSize, style.strokeWidth * 2);
  const wing = Math.PI / 7;
  const first = {
    x: end.x - headLength * Math.cos(angle - wing),
    y: end.y - headLength * Math.sin(angle - wing)
  };
  const second = {
    x: end.x - headLength * Math.cos(angle + wing),
    y: end.y - headLength * Math.sin(angle + wing)
  };
  const left = Math.min(end.x, first.x, second.x);
  const top = Math.min(end.y, first.y, second.y);
  const right = Math.max(end.x, first.x, second.x);
  const bottom = Math.max(end.y, first.y, second.y);
  return {
    tip: end,
    wings: [first, second],
    bounds: { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
  };
}

function routeCollisionIds(
  route: LeaderRoute,
  strokeWidth: number,
  obstacles: readonly RouteObstacle[]
): string[] {
  return [
    ...new Set(
      obstacles
        .filter((obstacle) =>
          route.segments.some((segment) =>
            paintedSegmentIntersectsRect({ ...segment, strokeWidth }, obstacle.rect)
          )
        )
        .map((obstacle) => obstacle.id)
    )
  ].sort((left, right) => left.localeCompare(right, "en"));
}

function routeWithArrowHeadAvoidance(
  canvas: { width: number; height: number },
  start: PixelPoint,
  endpoints: readonly ArrowRouteEndpointCandidate[],
  obstacles: readonly RouteObstacle[],
  style: RenderStyle,
  strokeWidth: number,
  headObstacles: readonly RouteObstacle[] = obstacles
): {
  route: LeaderRoute;
  arrowHead: PreparedArrowAnnotation["arrowHead"];
  headCollisionIds: string[];
} {
  const headLength = Math.max(style.arrowHeadSize, strokeWidth * 2);
  const obstacleSets = [
    obstacles,
    obstacles.map((obstacle) => ({
      ...obstacle,
      clearance: Math.max(obstacle.clearance ?? 0, headLength + 2)
    }))
  ];
  const attempts = endpoints.flatMap((endpoint, endpointOrder) =>
    obstacleSets.map((attemptObstacles, obstacleOrder) => {
      const ownTargetId = endpoint.ownTarget?.id;
      const routedPrefix = routeLeader({
        canvas,
        start,
        end: endpoint.approach ?? endpoint.end,
        obstacles:
          endpoint.ownTarget === undefined
            ? attemptObstacles
            : [...attemptObstacles, endpoint.ownTarget],
        clearance: 0,
        strokeWidth,
        orthogonalOnly: endpoint.approach !== undefined
      });
      const routed = appendRouteEndpoint(routedPrefix, endpoint.end, strokeWidth);
      const collisionIds = [
        ...new Set([
          ...routeCollisionIds(routed, strokeWidth, obstacles),
          ...(ownTargetId !== undefined && routedPrefix.collisionIds.includes(ownTargetId)
            ? [ownTargetId]
            : [])
        ])
      ].sort((left, right) => left.localeCompare(right, "en"));
      const route: LeaderRoute = {
        ...routed,
        collisionIds,
        diagnostics:
          collisionIds.length === 0
            ? []
            : [
                {
                  code: "LEADER_ROUTE_BLOCKED",
                  collisionIds,
                  message: `No collision-free leader route was available; the least-blocked route intersects ${collisionIds.length} obstacle${collisionIds.length === 1 ? "" : "s"}.`
                }
              ]
      };
      const arrowHead = arrowHeadGeometry(route.points, style);
      const headCollisionIds = [
        ...new Set(
          headObstacles
            .filter((obstacle) => rectsOverlap(arrowHead.bounds, obstacle.rect))
            .map((obstacle) => obstacle.id)
        )
      ].sort((left, right) => left.localeCompare(right, "en"));
      return { route, arrowHead, headCollisionIds, endpointOrder, obstacleOrder };
    })
  );
  return attempts.reduce((best, candidate) => {
    const comparison = compareNumericTuple(
      [
        candidate.headCollisionIds.length,
        candidate.route.collisionIds.length,
        candidate.route.bendCount,
        candidate.route.pathLength,
        candidate.endpointOrder,
        candidate.obstacleOrder
      ],
      [
        best.headCollisionIds.length,
        best.route.collisionIds.length,
        best.route.bendCount,
        best.route.pathLength,
        best.endpointOrder,
        best.obstacleOrder
      ]
    );
    return comparison < 0 ? candidate : best;
  });
}

function appendRouteEndpoint(
  route: LeaderRoute,
  endpoint: PixelPoint,
  strokeWidth: number
): LeaderRoute {
  const last = route.points.at(-1);
  const points = simplifyRoutePoints(
    last !== undefined && last.x === endpoint.x && last.y === endpoint.y
      ? route.points
      : [...route.points, endpoint]
  );
  const segments = points.slice(1).map((end, index) => ({
    start: points[index] as PixelPoint,
    end
  }));
  const bounds =
    segments.length === 0
      ? route.bounds
      : unionRects(
          segments.map((segment) => segmentBounds(segment.start, segment.end, strokeWidth))
        );
  const start = points[0] ?? endpoint;
  return {
    ...route,
    points,
    segments,
    directDistance: Math.hypot(endpoint.x - start.x, endpoint.y - start.y),
    pathLength: segments.reduce(
      (total, segment) =>
        total + Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y),
      0
    ),
    bendCount: Math.max(0, segments.length - 1),
    bounds
  };
}

function simplifyRoutePoints(points: readonly PixelPoint[]): PixelPoint[] {
  const simplified: PixelPoint[] = [];
  for (const point of points) {
    const previous = simplified.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    while (simplified.length >= 2) {
      const first = simplified.at(-2);
      const second = simplified.at(-1);
      if (first === undefined || second === undefined) break;
      const cross =
        (second.x - first.x) * (point.y - second.y) - (second.y - first.y) * (point.x - second.x);
      if (Math.abs(cross) >= 1e-7) break;
      simplified.pop();
    }
    simplified.push({ ...point });
  }
  return simplified;
}

function markerBoundaryCandidates(marker: PreparedMarker, preferred: PixelPoint): PixelPoint[] {
  const candidates = [
    preferred,
    { x: marker.center.x, y: marker.center.y - marker.paintedRadius },
    { x: marker.center.x + marker.paintedRadius, y: marker.center.y },
    { x: marker.center.x, y: marker.center.y + marker.paintedRadius },
    { x: marker.center.x - marker.paintedRadius, y: marker.center.y }
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${Number(candidate.x.toFixed(3))},${Number(candidate.y.toFixed(3))}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return true;
  });
}

function routeFromStartCandidates(
  canvas: { width: number; height: number },
  starts: readonly PixelPoint[],
  end: PixelPoint,
  obstacles: readonly RouteObstacle[],
  clearance: number,
  strokeWidth: number
): LeaderRoute {
  const attempts = starts.map((start, order) => ({
    route: routeLeader({ canvas, start, end, obstacles, clearance, strokeWidth }),
    order
  }));
  return attempts.reduce((best, candidate) => {
    const comparison = compareNumericTuple(
      [
        candidate.route.collisionIds.length,
        candidate.route.bendCount,
        candidate.route.pathLength,
        candidate.order
      ],
      [best.route.collisionIds.length, best.route.bendCount, best.route.pathLength, best.order]
    );
    return comparison < 0 ? candidate : best;
  }).route;
}

function routedArrowBody(points: readonly PixelPoint[], style: RenderStyle): string {
  const head = arrowHeadGeometry(points, style);
  const [first, second] = head.wings;
  if (
    first.x === head.tip.x &&
    first.y === head.tip.y &&
    second.x === head.tip.x &&
    second.y === head.tip.y
  ) {
    return routedLeaderBody(points, style);
  }
  return `${routedLeaderBody(points, style)}<path d="M ${svgNumber(head.tip.x)} ${svgNumber(head.tip.y)} L ${svgNumber(first.x)} ${svgNumber(first.y)} L ${svgNumber(second.x)} ${svgNumber(second.y)} Z" fill="${style.strokeColor}" fill-opacity="${svgNumber(style.opacity)}"/>`;
}

function resolvedRoute(route: LeaderRoute, strokeWidth: number): Record<string, unknown> {
  const start = route.points[0];
  const end = route.points.at(-1) ?? start;
  if (start === undefined) {
    throw new Error("A resolved route must contain boundary endpoints.");
  }
  return {
    kind: route.bendCount === 0 ? "straight" : "orthogonal",
    start,
    end,
    length: route.directDistance,
    pathLength: route.pathLength,
    points: route.points,
    segments: route.segments,
    bendCount: route.bendCount,
    ...(route.segments.length === 0 ? {} : { bounds: route.bounds }),
    strokeWidth,
    ...(route.collisionIds.length === 0 ? {} : { collisionIds: route.collisionIds })
  };
}

function layoutIssue(
  code: RendererLayoutIssueCode,
  annotationId: string,
  message: string,
  relatedIds: string[] = [],
  metrics?: Record<string, number>
): RendererLayoutIssue {
  return {
    code,
    annotationId,
    relatedIds: [...new Set(relatedIds)].sort((left, right) => left.localeCompare(right, "en")),
    message,
    ...(metrics === undefined ? {} : { metrics })
  };
}

function layoutResult(issues: readonly RendererLayoutIssue[]): Record<string, unknown> {
  return { status: issues.length === 0 ? "ok" : "degraded", issues };
}

function spotlightBody(width: number, height: number, rect: PixelRect, style: RenderStyle): string {
  const pathData = `M 0 0 H ${width} V ${height} H 0 Z M ${svgNumber(rect.x)} ${svgNumber(rect.y)} H ${svgNumber(rect.x + rect.width)} V ${svgNumber(rect.y + rect.height)} H ${svgNumber(rect.x)} Z`;
  return `<path d="${pathData}" fill="${style.fillColor === TRANSPARENT ? "#000000A6" : style.fillColor}" fill-opacity="${svgNumber(style.opacity)}" fill-rule="evenodd" clip-rule="evenodd"/>`;
}

async function compositeStable(base: Buffer, overlays: OverlayOptions[]): Promise<Buffer> {
  return sharp(base).composite(overlays).png(STABLE_PNG_OPTIONS).toBuffer();
}

function estimateTextWidth(text: string, fontSize: number): number {
  let widest = 0;
  for (const line of text.split(/\r?\n/u)) {
    let width = 0;
    for (const character of [...line]) {
      width += (character.codePointAt(0) ?? 0) <= 0xff ? fontSize * 0.58 : fontSize;
    }
    widest = Math.max(widest, width);
  }
  return Math.ceil(widest + 4);
}

async function renderTextSprite(
  text: string,
  style: RenderStyle,
  fontPath: string,
  maximumWidth: number,
  maximumHeight: number,
  options: { allowClipping?: boolean } = {}
): Promise<TextSprite> {
  const minimumFontSize = 6;
  const safeMaximumWidth = Math.max(1, Math.floor(maximumWidth));
  const safeMaximumHeight = Math.max(1, Math.floor(maximumHeight));
  const requestedFontSize = style.fontSize;
  let fontSize = Math.min(style.fontSize, Math.max(minimumFontSize, safeMaximumHeight));
  for (;;) {
    const desiredWidth = Math.min(
      safeMaximumWidth,
      Math.max(Math.min(64, safeMaximumWidth), estimateTextWidth(text, fontSize))
    );
    const rendered = await sharp({
      text: {
        align: "left",
        font: `Noto Sans CJK SC ${fontSize}`,
        fontfile: fontPath,
        rgba: true,
        spacing: Math.max(0, Math.round(fontSize * (style.lineHeight - 1))),
        text: `<span foreground="${style.textColor}">${escapePango(text)}</span>`,
        width: Math.max(1, Math.floor(desiredWidth)),
        wrap: "word-char"
      }
    })
      .png(STABLE_PNG_OPTIONS)
      .toBuffer({ resolveWithObject: true });
    if (rendered.info.width <= safeMaximumWidth && rendered.info.height <= safeMaximumHeight) {
      const buffer =
        style.opacity < 1
          ? await sharp(rendered.data)
              .ensureAlpha()
              .linear([1, 1, 1, style.opacity], [0, 0, 0, 0])
              .png(STABLE_PNG_OPTIONS)
              .toBuffer()
          : rendered.data;
      return {
        buffer,
        width: rendered.info.width,
        height: rendered.info.height,
        fontSize,
        wasShrunk: fontSize < requestedFontSize,
        wasClipped: false,
        unclippedDimensions: { width: rendered.info.width, height: rendered.info.height },
        clippedAlphaPixelCount: 0
      };
    }
    if (fontSize <= minimumFontSize) {
      if (options.allowClipping === true) {
        const clippedWidth = Math.max(1, Math.min(rendered.info.width, safeMaximumWidth));
        const clippedHeight = Math.max(1, Math.min(rendered.info.height, safeMaximumHeight));
        const raw = await sharp(rendered.data)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        let clippedAlphaPixelCount = 0;
        for (let y = 0; y < raw.info.height; y += 1) {
          for (let x = 0; x < raw.info.width; x += 1) {
            if (x < clippedWidth && y < clippedHeight) continue;
            if (raw.data[(y * raw.info.width + x) * raw.info.channels + 3] !== 0) {
              clippedAlphaPixelCount += 1;
            }
          }
        }
        const clipped = await sharp(rendered.data)
          .extract({ left: 0, top: 0, width: clippedWidth, height: clippedHeight })
          .png(STABLE_PNG_OPTIONS)
          .toBuffer();
        const buffer =
          style.opacity < 1
            ? await sharp(clipped)
                .ensureAlpha()
                .linear([1, 1, 1, style.opacity], [0, 0, 0, 0])
                .png(STABLE_PNG_OPTIONS)
                .toBuffer()
            : clipped;
        return {
          buffer,
          width: clippedWidth,
          height: clippedHeight,
          fontSize,
          wasShrunk: fontSize < requestedFontSize,
          wasClipped: true,
          unclippedDimensions: { width: rendered.info.width, height: rendered.info.height },
          clippedAlphaPixelCount
        };
      }
      throw new Error(
        `Text cannot fit within ${safeMaximumWidth}x${safeMaximumHeight} pixels even at the minimum supported font size (${minimumFontSize}px); shorten it, crop the image, or use a larger canvas.`
      );
    }
    fontSize = Math.max(minimumFontSize, fontSize - 2);
  }
}

function clampLabelBox(rect: PixelRect, width: number, height: number, margin: number): PixelRect {
  const maximumX = Math.max(margin, width - margin - rect.width);
  const maximumY = Math.max(margin, height - margin - rect.height);
  return {
    x: Math.round(Math.min(maximumX, Math.max(margin, rect.x))),
    y: Math.round(Math.min(maximumY, Math.max(margin, rect.y))),
    width: Math.min(rect.width, Math.max(1, width - margin * 2)),
    height: Math.min(rect.height, Math.max(1, height - margin * 2))
  };
}

function rectsOverlap(left: PixelRect, right: PixelRect): boolean {
  return (
    Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x) &&
    Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y)
  );
}

function samePixelRect(left: PixelRect, right: PixelRect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function targetBoundaryCandidates(
  target: PixelPoint | PixelRect,
  preferred: PixelPoint,
  approachDistance: number,
  canvas: { width: number; height: number },
  targetId: string
): ArrowRouteEndpointCandidate[] {
  if (!isPixelRect(target)) return [{ end: preferred }];
  const centerX = target.x + target.width / 2;
  const centerY = target.y + target.height / 2;
  const edgeDistances = [
    { distance: Math.abs(preferred.y - target.y), normal: { x: 0, y: -1 } },
    {
      distance: Math.abs(preferred.x - (target.x + target.width)),
      normal: { x: 1, y: 0 }
    },
    {
      distance: Math.abs(preferred.y - (target.y + target.height)),
      normal: { x: 0, y: 1 }
    },
    { distance: Math.abs(preferred.x - target.x), normal: { x: -1, y: 0 } }
  ].sort((left, right) => left.distance - right.distance);
  const preferredNormal = edgeDistances[0]?.normal ?? { x: 0, y: -1 };
  const rawCandidates = [
    { end: preferred, normal: preferredNormal, withApproach: false },
    { end: preferred, normal: preferredNormal, withApproach: true },
    {
      end: { x: centerX, y: target.y },
      normal: { x: 0, y: -1 },
      withApproach: true
    },
    {
      end: { x: target.x + target.width, y: centerY },
      normal: { x: 1, y: 0 },
      withApproach: true
    },
    {
      end: { x: centerX, y: target.y + target.height },
      normal: { x: 0, y: 1 },
      withApproach: true
    },
    {
      end: { x: target.x, y: centerY },
      normal: { x: -1, y: 0 },
      withApproach: true
    }
  ];
  const seen = new Set<string>();
  const candidates = rawCandidates.flatMap((candidate) => {
    const key = `${candidate.end.x},${candidate.end.y}:${candidate.withApproach}`;
    if (seen.has(key)) return [];
    seen.add(key);
    if (!candidate.withApproach) return [{ end: candidate.end }];
    const approach = {
      x: candidate.end.x + candidate.normal.x * approachDistance,
      y: candidate.end.y + candidate.normal.y * approachDistance
    };
    if (
      approach.x < 0 ||
      approach.y < 0 ||
      approach.x > canvas.width - 1 ||
      approach.y > canvas.height - 1
    ) {
      return [];
    }
    return [
      {
        end: candidate.end,
        approach,
        ownTarget: { id: targetId, rect: target, clearance: 0 }
      }
    ];
  });
  return candidates.length > 0 ? candidates : [{ end: preferred }];
}

function unionRects(rects: readonly PixelRect[]): PixelRect {
  const first = rects[0];
  if (!first) throw new Error("Cannot union an empty rectangle list.");
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function inflateRect(rect: PixelRect, amount: number): PixelRect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2
  };
}

function rectInsideCanvas(rect: PixelRect, width: number, height: number): boolean {
  return (
    rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height
  );
}

function segmentBounds(start: PixelPoint, end: PixelPoint, strokeWidth: number): PixelRect {
  const halfStroke = Math.max(0.5, strokeWidth / 2);
  return {
    x: Math.min(start.x, end.x) - halfStroke,
    y: Math.min(start.y, end.y) - halfStroke,
    width: Math.abs(end.x - start.x) + halfStroke * 2,
    height: Math.abs(end.y - start.y) + halfStroke * 2
  };
}

export function paintedSegmentIntersectsRect(segment: PaintedSegment, rect: PixelRect): boolean {
  if (
    segment.strokeWidth <= 0 ||
    (segment.start.x === segment.end.x && segment.start.y === segment.end.y)
  ) {
    return false;
  }
  const expanded = inflateRect(rect, segment.strokeWidth / 2);
  const deltaX = segment.end.x - segment.start.x;
  const deltaY = segment.end.y - segment.start.y;
  let minimum = 0;
  let maximum = 1;
  for (const [direction, distance] of [
    [-deltaX, segment.start.x - expanded.x],
    [deltaX, expanded.x + expanded.width - segment.start.x],
    [-deltaY, segment.start.y - expanded.y],
    [deltaY, expanded.y + expanded.height - segment.start.y]
  ] as const) {
    if (direction === 0) {
      if (distance < 0) return false;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) {
      if (ratio > maximum) return false;
      minimum = Math.max(minimum, ratio);
    } else {
      if (ratio < minimum) return false;
      maximum = Math.min(maximum, ratio);
    }
  }
  return minimum <= maximum;
}

function pointToSegmentDistance(point: PixelPoint, segment: PaintedSegment): number {
  const deltaX = segment.end.x - segment.start.x;
  const deltaY = segment.end.y - segment.start.y;
  const denominator = deltaX * deltaX + deltaY * deltaY;
  if (denominator === 0) return Math.hypot(point.x - segment.start.x, point.y - segment.start.y);
  const ratio = Math.min(
    1,
    Math.max(
      0,
      ((point.x - segment.start.x) * deltaX + (point.y - segment.start.y) * deltaY) / denominator
    )
  );
  return Math.hypot(
    point.x - (segment.start.x + deltaX * ratio),
    point.y - (segment.start.y + deltaY * ratio)
  );
}

function segmentCenterlinesIntersect(left: PaintedSegment, right: PaintedSegment): boolean {
  const cross = (first: PixelPoint, second: PixelPoint, third: PixelPoint): number =>
    (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  const first = cross(left.start, left.end, right.start);
  const second = cross(left.start, left.end, right.end);
  const third = cross(right.start, right.end, left.start);
  const fourth = cross(right.start, right.end, left.end);
  return (
    Math.max(Math.min(left.start.x, left.end.x), Math.min(right.start.x, right.end.x)) <=
      Math.min(Math.max(left.start.x, left.end.x), Math.max(right.start.x, right.end.x)) &&
    Math.max(Math.min(left.start.y, left.end.y), Math.min(right.start.y, right.end.y)) <=
      Math.min(Math.max(left.start.y, left.end.y), Math.max(right.start.y, right.end.y)) &&
    ((first <= 0 && second >= 0) || (first >= 0 && second <= 0)) &&
    ((third <= 0 && fourth >= 0) || (third >= 0 && fourth <= 0))
  );
}

function paintedSegmentsIntersect(left: PaintedSegment, right: PaintedSegment): boolean {
  if (
    left.strokeWidth <= 0 ||
    right.strokeWidth <= 0 ||
    (left.start.x === left.end.x && left.start.y === left.end.y) ||
    (right.start.x === right.end.x && right.start.y === right.end.y)
  ) {
    return false;
  }
  if (left.end.x === right.end.x && left.end.y === right.end.y) {
    const leftVector = {
      x: left.start.x - left.end.x,
      y: left.start.y - left.end.y
    };
    const rightVector = {
      x: right.start.x - right.end.x,
      y: right.start.y - right.end.y
    };
    if (Math.abs(leftVector.x * rightVector.y - leftVector.y * rightVector.x) > 0.001) {
      return false;
    }
  }
  if (segmentCenterlinesIntersect(left, right)) return true;
  const distance = Math.min(
    pointToSegmentDistance(left.start, right),
    pointToSegmentDistance(left.end, right),
    pointToSegmentDistance(right.start, left),
    pointToSegmentDistance(right.end, left)
  );
  return distance <= (left.strokeWidth + right.strokeWidth) / 2;
}

function geometryIntersectsOccupied(
  rects: readonly PixelRect[],
  segment: PaintedSegment | undefined,
  occupied: OccupiedGeometry
): boolean {
  if (rects.some((rect) => occupied.rects.some((other) => rectsOverlap(rect, other)))) {
    return true;
  }
  if (segment && occupied.rects.some((rect) => paintedSegmentIntersectsRect(segment, rect))) {
    return true;
  }
  if (
    occupied.segments.some((other) =>
      rects.some((rect) => paintedSegmentIntersectsRect(other, rect))
    )
  ) {
    return true;
  }
  return segment
    ? occupied.segments.some((other) => paintedSegmentsIntersect(segment, other))
    : false;
}

function colorHasVisibleAlpha(color: string): boolean {
  if (color === "transparent") return false;
  const alpha = /^#[0-9a-f]{8}$/iu.test(color)
    ? color.slice(-2)
    : /^#[0-9a-f]{4}$/iu.test(color)
      ? color.slice(-1).repeat(2)
      : "ff";
  return Number.parseInt(alpha, 16) > 0;
}

function visibleStrokeWidth(style: RenderStyle, strokeColor = style.strokeColor): number {
  const serializedWidth = Number(style.strokeWidth.toFixed(3));
  const serializedOpacity = Number(style.opacity.toFixed(3));
  return serializedWidth > 0 && serializedOpacity > 0 && colorHasVisibleAlpha(strokeColor)
    ? serializedWidth
    : 0;
}

function hasVisibleStroke(style: RenderStyle): boolean {
  return visibleStrokeWidth(style) > 0;
}

async function renderCallout(
  base: Buffer,
  annotation: RenderableAnnotation,
  width: number,
  height: number,
  fontPath: string,
  occupied: PixelRect[],
  warnings: string[]
): Promise<{ buffer: Buffer; box?: PixelRect; resolved: Record<string, unknown> }> {
  const target = targetRect(annotation.target ?? annotation.rect);
  if (!target) {
    throw new Error(`Callout ${annotation.id} is missing a target.`);
  }
  const safeTarget = integerRect(target, width, height);
  const text = annotation.text ?? "";
  const padding = Math.round(annotation.style.padding);
  const maximumTextWidth = Math.max(
    1,
    Math.min(annotation.style.maxWidth, width - padding * 2 - 8)
  );
  const maximumTextHeight = Math.max(1, height - padding * 2 - 8);
  const sprite = await renderTextSprite(
    text,
    annotation.style,
    fontPath,
    maximumTextWidth,
    maximumTextHeight
  );
  if (sprite.wasShrunk) {
    warnings.push(
      `Callout ${annotation.id} font size was reduced from ${annotation.style.fontSize}px to ${sprite.fontSize}px to keep all text inside the canvas.`
    );
  }
  const labelWidth = Math.min(width - 8, sprite.width + padding * 2);
  const labelHeight = Math.min(height - 8, sprite.height + padding * 2);
  const chosen = placeCallout({
    canvas: { width, height },
    target: safeTarget,
    box: { width: labelWidth, height: labelHeight },
    occupied,
    placement: annotation.placement ?? "auto",
    margin: 4,
    gap: 14
  });
  warnings.push(...chosen.warnings.map((warning) => `Callout ${annotation.id}: ${warning}`));
  const backgroundStyle: RenderStyle = {
    ...annotation.style,
    fillColor: annotation.style.backgroundColor,
    opacity: annotation.style.opacity
  };
  const geometry = controlledSvg(
    width,
    height,
    `${arrowBody(chosen.anchor, chosen.targetAnchor, annotation.style)}${rectangleBody(chosen.box, backgroundStyle, annotation.style.cornerRadius)}`
  );
  const textLeft = Math.max(0, Math.round(chosen.box.x + padding));
  const textTop = Math.max(0, Math.round(chosen.box.y + padding));
  const rendered = await compositeStable(base, [
    { input: geometry, left: 0, top: 0 },
    { input: sprite.buffer, left: textLeft, top: textTop }
  ]);
  const resolvedStyle =
    annotation.style.markerStrokeColor === undefined ||
    annotation.style.markerFillColor === undefined ||
    annotation.style.markerTextColor === undefined
      ? {}
      : { style: annotation.style };
  return {
    buffer: rendered,
    box: chosen.box,
    resolved: {
      id: annotation.id,
      type: annotation.type,
      target: safeTarget,
      box: chosen.box,
      anchor: chosen.anchor,
      targetAnchor: chosen.targetAnchor,
      placement: chosen.placement,
      text,
      fontSize: sprite.fontSize,
      ...resolvedStyle
    }
  };
}

async function renderNumberMarker(
  base: Buffer,
  annotation: RenderableAnnotation,
  number: number,
  width: number,
  height: number,
  fontPath: string
): Promise<{ buffer: Buffer; center: PixelPoint; radius: number; radiusReduced: boolean }> {
  const point = targetPoint(annotation.target ?? annotation.rect ?? annotation.position);
  if (!point) throw new Error(`Numbered callout ${annotation.id} is missing a target.`);
  const desiredRadius = Math.max(13, Math.round(annotation.style.fontSize * 0.72));
  const radius = Math.max(
    3,
    Math.min(desiredRadius, Math.floor((Math.min(width, height) - 2) / 2))
  );
  const center = {
    x: Math.min(width - radius - 1, Math.max(radius + 1, Math.round(point.x))),
    y: Math.min(height - radius - 1, Math.max(radius + 1, Math.round(point.y)))
  };
  const markerStyle: RenderStyle = {
    ...annotation.style,
    strokeColor: annotation.style.markerStrokeColor ?? annotation.style.strokeColor,
    fillColor: annotation.style.markerFillColor ?? annotation.style.backgroundColor,
    opacity: annotation.style.opacity
  };
  const markerRect = {
    x: center.x - radius,
    y: center.y - radius,
    width: radius * 2,
    height: radius * 2
  };
  const textStyle = {
    ...annotation.style,
    textColor: annotation.style.markerTextColor ?? annotation.style.textColor,
    fontSize: Math.max(10, radius),
    maxWidth: radius * 2
  };
  const sprite = await renderTextSprite(
    String(number),
    textStyle,
    fontPath,
    radius * 2,
    radius * 2
  );
  const geometry = controlledSvg(width, height, ellipseBody(markerRect, markerStyle));
  const rendered = await compositeStable(base, [
    { input: geometry, left: 0, top: 0 },
    {
      input: sprite.buffer,
      left: Math.round(center.x - sprite.width / 2),
      top: Math.round(center.y - sprite.height / 2)
    }
  ]);
  return { buffer: rendered, center, radius, radiusReduced: radius < desiredRadius };
}

function numberedMarkerRadius(
  annotation: RenderableAnnotation,
  fittedFontSize: number,
  width: number,
  height: number
): {
  radius: number;
  paintedRadius: number;
  radiusReduced: boolean;
  strokeWidth: number;
  strokeWidthReduced: boolean;
} {
  const desiredRadius = Math.max(6, Math.round(fittedFontSize * 0.72));
  const maximumPaintedRadius = Math.max(1, (Math.min(width, height) - 2) / 2);
  const clearanceRadius = Math.max(4, Math.floor(Math.min(width, height) / 6));
  const maximumRadius = Math.max(1, Math.min(Math.floor(maximumPaintedRadius), clearanceRadius));
  const radius = Math.min(desiredRadius, maximumRadius);
  const maximumStrokeWidth = Math.min(
    Math.max(0, (maximumPaintedRadius - radius) * 2),
    Math.max(1, Math.min(8, radius))
  );
  const markerStrokeColor = annotation.style.markerStrokeColor ?? annotation.style.strokeColor;
  const requestedStrokeWidth = visibleStrokeWidth(annotation.style, markerStrokeColor);
  const strokeWidth = Math.min(requestedStrokeWidth, maximumStrokeWidth);
  return {
    radius,
    paintedRadius: radius + strokeWidth / 2,
    radiusReduced: radius < desiredRadius,
    strokeWidth,
    strokeWidthReduced: strokeWidth < requestedStrokeWidth
  };
}

function orderedMarkerFaces(
  placement: CardinalPlacement,
  box: PixelRect,
  target: PixelRect
): {
  candidates: { face: CardinalPlacement; boundary: PixelPoint; distance: number }[];
  preferredFace: CardinalPlacement;
} {
  const targetCenter = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2
  };
  const preferredFace: CardinalPlacement =
    placement === "top"
      ? "bottom"
      : placement === "right"
        ? "left"
        : placement === "bottom"
          ? "top"
          : "right";
  const candidates: { face: CardinalPlacement; boundary: PixelPoint; distance: number }[] = [
    {
      face: "top",
      boundary: { x: Math.min(box.x + box.width, Math.max(box.x, targetCenter.x)), y: box.y },
      distance: 0
    },
    {
      face: "right",
      boundary: {
        x: box.x + box.width,
        y: Math.min(box.y + box.height, Math.max(box.y, targetCenter.y))
      },
      distance: 0
    },
    {
      face: "bottom",
      boundary: {
        x: Math.min(box.x + box.width, Math.max(box.x, targetCenter.x)),
        y: box.y + box.height
      },
      distance: 0
    },
    {
      face: "left",
      boundary: { x: box.x, y: Math.min(box.y + box.height, Math.max(box.y, targetCenter.y)) },
      distance: 0
    }
  ];
  for (const candidate of candidates) {
    candidate.distance = Math.hypot(
      candidate.boundary.x - targetCenter.x,
      candidate.boundary.y - targetCenter.y
    );
  }
  candidates.sort((left, right) => {
    if (left.distance !== right.distance) return left.distance - right.distance;
    if (left.face === preferredFace) return -1;
    if (right.face === preferredFace) return 1;
    return (
      ["top", "right", "bottom", "left"].indexOf(left.face) -
      ["top", "right", "bottom", "left"].indexOf(right.face)
    );
  });
  return { candidates, preferredFace };
}

function markerCenterForLabel(
  placement: CardinalPlacement,
  box: PixelRect,
  target: PixelRect,
  paintedRadius: number,
  width: number,
  height: number,
  faceOverride?: CardinalPlacement
): {
  center: PixelPoint;
  face: CardinalPlacement;
  preferredFace: CardinalPlacement;
  wasClamped: boolean;
} {
  const ordered = orderedMarkerFaces(placement, box, target);
  const selected =
    ordered.candidates.find((candidate) => candidate.face === faceOverride) ??
    ordered.candidates[0];
  if (selected === undefined) throw new Error("Numbered marker face selection failed.");
  const center =
    selected.face === "top"
      ? { x: selected.boundary.x, y: box.y - paintedRadius }
      : selected.face === "right"
        ? { x: box.x + box.width + paintedRadius, y: selected.boundary.y }
        : selected.face === "bottom"
          ? { x: selected.boundary.x, y: box.y + box.height + paintedRadius }
          : { x: box.x - paintedRadius, y: selected.boundary.y };
  const clampCoordinate = (value: number, extent: number): number => {
    const minimum = paintedRadius + 1;
    const maximum = extent - paintedRadius - 1;
    return minimum <= maximum ? Math.min(maximum, Math.max(minimum, value)) : (extent - 1) / 2;
  };
  const clamped = {
    x: clampCoordinate(center.x, width),
    y: clampCoordinate(center.y, height)
  };
  return {
    center: clamped,
    face: selected.face,
    preferredFace: ordered.preferredFace,
    wasClamped: clamped.x !== center.x || clamped.y !== center.y
  };
}

function compareNumberedGeometryCandidates(
  left: NumberedGeometryCandidate,
  right: NumberedGeometryCandidate
): number {
  const leftScore = [
    left.hardCollisionCount,
    left.collisionIds.length,
    left.decorationOverflow ? 1 : 0,
    left.leader.length < MINIMUM_VISIBLE_NUMBERED_LEADER ? 1 : 0,
    left.placementOrder,
    left.faceOrder,
    left.placementScore
  ];
  const rightScore = [
    right.hardCollisionCount,
    right.collisionIds.length,
    right.decorationOverflow ? 1 : 0,
    right.leader.length < MINIMUM_VISIBLE_NUMBERED_LEADER ? 1 : 0,
    right.placementOrder,
    right.faceOrder,
    right.placementScore
  ];
  for (let index = 0; index < leftScore.length; index += 1) {
    const difference = (leftScore[index] ?? 0) - (rightScore[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function renderNumberMarkerAt(
  base: Buffer,
  annotation: RenderableAnnotation,
  number: number,
  center: PixelPoint,
  radius: number,
  strokeWidth: number,
  width: number,
  height: number,
  fontPath: string
): Promise<Buffer> {
  const markerStyle: RenderStyle = {
    ...annotation.style,
    strokeColor: annotation.style.markerStrokeColor ?? annotation.style.strokeColor,
    fillColor: annotation.style.markerFillColor ?? annotation.style.backgroundColor,
    strokeWidth,
    opacity: annotation.style.opacity
  };
  const markerRect = {
    x: center.x - radius,
    y: center.y - radius,
    width: radius * 2,
    height: radius * 2
  };
  const textStyle = {
    ...annotation.style,
    textColor: annotation.style.markerTextColor ?? annotation.style.textColor,
    fontSize: Math.max(6, radius),
    maxWidth: radius * 2
  };
  const sprite = await renderTextSprite(
    String(number),
    textStyle,
    fontPath,
    radius * 2,
    radius * 2
  );
  const geometry = controlledSvg(width, height, ellipseBody(markerRect, markerStyle));
  return compositeStable(base, [
    { input: geometry, left: 0, top: 0 },
    {
      input: sprite.buffer,
      left: Math.round(center.x - sprite.width / 2),
      top: Math.round(center.y - sprite.height / 2)
    }
  ]);
}

async function renderVersion11NumberedCallout(
  base: Buffer,
  annotation: RenderableAnnotation,
  number: number,
  width: number,
  height: number,
  fontPath: string,
  occupiedGroups: readonly OccupiedGeometry[],
  warnings: string[],
  prepared?: PreparedDenseAnnotation
): Promise<{
  buffer: Buffer;
  box: PixelRect;
  paintedLabelBox: PixelRect;
  leaderBox?: PixelRect;
  markerBox: PixelRect;
  occupiedGeometry: OccupiedGeometry;
  resolved: Record<string, unknown>;
}> {
  if (prepared !== undefined) {
    const rendered = await renderPreparedDenseAnnotation(base, prepared, width, height, fontPath);
    const marker = prepared.marker;
    if (marker === undefined) {
      throw new Error(`Prepared numbered callout ${annotation.id} is missing its marker.`);
    }
    return {
      buffer: rendered.buffer,
      box: prepared.placement.box,
      paintedLabelBox: prepared.paintedLabelBox,
      ...(prepared.route.segments.length === 0 ? {} : { leaderBox: prepared.route.bounds }),
      markerBox: marker.bounds,
      occupiedGeometry: {
        annotationId: annotation.id,
        rects: [prepared.paintedLabelBox, marker.bounds],
        segments: prepared.route.segments.map((segment) => ({
          ...segment,
          strokeWidth: prepared.leaderStrokeWidth
        }))
      },
      resolved: rendered.resolved
    };
  }
  const rawTarget = annotation.target ?? annotation.rect ?? annotation.position;
  if (!rawTarget) throw new Error(`Numbered callout ${annotation.id} is missing a target.`);
  const safeTarget = isPixelRect(rawTarget)
    ? integerRect(rawTarget, width, height)
    : pointInCanvas(rawTarget, width, height);
  const layoutTarget = isPixelRect(safeTarget)
    ? safeTarget
    : integerRect({ x: safeTarget.x - 2, y: safeTarget.y - 2, width: 4, height: 4 }, width, height);
  const text = annotation.text ?? "";
  const margin = Math.min(4, Math.max(1, Math.floor((Math.min(width, height) - 1) / 4)));
  const maximumLabelWidth = Math.max(1, width - margin * 2);
  const maximumLabelHeight = Math.max(1, height - margin * 2);
  const minimumTextExtent = Math.min(12, maximumLabelWidth, maximumLabelHeight);
  const maximumPadding = Math.max(
    0,
    Math.floor((Math.min(maximumLabelWidth, maximumLabelHeight) - minimumTextExtent) / 2)
  );
  const requestedPadding = Math.round(annotation.style.padding);
  const padding = Math.min(requestedPadding, maximumPadding);
  const maximumTextWidth = Math.max(
    1,
    Math.min(annotation.style.maxWidth, maximumLabelWidth - padding * 2)
  );
  const maximumTextHeight = Math.max(1, maximumLabelHeight - padding * 2);
  const sprite = await renderTextSprite(
    text,
    annotation.style,
    fontPath,
    maximumTextWidth,
    maximumTextHeight
  );
  if (sprite.wasShrunk) {
    warnings.push(
      `Numbered callout ${annotation.id} font size was reduced from ${annotation.style.fontSize}px to ${sprite.fontSize}px to keep all text inside the canvas.`
    );
  }
  if (padding < requestedPadding) {
    warnings.push(
      `Numbered callout ${annotation.id} padding was reduced from ${requestedPadding}px to ${padding}px to fit the canvas.`
    );
  }
  const markerSize = numberedMarkerRadius(annotation, sprite.fontSize, width, height);
  const requestedLabelStrokeWidth = visibleStrokeWidth(annotation.style);
  const labelStrokeWidth = Math.min(requestedLabelStrokeWidth, margin * 2);
  const labelStrokeOutset = labelStrokeWidth / 2;
  const maximumLeaderStrokeWidth = Math.max(1, Math.min(8, markerSize.radius));
  const requestedLeaderStrokeWidth = visibleStrokeWidth(annotation.style);
  const leaderStrokeWidth = Math.min(requestedLeaderStrokeWidth, maximumLeaderStrokeWidth);
  const leaderStyle = { ...annotation.style, strokeWidth: leaderStrokeWidth };
  const desiredGap =
    labelStrokeOutset +
    markerSize.paintedRadius * 2 +
    MINIMUM_VISIBLE_NUMBERED_LEADER +
    NUMBERED_LEADER_RENDERING_ALLOWANCE;
  const labelWidth = Math.min(maximumLabelWidth, sprite.width + padding * 2);
  const labelHeight = Math.min(maximumLabelHeight, sprite.height + padding * 2);
  const leaderIsVisible = hasVisibleStroke(leaderStyle);
  const requestedPlacement = annotation.placement ?? "auto";
  const automaticOrder = ["top", "right", "bottom", "left"] as const;
  const placements: readonly CardinalPlacement[] =
    requestedPlacement === "auto" ? automaticOrder : [requestedPlacement];
  const geometryCandidates: NumberedGeometryCandidate[] = [];
  for (const [placementOrder, placement] of placements.entries()) {
    const placed = placeCallout({
      canvas: { width, height },
      target: layoutTarget,
      box: { width: labelWidth, height: labelHeight },
      occupied: [],
      placement,
      margin,
      gap: desiredGap,
      facingDecorationDepth: desiredGap,
      facingDecorationSpan: (markerSize.paintedRadius + labelStrokeOutset) * 2
    });
    const paintedLabelBox = inflateRect(placed.box, labelStrokeOutset);
    const orderedFaces = orderedMarkerFaces(placement, paintedLabelBox, layoutTarget);
    for (const [faceOrder, face] of orderedFaces.candidates.entries()) {
      const markerPlacement = markerCenterForLabel(
        placement,
        paintedLabelBox,
        layoutTarget,
        markerSize.paintedRadius,
        width,
        height,
        face.face
      );
      const marker = {
        center: markerPlacement.center,
        radius: markerSize.radius,
        paintedRadius: markerSize.paintedRadius,
        strokeWidth: markerSize.strokeWidth,
        labelSide: markerPlacement.face
      };
      const markerBox = {
        x: marker.center.x - marker.paintedRadius,
        y: marker.center.y - marker.paintedRadius,
        width: marker.paintedRadius * 2,
        height: marker.paintedRadius * 2
      };
      const paintedMarker = { center: marker.center, radius: marker.paintedRadius };
      const boundaryLeader = connectCircleToTarget(paintedMarker, safeTarget);
      const labelTargetOverlap = rectsOverlap(paintedLabelBox, layoutTarget);
      const markerLabelOverlap = circleOverlapsTarget(paintedMarker, paintedLabelBox);
      const markerTargetOverlap = circleOverlapsTarget(paintedMarker, safeTarget);
      const hasLeader =
        leaderIsVisible &&
        !labelTargetOverlap &&
        !markerLabelOverlap &&
        !markerTargetOverlap &&
        boundaryLeader.length > 0;
      const leader = hasLeader
        ? boundaryLeader
        : { start: { ...boundaryLeader.end }, end: boundaryLeader.end, length: 0 };
      const leaderSegment = hasLeader
        ? { start: leader.start, end: leader.end, strokeWidth: leaderStrokeWidth }
        : undefined;
      const leaderBox = leaderSegment
        ? segmentBounds(leaderSegment.start, leaderSegment.end, leaderSegment.strokeWidth)
        : undefined;
      const collisionIds = occupiedGroups
        .filter((group) =>
          geometryIntersectsOccupied([paintedLabelBox, markerBox], leaderSegment, group)
        )
        .map((group) => group.annotationId);
      const labelClipped = !rectInsideCanvas(paintedLabelBox, width, height);
      const markerClipped = !rectInsideCanvas(markerBox, width, height);
      const leaderClipped = leaderBox ? !rectInsideCanvas(leaderBox, width, height) : false;
      const decorationOverflow =
        labelClipped ||
        markerClipped ||
        leaderClipped ||
        placed.warnings.some((warning) => warning.includes("decoration footprint overflowed"));
      geometryCandidates.push({
        placement,
        placementOrder,
        faceOrder,
        box: placed.box,
        paintedLabelBox,
        marker,
        markerBox,
        leader,
        ...(leaderBox ? { leaderBox } : {}),
        ...(leaderSegment ? { leaderSegment } : {}),
        collisionIds,
        decorationOverflow,
        hardCollisionCount:
          Number(labelTargetOverlap) + Number(markerLabelOverlap) + Number(markerTargetOverlap),
        labelTargetOverlap,
        markerLabelOverlap,
        markerTargetOverlap,
        labelClipped,
        markerClipped,
        leaderClipped,
        placementWarnings: placed.warnings,
        placementScore: placed.score.total,
        markerWasClamped: markerPlacement.wasClamped,
        preferredFace: markerPlacement.preferredFace
      });
    }
  }
  const chosen = geometryCandidates.reduce((best, candidate) =>
    compareNumberedGeometryCandidates(candidate, best) < 0 ? candidate : best
  );
  warnings.push(
    ...chosen.placementWarnings
      .filter(
        (warning) =>
          !warning.includes("overlaps its target") && !warning.includes("occupied callout")
      )
      .map((warning) => `Numbered callout ${annotation.id}: ${warning}`)
  );
  if (chosen.markerWasClamped) {
    warnings.push(
      `Numbered callout ${annotation.id} marker was shifted to keep it inside the canvas.`
    );
  }
  if (chosen.marker.labelSide !== chosen.preferredFace) {
    warnings.push(
      `Numbered callout ${annotation.id} marker moved to the ${chosen.marker.labelSide} label edge to avoid a final-geometry collision.`
    );
  }
  if (markerSize.radiusReduced) {
    warnings.push(`Numbered callout ${annotation.id} marker radius was reduced to fit the canvas.`);
  }
  if (markerSize.strokeWidthReduced) {
    warnings.push(
      `Numbered callout ${annotation.id} marker stroke width was reduced from ${annotation.style.strokeWidth}px to ${Number(markerSize.strokeWidth.toFixed(1))}px to fit the canvas.`
    );
  }
  if (labelStrokeWidth < requestedLabelStrokeWidth) {
    warnings.push(
      `Numbered callout ${annotation.id} label stroke width was reduced from ${requestedLabelStrokeWidth}px to ${labelStrokeWidth}px to fit the canvas.`
    );
  }
  if (leaderStrokeWidth < requestedLeaderStrokeWidth) {
    warnings.push(
      `Numbered callout ${annotation.id} leader stroke width was reduced from ${requestedLeaderStrokeWidth}px to ${leaderStrokeWidth}px to preserve target visibility.`
    );
  }
  if (chosen.decorationOverflow) {
    warnings.push(
      `Numbered callout ${annotation.id} final facing decoration footprint overflowed the canvas; no in-canvas candidate was available.`
    );
  }
  if (chosen.labelClipped) {
    warnings.push(
      `Numbered callout ${annotation.id} painted label border was clipped by the canvas.`
    );
  }
  if (chosen.markerClipped) {
    warnings.push(`Numbered callout ${annotation.id} painted marker was clipped by the canvas.`);
  }
  if (chosen.leaderClipped) {
    warnings.push(`Numbered callout ${annotation.id} painted leader was clipped by the canvas.`);
  }
  if (chosen.markerLabelOverlap) {
    warnings.push(
      `Numbered callout ${annotation.id} marker could not remain outside its label while staying inside the canvas.`
    );
  }
  if (chosen.markerTargetOverlap) {
    warnings.push(
      `Numbered callout ${annotation.id} marker overlaps its target because the requested placement cannot provide separate geometry.`
    );
  }
  if (chosen.labelTargetOverlap) {
    warnings.push(
      `Numbered callout ${annotation.id} label overlaps its target and hides the leader; a separate target-facing segment was not available.`
    );
  }
  if (chosen.collisionIds.length > 0) {
    warnings.push(
      `Numbered callout ${annotation.id} final label, marker, or leader geometry intersects ${chosen.collisionIds.length} occupied annotation${chosen.collisionIds.length === 1 ? "" : "s"}; no collision-free candidate was available.`
    );
  }
  if (!leaderIsVisible) {
    warnings.push(
      `Numbered callout ${annotation.id} leader is invisible because its resolved stroke width, opacity, or color alpha is zero.`
    );
  }
  if (chosen.leader.length + 0.001 < MINIMUM_VISIBLE_NUMBERED_LEADER) {
    warnings.push(
      `Numbered callout ${annotation.id} has only ${Number(chosen.leader.length.toFixed(1))}px of visible leader; ${MINIMUM_VISIBLE_NUMBERED_LEADER}px was not available.`
    );
  }

  let rendered: Buffer = base;
  if (chosen.leaderSegment) {
    rendered = await compositeStable(rendered, [
      {
        input: controlledSvg(
          width,
          height,
          leaderBody(chosen.leader.start, chosen.leader.end, leaderStyle)
        ),
        left: 0,
        top: 0
      }
    ]);
  }
  const backgroundStyle: RenderStyle = {
    ...annotation.style,
    fillColor: annotation.style.backgroundColor,
    strokeWidth: labelStrokeWidth,
    opacity: annotation.style.opacity
  };
  rendered = await compositeStable(rendered, [
    {
      input: controlledSvg(
        width,
        height,
        rectangleBody(chosen.box, backgroundStyle, annotation.style.cornerRadius)
      ),
      left: 0,
      top: 0
    },
    {
      input: sprite.buffer,
      left: Math.max(0, Math.round(chosen.box.x + padding)),
      top: Math.max(0, Math.round(chosen.box.y + padding))
    }
  ]);
  rendered = await renderNumberMarkerAt(
    rendered,
    annotation,
    number,
    chosen.marker.center,
    chosen.marker.radius,
    chosen.marker.strokeWidth,
    width,
    height,
    fontPath
  );
  return {
    buffer: rendered,
    box: chosen.box,
    paintedLabelBox: chosen.paintedLabelBox,
    ...(chosen.leaderBox ? { leaderBox: chosen.leaderBox } : {}),
    markerBox: chosen.markerBox,
    occupiedGeometry: {
      annotationId: annotation.id,
      rects: [chosen.paintedLabelBox, chosen.markerBox],
      segments: chosen.leaderSegment ? [chosen.leaderSegment] : []
    },
    resolved: {
      id: annotation.id,
      type: annotation.type,
      target: safeTarget,
      box: chosen.box,
      anchor: chosen.leader.start,
      targetAnchor: chosen.leader.end,
      placement: chosen.placement,
      text,
      fontSize: sprite.fontSize,
      number,
      marker: { ...chosen.marker, bounds: chosen.markerBox },
      label: {
        box: chosen.box,
        paintedBounds: chosen.paintedLabelBox,
        placement: chosen.placement,
        text,
        fontSize: sprite.fontSize,
        padding,
        strokeWidth: labelStrokeWidth
      },
      leader: {
        ...chosen.leader,
        ...(chosen.leaderBox ? { bounds: chosen.leaderBox } : {}),
        strokeWidth: leaderStrokeWidth
      },
      style: annotation.style
    }
  };
}

export async function resolveBundledFontPath(): Promise<string> {
  bundledFontPathPromise ??= (async () => {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(moduleDirectory, "../assets/fonts", BUNDLED_FONT_FILENAME),
      path.resolve(moduleDirectory, "../../assets/fonts", BUNDLED_FONT_FILENAME)
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next package layout. Source and bundled builds have different depths.
      }
    }
    throw new Error(
      `Bundled font ${BUNDLED_FONT_FILENAME} was not found beside the AgentCallout package.`
    );
  })();
  return bundledFontPathPromise;
}

function decodeUtf16Be(buffer: Buffer): string {
  const swapped = Buffer.allocUnsafe(buffer.length - (buffer.length % 2));
  for (let index = 0; index < swapped.length; index += 2) {
    swapped[index] = buffer[index + 1] ?? 0;
    swapped[index + 1] = buffer[index] ?? 0;
  }
  return swapped.toString("utf16le").replaceAll("\u0000", "").trim();
}

function readOpenTypeVersion(buffer: Buffer): string {
  if (buffer.length < 12) return "unknown";
  const tableCount = buffer.readUInt16BE(4);
  let nameOffset = -1;
  let nameLength = 0;
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = 12 + index * 16;
    if (recordOffset + 16 > buffer.length) break;
    if (buffer.toString("ascii", recordOffset, recordOffset + 4) === "name") {
      nameOffset = buffer.readUInt32BE(recordOffset + 8);
      nameLength = buffer.readUInt32BE(recordOffset + 12);
      break;
    }
  }
  if (nameOffset < 0 || nameOffset + nameLength > buffer.length || nameLength < 6) {
    return "unknown";
  }
  const count = buffer.readUInt16BE(nameOffset + 2);
  const stringsOffset = nameOffset + buffer.readUInt16BE(nameOffset + 4);
  const candidates: { priority: number; value: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const recordOffset = nameOffset + 6 + index * 12;
    if (recordOffset + 12 > nameOffset + nameLength) break;
    const platform = buffer.readUInt16BE(recordOffset);
    const language = buffer.readUInt16BE(recordOffset + 4);
    const nameId = buffer.readUInt16BE(recordOffset + 6);
    const length = buffer.readUInt16BE(recordOffset + 8);
    const relativeOffset = buffer.readUInt16BE(recordOffset + 10);
    if (nameId !== 5) continue;
    const start = stringsOffset + relativeOffset;
    const end = start + length;
    if (start < 0 || end > buffer.length) continue;
    const bytes = buffer.subarray(start, end);
    const value =
      platform === 0 || platform === 3 ? decodeUtf16Be(bytes) : bytes.toString("latin1").trim();
    if (value.length > 0) {
      const priority = platform === 3 && language === 0x0409 ? 0 : platform === 3 ? 1 : 2;
      candidates.push({ priority, value });
    }
  }
  candidates.sort((first, second) => first.priority - second.priority);
  return candidates[0]?.value ?? "unknown";
}

export async function getBundledFontInfo(fontPath?: string): Promise<RendererVersions["font"]> {
  if (fontPath) {
    const bytes = await readFile(fontPath);
    return {
      family: "Noto Sans CJK SC",
      file: path.basename(fontPath),
      version: readOpenTypeVersion(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }
  bundledFontInfoPromise ??= (async () => {
    const resolvedPath = await resolveBundledFontPath();
    return getBundledFontInfo(resolvedPath);
  })();
  return bundledFontInfoPromise;
}

export async function getRendererVersions(fontPath?: string): Promise<RendererVersions> {
  return {
    name: RENDERER_NAME,
    version: RENDERER_VERSION,
    sharp: sharp.versions.sharp,
    libvips: sharp.versions.vips,
    font: await getBundledFontInfo(fontPath)
  };
}

const RENDERER_LAYOUT_ISSUE_ORDER: readonly RendererLayoutIssueCode[] = [
  "TEXT_SIZE_REDUCED",
  "TEXT_CLIPPED",
  "TARGET_COVERED",
  "CALLOUT_OVERLAP",
  "LEADER_ROUTE_BLOCKED",
  "LEADER_TOO_SHORT",
  "GEOMETRY_CLIPPED",
  "INSUFFICIENT_SPACE"
];

function sortedLayoutIssues(issues: readonly RendererLayoutIssue[]): RendererLayoutIssue[] {
  const unique = new Map<string, RendererLayoutIssue>();
  for (const issue of issues) {
    const key = `${issue.code}\0${issue.annotationId}\0${issue.relatedIds.join("\0")}\0${issue.message}`;
    unique.set(key, issue);
  }
  return [...unique.values()].sort((left, right) => {
    const codeDifference =
      RENDERER_LAYOUT_ISSUE_ORDER.indexOf(left.code) -
      RENDERER_LAYOUT_ISSUE_ORDER.indexOf(right.code);
    if (codeDifference !== 0) return codeDifference;
    return left.message.localeCompare(right.message, "en");
  });
}

function denseIssue(issue: DenseLayoutDiagnostic): RendererLayoutIssue {
  return layoutIssue(issue.code, issue.annotationId, issue.message, issue.relatedIds);
}

function textSpriteIssues(
  annotation: RenderableAnnotation,
  kind: "Callout" | "Numbered callout" | "Text",
  sprite: TextSprite
): RendererLayoutIssue[] {
  const issues: RendererLayoutIssue[] = [];
  if (sprite.wasClipped) {
    issues.push(
      layoutIssue(
        "TEXT_CLIPPED",
        annotation.id,
        `${kind} ${annotation.id} text was clipped at ${sprite.fontSize}px from ${sprite.unclippedDimensions.width}x${sprite.unclippedDimensions.height} to ${sprite.width}x${sprite.height}; ${sprite.clippedAlphaPixelCount} visible alpha pixels were omitted.`,
        [],
        {
          requestedFontSize: annotation.style.fontSize,
          resolvedFontSize: sprite.fontSize,
          unclippedWidth: sprite.unclippedDimensions.width,
          unclippedHeight: sprite.unclippedDimensions.height,
          clippedWidth: sprite.width,
          clippedHeight: sprite.height,
          clippedAlphaPixelCount: sprite.clippedAlphaPixelCount
        }
      ),
      layoutIssue(
        "INSUFFICIENT_SPACE",
        annotation.id,
        `${kind} ${annotation.id} had insufficient text area even at the minimum supported font size.`
      )
    );
  } else if (sprite.wasShrunk) {
    issues.push(
      layoutIssue(
        "TEXT_SIZE_REDUCED",
        annotation.id,
        `${kind} ${annotation.id} font size was reduced from ${annotation.style.fontSize}px to ${sprite.fontSize}px to fit the available text area.`,
        [],
        { requestedFontSize: annotation.style.fontSize, resolvedFontSize: sprite.fontSize }
      )
    );
  }
  return issues;
}

function resolvedTargetGeometry(
  annotation: RenderableAnnotation,
  width: number,
  height: number
): { target: PixelPoint | PixelRect; layoutTarget: PixelRect } {
  const rawTarget = annotation.target ?? annotation.rect ?? annotation.position;
  if (!rawTarget) throw new Error(`${annotation.type} ${annotation.id} is missing a target.`);
  const target = isPixelRect(rawTarget)
    ? integerRect(rawTarget, width, height)
    : pointInCanvas(rawTarget, width, height);
  const layoutTarget = isPixelRect(target)
    ? target
    : integerRect({ x: target.x - 2, y: target.y - 2, width: 4, height: 4 }, width, height);
  return { target, layoutTarget };
}

async function measureVersion11TextAnnotation(
  annotation: RenderableAnnotation,
  width: number,
  height: number,
  fontPath: string
): Promise<PreparedTextAnnotation> {
  if (!annotation.position) throw new Error(`Text ${annotation.id} is missing position.`);
  const position = pointInCanvas(annotation.position, width, height);
  const maximumWidth = Math.max(
    1,
    Math.min(annotation.style.maxWidth, width - position.x - annotation.style.padding * 2)
  );
  const maximumHeight = Math.max(1, height - position.y - annotation.style.padding * 2);
  const sprite = await renderTextSprite(
    annotation.text ?? "",
    annotation.style,
    fontPath,
    maximumWidth,
    maximumHeight
  );
  const box = clampLabelBox(
    {
      x: position.x,
      y: position.y,
      width: Math.min(width, sprite.width + annotation.style.padding * 2),
      height: Math.min(height, sprite.height + annotation.style.padding * 2)
    },
    width,
    height,
    0
  );
  const issues = textSpriteIssues(annotation, "Text", sprite);
  if (box.x !== position.x || box.y !== position.y) {
    issues.push(
      layoutIssue(
        "GEOMETRY_CLIPPED",
        annotation.id,
        `Text ${annotation.id} was moved from (${position.x}, ${position.y}) to (${box.x}, ${box.y}) to stay inside the canvas.`
      )
    );
  }
  return { annotation, position, box, sprite, issues: sortedLayoutIssues(issues) };
}

async function measureVersion11DenseAnnotation(
  annotation: RenderableAnnotation,
  index: number,
  width: number,
  height: number,
  fontPath: string
): Promise<DenseAnnotationMeasurement> {
  const { target, layoutTarget } = resolvedTargetGeometry(annotation, width, height);
  const text = annotation.text ?? "";
  const margin = Math.min(4, Math.max(1, Math.floor((Math.min(width, height) - 1) / 4)));
  const issues: RendererLayoutIssue[] = [];
  if (annotation.type === "numbered-callout") {
    const maximumLabelWidth = Math.max(1, width - margin * 2);
    const maximumLabelHeight = Math.max(1, height - margin * 2);
    const minimumTextExtent = Math.min(12, maximumLabelWidth, maximumLabelHeight);
    const maximumPadding = Math.max(
      0,
      Math.floor((Math.min(maximumLabelWidth, maximumLabelHeight) - minimumTextExtent) / 2)
    );
    const requestedPadding = Math.round(annotation.style.padding);
    const padding = Math.min(requestedPadding, maximumPadding);
    const maximumTextWidth = Math.max(
      1,
      Math.min(annotation.style.maxWidth, maximumLabelWidth - padding * 2)
    );
    const maximumTextHeight = Math.max(1, maximumLabelHeight - padding * 2);
    const sprite = await renderTextSprite(
      text,
      annotation.style,
      fontPath,
      maximumTextWidth,
      maximumTextHeight,
      { allowClipping: true }
    );
    issues.push(...textSpriteIssues(annotation, "Numbered callout", sprite));
    if (padding < requestedPadding) {
      issues.push(
        layoutIssue(
          "GEOMETRY_CLIPPED",
          annotation.id,
          `Numbered callout ${annotation.id} padding was reduced from ${requestedPadding}px to ${padding}px to fit the canvas.`,
          [],
          { requestedPadding, resolvedPadding: padding }
        )
      );
    }
    const markerSize = numberedMarkerRadius(annotation, sprite.fontSize, width, height);
    const requestedStrokeWidth = visibleStrokeWidth(annotation.style);
    const labelStrokeWidth = Math.min(requestedStrokeWidth, margin * 2);
    const maximumLeaderStrokeWidth = Math.max(1, Math.min(8, markerSize.radius));
    const leaderStrokeWidth = Math.min(requestedStrokeWidth, maximumLeaderStrokeWidth);
    if (markerSize.radiusReduced) {
      issues.push(
        layoutIssue(
          "GEOMETRY_CLIPPED",
          annotation.id,
          `Numbered callout ${annotation.id} marker radius was reduced to fit the canvas.`
        )
      );
    }
    if (markerSize.strokeWidthReduced) {
      issues.push(
        layoutIssue(
          "GEOMETRY_CLIPPED",
          annotation.id,
          `Numbered callout ${annotation.id} marker stroke width was reduced from ${annotation.style.strokeWidth}px to ${Number(markerSize.strokeWidth.toFixed(1))}px to fit the canvas.`,
          [],
          {
            requestedStrokeWidth: annotation.style.strokeWidth,
            resolvedStrokeWidth: markerSize.strokeWidth
          }
        )
      );
    }
    if (labelStrokeWidth < requestedStrokeWidth) {
      issues.push(
        layoutIssue(
          "GEOMETRY_CLIPPED",
          annotation.id,
          `Numbered callout ${annotation.id} label stroke width was reduced from ${requestedStrokeWidth}px to ${labelStrokeWidth}px to fit the canvas.`,
          [],
          { requestedStrokeWidth, resolvedStrokeWidth: labelStrokeWidth }
        )
      );
    }
    if (leaderStrokeWidth < requestedStrokeWidth) {
      issues.push(
        layoutIssue(
          "GEOMETRY_CLIPPED",
          annotation.id,
          `Numbered callout ${annotation.id} leader stroke width was reduced from ${requestedStrokeWidth}px to ${leaderStrokeWidth}px to preserve target visibility.`,
          [],
          { requestedStrokeWidth, resolvedStrokeWidth: leaderStrokeWidth }
        )
      );
    }
    const paintedOutset = labelStrokeWidth / 2;
    const desiredGap =
      paintedOutset +
      markerSize.paintedRadius * 2 +
      MINIMUM_VISIBLE_NUMBERED_LEADER +
      NUMBERED_LEADER_RENDERING_ALLOWANCE;
    return {
      annotation,
      target,
      layoutTarget,
      text,
      number: annotation.number ?? index + 1,
      padding,
      sprite,
      labelStrokeWidth,
      leaderStrokeWidth,
      labelWidth: Math.min(maximumLabelWidth, sprite.width + padding * 2),
      labelHeight: Math.min(maximumLabelHeight, sprite.height + padding * 2),
      gap: desiredGap,
      paintedOutset,
      facingDecorationDepth: desiredGap,
      facingDecorationSpan: (markerSize.paintedRadius + paintedOutset) * 2,
      markerSize,
      issues: sortedLayoutIssues(issues)
    };
  }

  const padding = Math.round(annotation.style.padding);
  const maximumTextWidth = Math.max(
    1,
    Math.min(annotation.style.maxWidth, width - padding * 2 - 8)
  );
  const maximumTextHeight = Math.max(1, height - padding * 2 - 8);
  const sprite = await renderTextSprite(
    text,
    annotation.style,
    fontPath,
    maximumTextWidth,
    maximumTextHeight,
    { allowClipping: true }
  );
  issues.push(...textSpriteIssues(annotation, "Callout", sprite));
  const requestedStrokeWidth = visibleStrokeWidth(annotation.style);
  const labelStrokeWidth = Math.min(requestedStrokeWidth, margin * 2);
  const leaderStrokeWidth = Math.min(requestedStrokeWidth, 8);
  if (labelStrokeWidth < requestedStrokeWidth || leaderStrokeWidth < requestedStrokeWidth) {
    issues.push(
      layoutIssue(
        "GEOMETRY_CLIPPED",
        annotation.id,
        `Callout ${annotation.id} stroke widths were reduced to preserve in-canvas label and leader geometry.`,
        [],
        { requestedStrokeWidth, labelStrokeWidth, leaderStrokeWidth }
      )
    );
  }
  return {
    annotation,
    target,
    layoutTarget,
    text,
    padding,
    sprite,
    labelStrokeWidth,
    leaderStrokeWidth,
    labelWidth: Math.min(width - 8, sprite.width + padding * 2),
    labelHeight: Math.min(height - 8, sprite.height + padding * 2),
    gap: MINIMUM_VISIBLE_NUMBERED_LEADER + NUMBERED_LEADER_RENDERING_ALLOWANCE,
    paintedOutset: labelStrokeWidth / 2,
    facingDecorationDepth: 0,
    facingDecorationSpan: 0,
    issues: sortedLayoutIssues(issues)
  };
}

function measureVersion11Arrow(
  annotation: RenderableAnnotation,
  width: number,
  height: number
): ArrowMeasurement {
  const rawTarget = annotation.target ?? annotation.rect;
  const center = targetPoint(rawTarget);
  if (!center) throw new Error(`Arrow ${annotation.id} is missing target.`);
  const start = pointInCanvas(
    annotation.start ?? {
      x: center.x - Math.min(120, width / 4),
      y: center.y - Math.min(90, height / 4)
    },
    width,
    height
  );
  const target =
    rawTarget && isPixelRect(rawTarget)
      ? integerRect(rawTarget, width, height)
      : pointInCanvas(center, width, height);
  const end = pointInCanvas(
    isPixelRect(target) ? arrowEndpointOnRect(start, target) : target,
    width,
    height
  );
  return { annotation, start, target, end };
}

function compareNumericTuple(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (Math.abs(difference) > 1e-7) return difference;
  }
  return 0;
}

function prepareNumberedMarker(
  measurement: DenseAnnotationMeasurement,
  placement: DenseCalloutPlacement,
  allPlacements: readonly DenseCalloutPlacement[],
  targets: readonly RouteObstacle[],
  priorMarkers: readonly { id: string; marker: PreparedMarker }[],
  width: number,
  height: number
): { marker: PreparedMarker; issues: RendererLayoutIssue[] } {
  const markerSize = measurement.markerSize;
  if (markerSize === undefined) {
    throw new Error(`Numbered callout ${measurement.annotation.id} is missing marker geometry.`);
  }
  const paintedLabelBox = inflateRect(placement.box, measurement.paintedOutset);
  const orderedFaces = orderedMarkerFaces(
    placement.placement,
    paintedLabelBox,
    measurement.layoutTarget
  );
  const candidates = orderedFaces.candidates.map((face, faceOrder) => {
    const positioned = markerCenterForLabel(
      placement.placement,
      paintedLabelBox,
      measurement.layoutTarget,
      markerSize.paintedRadius,
      width,
      height,
      face.face
    );
    const marker: PreparedMarker = {
      center: positioned.center,
      radius: markerSize.radius,
      paintedRadius: markerSize.paintedRadius,
      strokeWidth: markerSize.strokeWidth,
      labelSide: positioned.face,
      bounds: {
        x: positioned.center.x - markerSize.paintedRadius,
        y: positioned.center.y - markerSize.paintedRadius,
        width: markerSize.paintedRadius * 2,
        height: markerSize.paintedRadius * 2
      }
    };
    const targetIds = targets
      .filter((target) => rectsOverlap(marker.bounds, target.rect))
      .map((target) => target.id);
    const labelIds = allPlacements
      .filter(
        (other) =>
          other.id !== measurement.annotation.id && rectsOverlap(marker.bounds, other.paintedBox)
      )
      .map((other) => `label:${other.id}`);
    const priorMarkerIds = priorMarkers
      .filter((other) => rectsOverlap(marker.bounds, other.marker.bounds))
      .map((other) => `marker:${other.id}`);
    const ownLabelOverlap = rectsOverlap(marker.bounds, paintedLabelBox);
    const clipped = !rectInsideCanvas(marker.bounds, width, height);
    return {
      marker,
      positioned,
      faceOrder,
      targetIds,
      labelIds,
      priorMarkerIds,
      ownLabelOverlap,
      clipped,
      score: [
        targetIds.length,
        labelIds.length + priorMarkerIds.length + Number(ownLabelOverlap),
        Number(clipped),
        faceOrder
      ]
    };
  });
  const selected = candidates.reduce((best, candidate) =>
    compareNumericTuple(candidate.score, best.score) < 0 ? candidate : best
  );
  const issues: RendererLayoutIssue[] = [];
  if (selected.targetIds.length > 0) {
    issues.push(
      layoutIssue(
        "TARGET_COVERED",
        measurement.annotation.id,
        `Numbered callout ${measurement.annotation.id} marker covers ${selected.targetIds.length} protected target${selected.targetIds.length === 1 ? "" : "s"}.`,
        selected.targetIds
      )
    );
  }
  const collisionIds = [
    ...selected.labelIds,
    ...selected.priorMarkerIds,
    ...(selected.ownLabelOverlap ? [`label:${measurement.annotation.id}`] : [])
  ];
  if (collisionIds.length > 0) {
    issues.push(
      layoutIssue(
        "CALLOUT_OVERLAP",
        measurement.annotation.id,
        `Numbered callout ${measurement.annotation.id} marker overlaps ${collisionIds.length} label or marker footprint${collisionIds.length === 1 ? "" : "s"}.`,
        collisionIds
      )
    );
  }
  if (selected.clipped) {
    issues.push(
      layoutIssue(
        "GEOMETRY_CLIPPED",
        measurement.annotation.id,
        `Numbered callout ${measurement.annotation.id} marker was shifted or clipped at the canvas edge.`
      )
    );
  }
  if (
    measurement.annotation.placement !== undefined &&
    measurement.annotation.placement !== "auto" &&
    (selected.positioned.wasClamped ||
      selected.marker.labelSide !== selected.positioned.preferredFace)
  ) {
    issues.push(
      layoutIssue(
        "GEOMETRY_CLIPPED",
        measurement.annotation.id,
        `Numbered callout ${measurement.annotation.id} marker moved to the ${selected.marker.labelSide} label edge to stay inside the canvas without overlapping its label.`
      )
    );
  }
  if (selected.targetIds.length > 0 || collisionIds.length > 0 || selected.clipped) {
    issues.push(
      layoutIssue(
        "INSUFFICIENT_SPACE",
        measurement.annotation.id,
        `Numbered callout ${measurement.annotation.id} had no marker position satisfying every protected geometry constraint.`,
        [...selected.targetIds, ...collisionIds]
      )
    );
  }
  return { marker: selected.marker, issues: sortedLayoutIssues(issues) };
}

function routeLayoutIssues(
  annotation: RenderableAnnotation,
  route: LeaderRoute,
  strokeWidth: number,
  width: number,
  height: number
): RendererLayoutIssue[] {
  const issues: RendererLayoutIssue[] = [];
  if (route.collisionIds.length > 0) {
    issues.push(
      layoutIssue(
        "LEADER_ROUTE_BLOCKED",
        annotation.id,
        `${annotation.type === "arrow" ? "Arrow" : "Callout"} ${annotation.id} has no collision-free routed path and intersects ${route.collisionIds.length} protected obstacle${route.collisionIds.length === 1 ? "" : "s"}.`,
        route.collisionIds
      )
    );
  }
  if (route.pathLength + 0.001 < MINIMUM_VISIBLE_NUMBERED_LEADER || strokeWidth <= 0) {
    const subject = annotation.type === "arrow" ? "Arrow" : "Callout";
    const message =
      strokeWidth <= 0
        ? `${subject} ${annotation.id} leader is invisible because its resolved stroke width, opacity, or color alpha is zero; 0px of visible leader is available.`
        : `${subject} ${annotation.id} has ${Number(route.pathLength.toFixed(1))}px of visible routed path; ${MINIMUM_VISIBLE_NUMBERED_LEADER}px with visible stroke was not available.`;
    issues.push(
      layoutIssue("LEADER_TOO_SHORT", annotation.id, message, [], {
        pathLength: route.pathLength,
        minimumPathLength: MINIMUM_VISIBLE_NUMBERED_LEADER
      })
    );
  }
  if (!rectInsideCanvas(route.bounds, width, height)) {
    const subject =
      annotation.type === "numbered-callout"
        ? `Numbered callout ${annotation.id} painted leader was clipped by the canvas.`
        : `${annotation.type === "arrow" ? "Arrow" : "Callout"} ${annotation.id} routed path was clipped by the canvas.`;
    issues.push(layoutIssue("GEOMETRY_CLIPPED", annotation.id, subject));
  }
  return sortedLayoutIssues(issues);
}

function invisibleLeaderRoute(point: PixelPoint, strokeWidth: number): LeaderRoute {
  const radius = Math.max(0.5, strokeWidth / 2);
  return {
    points: [point],
    segments: [],
    directDistance: 0,
    pathLength: 0,
    bendCount: 0,
    bounds: {
      x: point.x - radius,
      y: point.y - radius,
      width: radius * 2,
      height: radius * 2
    },
    collisionIds: [],
    diagnostics: []
  };
}

async function prepareVersion11Layout(
  renderable: readonly RenderableAnnotation[],
  width: number,
  height: number,
  fontPath: string
): Promise<Version11LayoutPlan> {
  const textEntries = await Promise.all(
    renderable
      .filter((annotation) => annotation.type === "text")
      .map((annotation) => measureVersion11TextAnnotation(annotation, width, height, fontPath))
  );
  const denseMeasurements = await Promise.all(
    renderable.flatMap((annotation, index) =>
      annotation.type === "callout" || annotation.type === "numbered-callout"
        ? [measureVersion11DenseAnnotation(annotation, index, width, height, fontPath)]
        : []
    )
  );
  const arrowMeasurements = renderable
    .filter((annotation) => annotation.type === "arrow")
    .map((annotation) => measureVersion11Arrow(annotation, width, height));
  const arrowTargets = arrowMeasurements.map((arrow) => ({
    id: arrow.annotation.id,
    rect: isPixelRect(arrow.target)
      ? arrow.target
      : integerRect(
          { x: arrow.target.x - 2, y: arrow.target.y - 2, width: 4, height: 4 },
          width,
          height
        )
  }));
  const denseLayout = layoutDenseCallouts({
    canvas: { width, height },
    items: denseMeasurements.map((measurement) => ({
      id: measurement.annotation.id,
      target: measurement.layoutTarget,
      box: { width: measurement.labelWidth, height: measurement.labelHeight },
      placement: measurement.annotation.placement ?? "auto",
      gap: measurement.gap,
      paintedOutset: measurement.paintedOutset + 3,
      facingDecorationDepth: measurement.facingDecorationDepth,
      facingDecorationSpan: measurement.facingDecorationSpan
    })),
    protectedTargets: arrowTargets,
    obstacles: textEntries.map((entry) => ({ id: `text:${entry.annotation.id}`, rect: entry.box })),
    margin: 4,
    gap: MINIMUM_VISIBLE_NUMBERED_LEADER + NUMBERED_LEADER_RENDERING_ALLOWANCE,
    clearance: 6,
    leaderStrokeWidth: 2,
    minimumLeaderLength: MINIMUM_VISIBLE_NUMBERED_LEADER
  });
  const placements = new Map(denseLayout.placements.map((placement) => [placement.id, placement]));
  const allTargets: RouteObstacle[] = [
    ...denseMeasurements.map((measurement) => ({
      id: `target:${measurement.annotation.id}`,
      rect: measurement.layoutTarget,
      clearance: 0
    })),
    ...arrowTargets.map((target) => ({
      id: `target:${target.id}`,
      rect: target.rect,
      clearance: 0
    }))
  ];
  const markerEntries: { id: string; marker: PreparedMarker; issues: RendererLayoutIssue[] }[] = [];
  for (const measurement of denseMeasurements) {
    if (measurement.annotation.type !== "numbered-callout") continue;
    const placement = placements.get(measurement.annotation.id);
    if (placement === undefined) throw new Error("Dense layout omitted a numbered callout.");
    const prepared = prepareNumberedMarker(
      measurement,
      placement,
      denseLayout.placements,
      allTargets,
      markerEntries,
      width,
      height
    );
    markerEntries.push({ id: measurement.annotation.id, ...prepared });
  }
  const markers = new Map(markerEntries.map((entry) => [entry.id, entry]));
  const staticObstacles: RouteObstacle[] = [
    ...textEntries.map((entry) => ({
      id: `text:${entry.annotation.id}`,
      rect: entry.box,
      clearance: 0
    })),
    ...denseLayout.placements.map((placement) => ({
      id: `label:${placement.id}`,
      rect: inflateRect(
        placement.box,
        denseMeasurements.find((measurement) => measurement.annotation.id === placement.id)
          ?.paintedOutset ?? 0
      ),
      clearance: 0
    })),
    ...markerEntries.map((entry) => ({
      id: `marker:${entry.id}`,
      rect: entry.marker.bounds,
      clearance: 0
    })),
    ...allTargets
  ];
  const dense = new Map<string, PreparedDenseAnnotation>();
  const arrows = new Map<string, PreparedArrowAnnotation>();

  for (const annotation of renderable) {
    if (annotation.type === "callout" || annotation.type === "numbered-callout") {
      const measurement = denseMeasurements.find(
        (candidate) => candidate.annotation.id === annotation.id
      );
      const placement = placements.get(annotation.id);
      if (measurement === undefined || placement === undefined) {
        throw new Error(`Dense layout omitted callout ${annotation.id}.`);
      }
      const markerEntry = markers.get(annotation.id);
      const endpoints =
        markerEntry === undefined
          ? { start: placement.anchor, end: placement.targetAnchor }
          : connectCircleToTarget(
              { center: markerEntry.marker.center, radius: markerEntry.marker.paintedRadius },
              measurement.target
            );
      const headObstacles = staticObstacles.filter(
        (obstacle) =>
          obstacle.id !== `marker:${annotation.id}` &&
          obstacle.id !== `target:${annotation.id}` &&
          !(
            obstacle.id.startsWith("target:") &&
            samePixelRect(obstacle.rect, measurement.layoutTarget)
          )
      );
      const obstacles =
        markerEntry === undefined
          ? headObstacles.filter((obstacle) => obstacle.id !== `label:${annotation.id}`)
          : headObstacles;
      const arrowRoute =
        markerEntry === undefined && measurement.leaderStrokeWidth > 0
          ? routeWithArrowHeadAvoidance(
              { width, height },
              endpoints.start,
              targetBoundaryCandidates(
                measurement.target,
                endpoints.end,
                Math.max(annotation.style.arrowHeadSize, measurement.leaderStrokeWidth * 2) + 2,
                { width, height },
                `target:${annotation.id}`
              ),
              obstacles,
              annotation.style,
              measurement.leaderStrokeWidth,
              headObstacles
            )
          : undefined;
      const route =
        measurement.leaderStrokeWidth <= 0
          ? invisibleLeaderRoute(endpoints.end, measurement.leaderStrokeWidth)
          : (arrowRoute?.route ??
            (markerEntry === undefined
              ? routeLeader({
                  canvas: { width, height },
                  start: endpoints.start,
                  end: endpoints.end,
                  obstacles,
                  clearance: 4,
                  strokeWidth: measurement.leaderStrokeWidth
                })
              : routeFromStartCandidates(
                  { width, height },
                  markerBoundaryCandidates(markerEntry.marker, endpoints.start),
                  endpoints.end,
                  obstacles,
                  4,
                  measurement.leaderStrokeWidth
                )));
      const headIssues: RendererLayoutIssue[] = [];
      if (arrowRoute !== undefined && arrowRoute.headCollisionIds.length > 0) {
        const targetIds = arrowRoute.headCollisionIds.filter((id) => id.startsWith("target:"));
        const geometryIds = arrowRoute.headCollisionIds.filter((id) => !id.startsWith("target:"));
        if (targetIds.length > 0) {
          headIssues.push(
            layoutIssue(
              "TARGET_COVERED",
              annotation.id,
              `Callout ${annotation.id} arrowhead covers ${targetIds.length} protected target${targetIds.length === 1 ? "" : "s"}.`,
              targetIds
            )
          );
        }
        if (geometryIds.length > 0) {
          headIssues.push(
            layoutIssue(
              "CALLOUT_OVERLAP",
              annotation.id,
              `Callout ${annotation.id} arrowhead overlaps ${geometryIds.length} protected label or marker${geometryIds.length === 1 ? "" : "s"}.`,
              geometryIds
            )
          );
        }
        headIssues.push(
          layoutIssue(
            "INSUFFICIENT_SPACE",
            annotation.id,
            `Callout ${annotation.id} had no route whose arrowhead cleared every protected geometry.`,
            arrowRoute.headCollisionIds
          )
        );
      }
      const issues = sortedLayoutIssues([
        ...measurement.issues,
        ...placement.diagnostics
          .filter(
            (issue) => issue.code !== "LEADER_ROUTE_BLOCKED" && issue.code !== "LEADER_TOO_SHORT"
          )
          .map(denseIssue),
        ...(markerEntry?.issues ?? []),
        ...headIssues,
        ...routeLayoutIssues(annotation, route, measurement.leaderStrokeWidth, width, height)
      ]);
      dense.set(annotation.id, {
        annotation,
        target: measurement.target,
        layoutTarget: measurement.layoutTarget,
        text: measurement.text,
        ...(measurement.number === undefined ? {} : { number: measurement.number }),
        padding: measurement.padding,
        sprite: measurement.sprite,
        labelStrokeWidth: measurement.labelStrokeWidth,
        leaderStrokeWidth: measurement.leaderStrokeWidth,
        placement,
        paintedLabelBox: inflateRect(placement.box, measurement.paintedOutset),
        ...(markerEntry === undefined ? {} : { marker: markerEntry.marker }),
        route,
        ...(arrowRoute === undefined ? {} : { arrowHead: arrowRoute.arrowHead }),
        issues
      });
      continue;
    }
    if (annotation.type === "arrow") {
      const measurement = arrowMeasurements.find(
        (candidate) => candidate.annotation.id === annotation.id
      );
      if (measurement === undefined)
        throw new Error(`Dense layout omitted arrow ${annotation.id}.`);
      const excludedIds = new Set([`target:${annotation.id}`]);
      const arrowStrokeWidth = visibleStrokeWidth(annotation.style);
      const ownTarget = isPixelRect(measurement.target)
        ? measurement.target
        : integerRect(
            {
              x: measurement.target.x - 2,
              y: measurement.target.y - 2,
              width: 4,
              height: 4
            },
            width,
            height
          );
      const obstacles = staticObstacles.filter(
        (obstacle) =>
          !excludedIds.has(obstacle.id) &&
          !(obstacle.id.startsWith("target:") && samePixelRect(obstacle.rect, ownTarget))
      );
      const planned =
        arrowStrokeWidth <= 0
          ? {
              route: invisibleLeaderRoute(measurement.end, arrowStrokeWidth),
              arrowHead: arrowHeadGeometry([measurement.end], annotation.style),
              headCollisionIds: [] as string[]
            }
          : routeWithArrowHeadAvoidance(
              { width, height },
              measurement.start,
              targetBoundaryCandidates(
                measurement.target,
                measurement.end,
                Math.max(annotation.style.arrowHeadSize, arrowStrokeWidth * 2) + 2,
                { width, height },
                `target:${annotation.id}`
              ),
              obstacles,
              annotation.style,
              arrowStrokeWidth
            );
      const { route, arrowHead } = planned;
      const issues = routeLayoutIssues(annotation, route, arrowStrokeWidth, width, height);
      if (planned.headCollisionIds.length > 0) {
        const targetIds = planned.headCollisionIds.filter((id) => id.startsWith("target:"));
        const geometryIds = planned.headCollisionIds.filter((id) => !id.startsWith("target:"));
        if (targetIds.length > 0) {
          issues.push(
            layoutIssue(
              "TARGET_COVERED",
              annotation.id,
              `Arrow ${annotation.id} head covers ${targetIds.length} protected target${targetIds.length === 1 ? "" : "s"}.`,
              targetIds
            )
          );
        }
        if (geometryIds.length > 0) {
          issues.push(
            layoutIssue(
              "CALLOUT_OVERLAP",
              annotation.id,
              `Arrow ${annotation.id} head overlaps ${geometryIds.length} protected label or marker${geometryIds.length === 1 ? "" : "s"}.`,
              geometryIds
            )
          );
        }
        issues.push(
          layoutIssue(
            "INSUFFICIENT_SPACE",
            annotation.id,
            `Arrow ${annotation.id} had no route whose head cleared every protected geometry.`,
            planned.headCollisionIds
          )
        );
      }
      if (!rectInsideCanvas(arrowHead.bounds, width, height)) {
        issues.push(
          layoutIssue(
            "GEOMETRY_CLIPPED",
            annotation.id,
            `Arrow ${annotation.id} head was clipped by the canvas.`
          )
        );
      }
      arrows.set(annotation.id, {
        annotation,
        start: measurement.start,
        target: measurement.target,
        end: route.points.at(-1) ?? measurement.end,
        route,
        arrowHead,
        issues: sortedLayoutIssues(issues)
      });
    }
  }

  const text = new Map(textEntries.map((entry) => [entry.annotation.id, entry]));
  const order = new Map(renderable.map((annotation, index) => [annotation.id, index]));
  const allIssues = [
    ...textEntries.flatMap((entry) => entry.issues),
    ...[...dense.values()].flatMap((entry) => entry.issues),
    ...[...arrows.values()].flatMap((entry) => entry.issues)
  ].sort((left, right) => {
    const indexDifference =
      (order.get(left.annotationId) ?? 0) - (order.get(right.annotationId) ?? 0);
    if (indexDifference !== 0) return indexDifference;
    return (
      RENDERER_LAYOUT_ISSUE_ORDER.indexOf(left.code) -
      RENDERER_LAYOUT_ISSUE_ORDER.indexOf(right.code)
    );
  });
  return {
    text,
    dense,
    arrows,
    warnings: allIssues.map((issue) => `[${issue.code}] ${issue.message}`)
  };
}

async function renderPreparedTextAnnotation(
  base: Buffer,
  prepared: PreparedTextAnnotation,
  width: number,
  height: number
): Promise<{ buffer: Buffer; resolved: Record<string, unknown> }> {
  const { annotation, box, position, sprite } = prepared;
  const backgroundStyle = {
    ...annotation.style,
    fillColor: annotation.style.backgroundColor,
    opacity: annotation.style.backgroundColor === "transparent" ? 0 : annotation.style.opacity
  };
  const overlays: OverlayOptions[] = [];
  if (backgroundStyle.opacity > 0) {
    overlays.push({
      input: controlledSvg(
        width,
        height,
        rectangleBody(box, backgroundStyle, annotation.style.cornerRadius)
      ),
      left: 0,
      top: 0
    });
  }
  overlays.push({
    input: sprite.buffer,
    left: Math.round(box.x + annotation.style.padding),
    top: Math.round(box.y + annotation.style.padding)
  });
  return {
    buffer: await compositeStable(base, overlays),
    resolved: {
      id: annotation.id,
      type: annotation.type,
      position,
      box,
      text: annotation.text ?? "",
      fontSize: sprite.fontSize,
      layout: layoutResult(prepared.issues)
    }
  };
}

async function renderPreparedDenseAnnotation(
  base: Buffer,
  prepared: PreparedDenseAnnotation,
  width: number,
  height: number,
  fontPath: string
): Promise<{ buffer: Buffer; resolved: Record<string, unknown> }> {
  const { annotation, placement, route, sprite } = prepared;
  let rendered = base;
  if (route.segments.length > 0 && prepared.leaderStrokeWidth > 0) {
    const routeStyle = { ...annotation.style, strokeWidth: prepared.leaderStrokeWidth };
    const body =
      annotation.type === "numbered-callout"
        ? routedLeaderBody(route.points, routeStyle)
        : routedArrowBody(route.points, routeStyle);
    rendered = await compositeStable(rendered, [
      { input: controlledSvg(width, height, body), left: 0, top: 0 }
    ]);
  }
  const backgroundStyle: RenderStyle = {
    ...annotation.style,
    fillColor: annotation.style.backgroundColor,
    strokeWidth: prepared.labelStrokeWidth,
    opacity: annotation.style.opacity
  };
  rendered = await compositeStable(rendered, [
    {
      input: controlledSvg(
        width,
        height,
        rectangleBody(placement.box, backgroundStyle, annotation.style.cornerRadius)
      ),
      left: 0,
      top: 0
    },
    {
      input: sprite.buffer,
      left: Math.max(0, Math.round(placement.box.x + prepared.padding)),
      top: Math.max(0, Math.round(placement.box.y + prepared.padding))
    }
  ]);
  if (prepared.marker !== undefined) {
    rendered = await renderNumberMarkerAt(
      rendered,
      annotation,
      prepared.number ?? 1,
      prepared.marker.center,
      prepared.marker.radius,
      prepared.marker.strokeWidth,
      width,
      height,
      fontPath
    );
  }
  const routeRecord = resolvedRoute(route, prepared.leaderStrokeWidth);
  const common = {
    id: annotation.id,
    type: annotation.type,
    target: prepared.target,
    box: placement.box,
    anchor: routeRecord.start,
    targetAnchor: routeRecord.end,
    placement: placement.placement,
    text: prepared.text,
    fontSize: sprite.fontSize,
    leader: routeRecord,
    ...(prepared.arrowHead === undefined ? {} : { arrowHead: prepared.arrowHead }),
    layout: layoutResult(prepared.issues),
    style: annotation.style
  };
  return {
    buffer: rendered,
    resolved:
      prepared.marker === undefined
        ? {
            ...common,
            label: {
              box: placement.box,
              paintedBounds: prepared.paintedLabelBox,
              placement: placement.placement,
              text: prepared.text,
              fontSize: sprite.fontSize,
              padding: prepared.padding,
              strokeWidth: prepared.labelStrokeWidth
            }
          }
        : {
            ...common,
            number: prepared.number,
            marker: prepared.marker,
            label: {
              box: placement.box,
              paintedBounds: prepared.paintedLabelBox,
              placement: placement.placement,
              text: prepared.text,
              fontSize: sprite.fontSize,
              padding: prepared.padding,
              strokeWidth: prepared.labelStrokeWidth
            }
          }
  };
}

async function renderPreparedArrowAnnotation(
  base: Buffer,
  prepared: PreparedArrowAnnotation,
  width: number,
  height: number
): Promise<{ buffer: Buffer; resolved: Record<string, unknown> }> {
  const strokeWidth = visibleStrokeWidth(prepared.annotation.style);
  const rendered =
    prepared.route.segments.length === 0 || strokeWidth <= 0
      ? base
      : await compositeStable(base, [
          {
            input: controlledSvg(
              width,
              height,
              routedArrowBody(prepared.route.points, prepared.annotation.style)
            ),
            left: 0,
            top: 0
          }
        ]);
  return {
    buffer: rendered,
    resolved: {
      id: prepared.annotation.id,
      type: prepared.annotation.type,
      start: prepared.start,
      target: prepared.target,
      end: prepared.end,
      path: resolvedRoute(prepared.route, strokeWidth),
      arrowHead: prepared.arrowHead,
      layout: layoutResult(prepared.issues),
      style: prepared.annotation.style
    }
  };
}

export async function renderAnnotations(
  input: Buffer,
  annotations: readonly unknown[],
  options: RenderAnnotationsOptions = {}
): Promise<RenderAnnotationsResult> {
  const limitInputPixels = options.limitInputPixels ?? 40_000_000;
  const specVersion: unknown = options.specVersion === undefined ? "1.0" : options.specVersion;
  if (specVersion !== "1.0" && specVersion !== "1.1") {
    throw new Error(`Unsupported renderer AnnotationSpec version: ${String(specVersion)}.`);
  }
  const normalized = await sharp(input, { failOn: "error", limitInputPixels })
    .autoOrient()
    .toColourspace("srgb")
    .png(STABLE_PNG_OPTIONS)
    .toBuffer({ resolveWithObject: true });
  const width = normalized.info.width;
  const height = normalized.info.height;
  const fontPath = options.fontPath ?? (await resolveBundledFontPath());
  const renderable = annotations.map(normalizeAnnotation);
  const warnings: string[] = [];
  const resolvedAnnotations: Record<string, unknown>[] = [];
  const occupied: PixelRect[] = [];
  const occupiedGroups: OccupiedGeometry[] = [];
  let current: Buffer<ArrayBufferLike> = normalized.data;
  let usesBlur = false;
  let usesRedact = false;
  const version11Layout =
    specVersion === "1.1"
      ? await prepareVersion11Layout(renderable, width, height, fontPath)
      : undefined;
  if (version11Layout !== undefined) warnings.push(...version11Layout.warnings);

  for (let index = 0; index < renderable.length; index += 1) {
    const annotation = renderable[index];
    if (!annotation) continue;
    const style = annotation.style;
    if (
      annotation.type === "rectangle" ||
      annotation.type === "ellipse" ||
      annotation.type === "highlight" ||
      annotation.type === "spotlight" ||
      annotation.type === "blur" ||
      annotation.type === "redact"
    ) {
      if (!annotation.rect) throw new Error(`${annotation.type} ${annotation.id} is missing rect.`);
      const rect = integerRect(annotation.rect, width, height);
      if (annotation.type === "blur") {
        const blurred = await sharp(current)
          .extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
          .blur(style.blurSigma)
          .png(STABLE_PNG_OPTIONS)
          .toBuffer();
        current = await compositeStable(current, [{ input: blurred, left: rect.x, top: rect.y }]);
        usesBlur = true;
      } else if (annotation.type === "redact") {
        const overlay = await sharp({
          create: {
            width: rect.width,
            height: rect.height,
            channels: 4,
            background: opaqueColor(style.fillColor)
          }
        })
          .png(STABLE_PNG_OPTIONS)
          .toBuffer();
        current = await compositeStable(current, [{ input: overlay, left: rect.x, top: rect.y }]);
        usesRedact = true;
      } else {
        const body =
          annotation.type === "ellipse"
            ? ellipseBody(rect, style)
            : annotation.type === "spotlight"
              ? spotlightBody(width, height, rect, style)
              : rectangleBody(rect, style, style.cornerRadius);
        current = await compositeStable(current, [
          { input: controlledSvg(width, height, body), left: 0, top: 0 }
        ]);
      }
      resolvedAnnotations.push({ id: annotation.id, type: annotation.type, rect, style });
      continue;
    }

    if (annotation.type === "arrow") {
      if (version11Layout !== undefined) {
        const prepared = version11Layout.arrows.get(annotation.id);
        if (prepared === undefined) throw new Error(`Missing prepared arrow ${annotation.id}.`);
        const rendered = await renderPreparedArrowAnnotation(current, prepared, width, height);
        current = rendered.buffer;
        resolvedAnnotations.push(rendered.resolved);
        continue;
      }
      const rawTarget = annotation.target ?? annotation.rect;
      const center = targetPoint(rawTarget);
      if (!center) throw new Error(`Arrow ${annotation.id} is missing target.`);
      const safeStart = pointInCanvas(
        annotation.start ?? {
          x: center.x - Math.min(120, width / 4),
          y: center.y - Math.min(90, height / 4)
        },
        width,
        height
      );
      const resolvedTarget =
        rawTarget && isPixelRect(rawTarget) ? integerRect(rawTarget, width, height) : rawTarget;
      const safeEnd = pointInCanvas(
        resolvedTarget && isPixelRect(resolvedTarget)
          ? arrowEndpointOnRect(safeStart, resolvedTarget)
          : (resolvedTarget ?? center),
        width,
        height
      );
      current = await compositeStable(current, [
        {
          input: controlledSvg(width, height, arrowBody(safeStart, safeEnd, style)),
          left: 0,
          top: 0
        }
      ]);
      resolvedAnnotations.push({
        id: annotation.id,
        type: annotation.type,
        start: safeStart,
        target: resolvedTarget,
        end: safeEnd,
        style
      });
      continue;
    }

    if (annotation.type === "text") {
      if (version11Layout !== undefined) {
        const prepared = version11Layout.text.get(annotation.id);
        if (prepared === undefined) throw new Error(`Missing prepared text ${annotation.id}.`);
        const rendered = await renderPreparedTextAnnotation(current, prepared, width, height);
        current = rendered.buffer;
        occupied.push(prepared.box);
        occupiedGroups.push({ annotationId: annotation.id, rects: [prepared.box], segments: [] });
        resolvedAnnotations.push(rendered.resolved);
        continue;
      }
      if (!annotation.position) throw new Error(`Text ${annotation.id} is missing position.`);
      const position = pointInCanvas(annotation.position, width, height);
      const maximumWidth = Math.max(
        1,
        Math.min(style.maxWidth, width - position.x - style.padding * 2)
      );
      const maximumHeight = Math.max(1, height - position.y - style.padding * 2);
      const sprite = await renderTextSprite(
        annotation.text ?? "",
        style,
        fontPath,
        maximumWidth,
        maximumHeight
      );
      if (sprite.wasShrunk) {
        warnings.push(
          `Text ${annotation.id} font size was reduced from ${style.fontSize}px to ${sprite.fontSize}px to keep all text inside the canvas.`
        );
      }
      const box = clampLabelBox(
        {
          x: position.x,
          y: position.y,
          width: Math.min(width, sprite.width + style.padding * 2),
          height: Math.min(height, sprite.height + style.padding * 2)
        },
        width,
        height,
        0
      );
      if (box.x !== position.x || box.y !== position.y) {
        warnings.push(
          `Text ${annotation.id} was moved from (${position.x}, ${position.y}) to (${box.x}, ${box.y}) to keep all text inside the canvas.`
        );
      }
      const backgroundStyle = {
        ...style,
        fillColor: style.backgroundColor,
        opacity: style.backgroundColor === "transparent" ? 0 : style.opacity
      };
      const overlays: OverlayOptions[] = [];
      if (backgroundStyle.opacity > 0) {
        overlays.push({
          input: controlledSvg(
            width,
            height,
            rectangleBody(box, backgroundStyle, style.cornerRadius)
          ),
          left: 0,
          top: 0
        });
      }
      overlays.push({
        input: sprite.buffer,
        left: Math.round(box.x + style.padding),
        top: Math.round(box.y + style.padding)
      });
      current = await compositeStable(current, overlays);
      occupied.push(box);
      occupiedGroups.push({ annotationId: annotation.id, rects: [box], segments: [] });
      resolvedAnnotations.push({
        id: annotation.id,
        type: annotation.type,
        position,
        box,
        text: annotation.text ?? "",
        fontSize: sprite.fontSize
      });
      continue;
    }

    if (annotation.type === "numbered-callout") {
      const number = annotation.number ?? index + 1;
      if (specVersion === "1.1") {
        const prepared = version11Layout?.dense.get(annotation.id);
        if (prepared === undefined) {
          throw new Error(`Missing prepared numbered callout ${annotation.id}.`);
        }
        const callout = await renderVersion11NumberedCallout(
          current,
          annotation,
          number,
          width,
          height,
          fontPath,
          occupiedGroups,
          warnings,
          prepared
        );
        current = callout.buffer;
        const markerBounds = prepared.marker?.bounds;
        const occupiedRects = [
          prepared.paintedLabelBox,
          ...(markerBounds === undefined ? [] : [markerBounds]),
          ...(prepared.route.segments.length === 0 ? [] : [prepared.route.bounds])
        ];
        occupied.push(unionRects(occupiedRects));
        occupiedGroups.push({
          annotationId: annotation.id,
          rects: [prepared.paintedLabelBox, ...(markerBounds === undefined ? [] : [markerBounds])],
          segments: prepared.route.segments.map((segment) => ({
            ...segment,
            strokeWidth: prepared.leaderStrokeWidth
          }))
        });
        resolvedAnnotations.push(callout.resolved);
        continue;
      }
      const marker = await renderNumberMarker(current, annotation, number, width, height, fontPath);
      const requestedMarkerPoint = targetPoint(
        annotation.target ?? annotation.rect ?? annotation.position
      );
      if (
        requestedMarkerPoint &&
        (marker.center.x !== Math.round(requestedMarkerPoint.x) ||
          marker.center.y !== Math.round(requestedMarkerPoint.y))
      ) {
        warnings.push(
          `Numbered callout ${annotation.id} marker was moved to stay inside the canvas.`
        );
      }
      if (marker.radiusReduced) {
        warnings.push(
          `Numbered callout ${annotation.id} marker radius was reduced to fit the canvas.`
        );
      }
      const markerBox = {
        x: marker.center.x - marker.radius,
        y: marker.center.y - marker.radius,
        width: marker.radius * 2,
        height: marker.radius * 2
      };
      occupied.push(markerBox);
      occupiedGroups.push({ annotationId: annotation.id, rects: [markerBox], segments: [] });
      current = marker.buffer;
      if ((annotation.text ?? "").length > 0) {
        const callout = await renderCallout(
          current,
          annotation,
          width,
          height,
          fontPath,
          occupied,
          warnings
        );
        current = callout.buffer;
        if (callout.box) {
          occupied.push(callout.box);
          const group = occupiedGroups.at(-1);
          if (group?.annotationId === annotation.id) group.rects.push(callout.box);
        }
        resolvedAnnotations.push({
          ...callout.resolved,
          number,
          marker: { center: marker.center, radius: marker.radius }
        });
      } else {
        resolvedAnnotations.push({
          id: annotation.id,
          type: annotation.type,
          number,
          marker: { center: marker.center, radius: marker.radius }
        });
      }
      continue;
    }

    const prepared = version11Layout?.dense.get(annotation.id);
    const callout =
      prepared === undefined
        ? await renderCallout(current, annotation, width, height, fontPath, occupied, warnings)
        : await renderPreparedDenseAnnotation(current, prepared, width, height, fontPath);
    current = callout.buffer;
    const occupiedBox = prepared?.paintedLabelBox ?? (callout as { box?: PixelRect }).box;
    if (occupiedBox) {
      occupied.push(occupiedBox);
      occupiedGroups.push({
        annotationId: annotation.id,
        rects: [occupiedBox],
        segments:
          prepared?.route.segments.map((segment) => ({
            ...segment,
            strokeWidth: prepared.leaderStrokeWidth
          })) ?? []
      });
    }
    resolvedAnnotations.push(callout.resolved);
  }

  const decoded = await sharp(current, { failOn: "error", limitInputPixels }).metadata();
  if (decoded.format !== "png" || decoded.width !== width || decoded.height !== height) {
    throw new Error("Renderer output failed PNG re-decode validation.");
  }
  return {
    buffer: current,
    width,
    height,
    warnings,
    usesBlur,
    usesRedact,
    resolvedAnnotations,
    renderer: await getRendererVersions(fontPath)
  };
}
