import { z } from "zod";

export const ANNOTATION_SPEC_VERSION = "1.0" as const;

export const ANNOTATION_TYPES = [
  "rectangle",
  "ellipse",
  "arrow",
  "text",
  "callout",
  "numbered-callout",
  "highlight",
  "spotlight",
  "blur",
  "redact"
] as const;

export type AnnotationType = (typeof ANNOTATION_TYPES)[number];
export type CoordinateSpace = "pixel" | "normalized";
export type CalloutPlacementPreference = "auto" | "top" | "right" | "bottom" | "left";

const finiteNumberSchema = z.number().finite();
const positiveFiniteNumberSchema = finiteNumberSchema.positive();

const pointSchema = z
  .object({
    x: finiteNumberSchema,
    y: finiteNumberSchema
  })
  .strict();

const rectSchema = z
  .object({
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    width: positiveFiniteNumberSchema,
    height: positiveFiniteNumberSchema
  })
  .strict();

const targetSchema = z.union([pointSchema, rectSchema]);

/** A CSS-independent color accepted by AnnotationSpec. Alpha, when present, is last. */
const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, {
    message: "Expected a hex color in #RRGGBB or #RRGGBBAA format"
  })
  .transform((value) => value.toUpperCase());

/** Redaction colors deliberately cannot carry an alpha channel. */
const opaqueHexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, {
    message: "Redact color must be opaque #RRGGBB"
  })
  .transform((value) => value.toUpperCase());

const annotationIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
    message: "Annotation ID must use only ASCII letters, digits, _ or -"
  });

const styleSchema = z
  .object({
    strokeColor: hexColorSchema.optional(),
    fillColor: hexColorSchema.optional(),
    textColor: hexColorSchema.optional(),
    backgroundColor: hexColorSchema.optional(),
    strokeWidth: finiteNumberSchema.min(0).max(64).optional(),
    fontSize: finiteNumberSchema.min(6).max(256).optional(),
    opacity: finiteNumberSchema.min(0).max(1).optional(),
    padding: finiteNumberSchema.min(0).max(128).optional(),
    cornerRadius: finiteNumberSchema.min(0).max(256).optional(),
    lineHeight: finiteNumberSchema.min(1).max(3).optional(),
    arrowHeadSize: finiteNumberSchema.min(1).max(128).optional()
  })
  .strict();

const commonAnnotationShape = {
  id: annotationIdSchema.optional(),
  coordinateSpace: z.enum(["pixel", "normalized"]).optional(),
  style: styleSchema.optional()
};

const rectangleAnnotationSchema = z
  .object({
    ...commonAnnotationShape,
    type: z.literal("rectangle"),
    rect: rectSchema
  })
  .strict();

const ellipseAnnotationSchema = z
  .object({
    ...commonAnnotationShape,
    type: z.literal("ellipse"),
    rect: rectSchema
  })
  .strict();

const arrowAnnotationSchema = z
  .object({
    ...commonAnnotationShape,
    type: z.literal("arrow"),
    start: pointSchema,
    target: targetSchema
  })
  .strict();

const textAnnotationSchema = z
  .object({
    ...commonAnnotationShape,
    type: z.literal("text"),
    position: pointSchema,
    text: z.string().min(1).max(10_000)
  })
  .strict();

const calloutAnnotationSchema = z
  .object({
    ...commonAnnotationShape,
    type: z.literal("callout"),
    target: targetSchema,
    text: z.string().min(1).max(10_000),
    placement: z.enum(["auto", "top", "right", "bottom", "left"]).default("auto")
  })
  .strict();

const numberedCalloutAnnotationSchema = z
  .object({
    ...commonAnnotationShape,
    type: z.literal("numbered-callout"),
    target: targetSchema,
    text: z.string().min(1).max(10_000),
    number: z.number().int().min(1).max(9_999),
    placement: z.enum(["auto", "top", "right", "bottom", "left"]).default("auto")
  })
  .strict();

const highlightAnnotationSchema = z
  .object({
    ...commonAnnotationShape,
    type: z.literal("highlight"),
    rect: rectSchema
  })
  .strict();

const spotlightAnnotationSchema = z
  .object({
    ...commonAnnotationShape,
    type: z.literal("spotlight"),
    rect: rectSchema
  })
  .strict();

const blurAnnotationSchema = z
  .object({
    ...commonAnnotationShape,
    type: z.literal("blur"),
    rect: rectSchema,
    sigma: finiteNumberSchema.min(0.3).max(1_000).default(10)
  })
  .strict();

const redactAnnotationSchema = z
  .object({
    ...commonAnnotationShape,
    type: z.literal("redact"),
    rect: rectSchema,
    color: opaqueHexColorSchema.default("#000000")
  })
  .strict();

const annotationUnionSchema = z.discriminatedUnion("type", [
  rectangleAnnotationSchema,
  ellipseAnnotationSchema,
  arrowAnnotationSchema,
  textAnnotationSchema,
  calloutAnnotationSchema,
  numberedCalloutAnnotationSchema,
  highlightAnnotationSchema,
  spotlightAnnotationSchema,
  blurAnnotationSchema,
  redactAnnotationSchema
]);

type ParsedAnnotationWithOptionalId = z.output<typeof annotationUnionSchema>;
type WithRequiredId<T> = T extends unknown ? Omit<T, "id"> & { id: string } : never;

export type Point = z.output<typeof pointSchema>;
export type Rect = z.output<typeof rectSchema>;
export type AnnotationTarget = z.output<typeof targetSchema>;
export type AnnotationStyle = z.output<typeof styleSchema>;
export type AnnotationInput = z.input<typeof annotationUnionSchema>;
export type Annotation = WithRequiredId<ParsedAnnotationWithOptionalId>;
export type RectangleAnnotation = Extract<Annotation, { type: "rectangle" }>;
export type EllipseAnnotation = Extract<Annotation, { type: "ellipse" }>;
export type ArrowAnnotation = Extract<Annotation, { type: "arrow" }>;
export type TextAnnotation = Extract<Annotation, { type: "text" }>;
export type CalloutAnnotation = Extract<Annotation, { type: "callout" }>;
export type NumberedCalloutAnnotation = Extract<Annotation, { type: "numbered-callout" }>;
export type HighlightAnnotation = Extract<Annotation, { type: "highlight" }>;
export type SpotlightAnnotation = Extract<Annotation, { type: "spotlight" }>;
export type BlurAnnotation = Extract<Annotation, { type: "blur" }>;
export type RedactAnnotation = Extract<Annotation, { type: "redact" }>;

export interface AnnotationSpec {
  version: typeof ANNOTATION_SPEC_VERSION;
  coordinateSpace: CoordinateSpace;
  annotations: Annotation[];
}

const rawAnnotationSpecSchema = z
  .object({
    version: z.literal(ANNOTATION_SPEC_VERSION),
    coordinateSpace: z.enum(["pixel", "normalized"]).default("pixel"),
    annotations: z.array(annotationUnionSchema)
  })
  .strict()
  .superRefine((spec, context) => {
    const seenIds = new Map<string, number>();

    for (const [index, annotation] of spec.annotations.entries()) {
      if (annotation.id !== undefined) {
        const previousIndex = seenIds.get(annotation.id);
        if (previousIndex !== undefined) {
          context.addIssue({
            code: "custom",
            message: `Duplicate annotation ID ${JSON.stringify(annotation.id)} (first used at index ${previousIndex})`,
            path: ["annotations", index, "id"]
          });
        } else {
          seenIds.set(annotation.id, index);
        }
      }

      const coordinateSpace = annotation.coordinateSpace ?? spec.coordinateSpace;
      if (coordinateSpace === "normalized") {
        validateNormalizedGeometry(annotation, index, context);
      }

      if (
        annotation.type === "redact" &&
        annotation.style?.opacity !== undefined &&
        annotation.style.opacity !== 1
      ) {
        context.addIssue({
          code: "custom",
          message: "Redact opacity must be 1; use blur for reversible visual obscuring",
          path: ["annotations", index, "style", "opacity"]
        });
      }
    }
  });

/**
 * Strict AnnotationSpec v1 schema. Parsing also supplies the root coordinate-space
 * default and deterministic IDs for annotations that omitted one.
 */
export const annotationSpecSchema = rawAnnotationSpecSchema.transform((spec): AnnotationSpec => {
  const reservedIds = new Set(
    spec.annotations
      .map((annotation) => annotation.id)
      .filter((id): id is string => id !== undefined)
  );
  let nextGeneratedId = 1;

  const annotations = spec.annotations.map((annotation): Annotation => {
    if (annotation.id !== undefined) {
      return annotation as Annotation;
    }

    let id: string;
    do {
      id = `a${nextGeneratedId}`;
      nextGeneratedId += 1;
    } while (reservedIds.has(id));
    reservedIds.add(id);

    return { ...annotation, id };
  });

  return {
    version: spec.version,
    coordinateSpace: spec.coordinateSpace,
    annotations
  };
});

export type AnnotationSpecInput = z.input<typeof annotationSpecSchema>;

export interface ResolvedAnnotationStyle {
  strokeColor: string;
  fillColor: string;
  textColor: string;
  backgroundColor: string;
  strokeWidth: number;
  fontSize: number;
  opacity: number;
  padding: number;
  cornerRadius: number;
  lineHeight: number;
  arrowHeadSize: number;
}

interface ResolvedAnnotationBase {
  id: string;
  coordinateSpace: "pixel";
  style: ResolvedAnnotationStyle;
}

export interface ResolvedRectangleAnnotation extends ResolvedAnnotationBase {
  type: "rectangle";
  rect: Rect;
}

export interface ResolvedEllipseAnnotation extends ResolvedAnnotationBase {
  type: "ellipse";
  rect: Rect;
}

export interface ResolvedArrowAnnotation extends ResolvedAnnotationBase {
  type: "arrow";
  start: Point;
  target: AnnotationTarget;
}

export interface ResolvedTextAnnotation extends ResolvedAnnotationBase {
  type: "text";
  position: Point;
  text: string;
}

export interface ResolvedCalloutAnnotation extends ResolvedAnnotationBase {
  type: "callout";
  target: AnnotationTarget;
  text: string;
  placement: CalloutPlacementPreference;
}

export interface ResolvedNumberedCalloutAnnotation extends ResolvedAnnotationBase {
  type: "numbered-callout";
  target: AnnotationTarget;
  text: string;
  number: number;
  placement: CalloutPlacementPreference;
}

export interface ResolvedHighlightAnnotation extends ResolvedAnnotationBase {
  type: "highlight";
  rect: Rect;
}

export interface ResolvedSpotlightAnnotation extends ResolvedAnnotationBase {
  type: "spotlight";
  rect: Rect;
}

export interface ResolvedBlurAnnotation extends ResolvedAnnotationBase {
  type: "blur";
  rect: Rect;
  sigma: number;
}

export interface ResolvedRedactAnnotation extends ResolvedAnnotationBase {
  type: "redact";
  rect: Rect;
  color: string;
}

export type ResolvedAnnotation =
  | ResolvedRectangleAnnotation
  | ResolvedEllipseAnnotation
  | ResolvedArrowAnnotation
  | ResolvedTextAnnotation
  | ResolvedCalloutAnnotation
  | ResolvedNumberedCalloutAnnotation
  | ResolvedHighlightAnnotation
  | ResolvedSpotlightAnnotation
  | ResolvedBlurAnnotation
  | ResolvedRedactAnnotation;

export interface ResolvedAnnotationSpec {
  version: typeof ANNOTATION_SPEC_VERSION;
  coordinateSpace: "pixel";
  annotations: ResolvedAnnotation[];
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface ResolveAnnotationSpecResult {
  spec: ResolvedAnnotationSpec;
  warnings: string[];
}

const BASE_STYLE: ResolvedAnnotationStyle = {
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
};

const STYLE_DEFAULTS: Record<AnnotationType, Partial<ResolvedAnnotationStyle>> = {
  rectangle: {},
  ellipse: {},
  arrow: {},
  text: {
    strokeWidth: 0,
    textColor: "#FF3B30",
    backgroundColor: "#00000000"
  },
  callout: {},
  "numbered-callout": {},
  highlight: {
    strokeColor: "#FFD43B00",
    fillColor: "#FFD43B80"
  },
  spotlight: {
    strokeColor: "#FFFFFF",
    fillColor: "#000000A6"
  },
  blur: {
    strokeWidth: 0
  },
  redact: {
    strokeWidth: 0,
    fillColor: "#000000"
  }
};

export function parseAnnotationSpec(value: unknown): AnnotationSpec {
  return annotationSpecSchema.parse(value);
}

/** Resolve every coordinate to finite integer pixels for a concrete image. */
export function resolveAnnotationSpec(
  specValue: unknown,
  canvas: CanvasSize
): ResolveAnnotationSpecResult {
  validateCanvas(canvas);
  const spec = parseAnnotationSpec(specValue);
  const warnings: string[] = [];

  const annotations = spec.annotations.map((annotation): ResolvedAnnotation => {
    const coordinateSpace = annotation.coordinateSpace ?? spec.coordinateSpace;
    const style = resolveStyle(annotation.type, annotation.style);
    const common = {
      id: annotation.id,
      coordinateSpace: "pixel" as const,
      style
    };

    switch (annotation.type) {
      case "rectangle":
      case "ellipse":
      case "highlight":
      case "spotlight":
        return {
          ...common,
          type: annotation.type,
          rect: resolveRect(
            annotation.rect,
            coordinateSpace,
            canvas,
            annotation.id,
            "rect",
            warnings
          )
        };
      case "blur":
        return {
          ...common,
          type: annotation.type,
          rect: resolveRect(
            annotation.rect,
            coordinateSpace,
            canvas,
            annotation.id,
            "rect",
            warnings
          ),
          sigma: annotation.sigma
        };
      case "redact":
        return {
          ...common,
          type: annotation.type,
          style: {
            ...style,
            fillColor: annotation.color,
            opacity: 1
          },
          rect: resolveRect(
            annotation.rect,
            coordinateSpace,
            canvas,
            annotation.id,
            "rect",
            warnings
          ),
          color: annotation.color
        };
      case "arrow":
        return {
          ...common,
          type: annotation.type,
          start: resolvePoint(annotation.start, coordinateSpace, canvas, annotation.id, "start"),
          target: resolveTarget(
            annotation.target,
            coordinateSpace,
            canvas,
            annotation.id,
            "target",
            warnings
          )
        };
      case "text":
        return {
          ...common,
          type: annotation.type,
          position: resolvePoint(
            annotation.position,
            coordinateSpace,
            canvas,
            annotation.id,
            "position"
          ),
          text: annotation.text
        };
      case "callout":
        return {
          ...common,
          type: annotation.type,
          target: resolveTarget(
            annotation.target,
            coordinateSpace,
            canvas,
            annotation.id,
            "target",
            warnings
          ),
          text: annotation.text,
          placement: annotation.placement
        };
      case "numbered-callout":
        return {
          ...common,
          type: annotation.type,
          target: resolveTarget(
            annotation.target,
            coordinateSpace,
            canvas,
            annotation.id,
            "target",
            warnings
          ),
          text: annotation.text,
          number: annotation.number,
          placement: annotation.placement
        };
    }
  });

  return {
    spec: {
      version: ANNOTATION_SPEC_VERSION,
      coordinateSpace: "pixel",
      annotations
    },
    warnings
  };
}

/** Return stable, compact JSON with lexicographically sorted object keys. */
export function canonicalizeSpec(specValue: unknown): string {
  return JSON.stringify(sortJsonValue(parseAnnotationSpec(specValue)));
}

function validateNormalizedGeometry(
  annotation: ParsedAnnotationWithOptionalId,
  annotationIndex: number,
  context: z.RefinementCtx
): void {
  const checkPoint = (point: Point, path: string): void => {
    checkNormalizedValue(point.x, ["annotations", annotationIndex, path, "x"], context);
    checkNormalizedValue(point.y, ["annotations", annotationIndex, path, "y"], context);
  };

  const checkRect = (rect: Rect, path: string): void => {
    checkNormalizedValue(rect.x, ["annotations", annotationIndex, path, "x"], context);
    checkNormalizedValue(rect.y, ["annotations", annotationIndex, path, "y"], context);
    checkNormalizedValue(rect.width, ["annotations", annotationIndex, path, "width"], context);
    checkNormalizedValue(rect.height, ["annotations", annotationIndex, path, "height"], context);
  };

  const checkTarget = (target: AnnotationTarget, path: string): void => {
    if (isRect(target)) {
      checkRect(target, path);
    } else {
      checkPoint(target, path);
    }
  };

  switch (annotation.type) {
    case "rectangle":
    case "ellipse":
    case "highlight":
    case "spotlight":
    case "blur":
    case "redact":
      checkRect(annotation.rect, "rect");
      break;
    case "arrow":
      checkPoint(annotation.start, "start");
      checkTarget(annotation.target, "target");
      break;
    case "text":
      checkPoint(annotation.position, "position");
      break;
    case "callout":
    case "numbered-callout":
      checkTarget(annotation.target, "target");
      break;
  }
}

function checkNormalizedValue(
  value: number,
  path: (string | number)[],
  context: z.RefinementCtx
): void {
  if (value < 0 || value > 1) {
    context.addIssue({
      code: "custom",
      message: "Normalized coordinates must be between 0 and 1",
      path
    });
  }
}

function validateCanvas(canvas: CanvasSize): void {
  if (!Number.isInteger(canvas.width) || canvas.width <= 0) {
    throw new RangeError("Canvas width must be a positive integer");
  }
  if (!Number.isInteger(canvas.height) || canvas.height <= 0) {
    throw new RangeError("Canvas height must be a positive integer");
  }
}

function resolveStyle(type: AnnotationType, style?: AnnotationStyle): ResolvedAnnotationStyle {
  const defaults: ResolvedAnnotationStyle = {
    ...BASE_STYLE,
    ...STYLE_DEFAULTS[type]
  };
  return {
    strokeColor: style?.strokeColor ?? defaults.strokeColor,
    fillColor: style?.fillColor ?? defaults.fillColor,
    textColor: style?.textColor ?? defaults.textColor,
    backgroundColor: style?.backgroundColor ?? defaults.backgroundColor,
    strokeWidth: style?.strokeWidth ?? defaults.strokeWidth,
    fontSize: style?.fontSize ?? defaults.fontSize,
    opacity: style?.opacity ?? defaults.opacity,
    padding: style?.padding ?? defaults.padding,
    cornerRadius: style?.cornerRadius ?? defaults.cornerRadius,
    lineHeight: style?.lineHeight ?? defaults.lineHeight,
    arrowHeadSize: style?.arrowHeadSize ?? defaults.arrowHeadSize
  };
}

function resolvePoint(
  point: Point,
  coordinateSpace: CoordinateSpace,
  canvas: CanvasSize,
  annotationId: string,
  field: string
): Point {
  const rawX = coordinateSpace === "normalized" ? point.x * Math.max(0, canvas.width - 1) : point.x;
  const rawY =
    coordinateSpace === "normalized" ? point.y * Math.max(0, canvas.height - 1) : point.y;

  if (rawX < 0 || rawX >= canvas.width || rawY < 0 || rawY >= canvas.height) {
    throw new RangeError(
      `Annotation ${JSON.stringify(annotationId)} ${field} is outside the ${canvas.width}x${canvas.height} canvas`
    );
  }

  return {
    x: clamp(Math.round(rawX), 0, canvas.width - 1),
    y: clamp(Math.round(rawY), 0, canvas.height - 1)
  };
}

function resolveRect(
  rect: Rect,
  coordinateSpace: CoordinateSpace,
  canvas: CanvasSize,
  annotationId: string,
  field: string,
  warnings: string[]
): Rect {
  const rawX = coordinateSpace === "normalized" ? rect.x * canvas.width : rect.x;
  const rawY = coordinateSpace === "normalized" ? rect.y * canvas.height : rect.y;
  const rawRight =
    rawX + (coordinateSpace === "normalized" ? rect.width * canvas.width : rect.width);
  const rawBottom =
    rawY + (coordinateSpace === "normalized" ? rect.height * canvas.height : rect.height);

  if (rawRight <= 0 || rawBottom <= 0 || rawX >= canvas.width || rawY >= canvas.height) {
    throw new RangeError(
      `Annotation ${JSON.stringify(annotationId)} ${field} is wholly outside the ${canvas.width}x${canvas.height} canvas`
    );
  }

  const boundsEpsilon = 1e-9;
  const wasClamped =
    rawX < -boundsEpsilon ||
    rawY < -boundsEpsilon ||
    rawRight > canvas.width + boundsEpsilon ||
    rawBottom > canvas.height + boundsEpsilon;
  const left = clamp(Math.round(rawX), 0, canvas.width);
  const top = clamp(Math.round(rawY), 0, canvas.height);
  const right = clamp(Math.round(rawRight), 0, canvas.width);
  const bottom = clamp(Math.round(rawBottom), 0, canvas.height);

  if (right <= left || bottom <= top) {
    throw new RangeError(
      `Annotation ${JSON.stringify(annotationId)} ${field} becomes empty after pixel resolution`
    );
  }

  if (wasClamped) {
    warnings.push(
      `Annotation ${JSON.stringify(annotationId)} ${field} was clamped to the ${canvas.width}x${canvas.height} canvas.`
    );
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

function resolveTarget(
  target: AnnotationTarget,
  coordinateSpace: CoordinateSpace,
  canvas: CanvasSize,
  annotationId: string,
  field: string,
  warnings: string[]
): AnnotationTarget {
  return isRect(target)
    ? resolveRect(target, coordinateSpace, canvas, annotationId, field, warnings)
    : resolvePoint(target, coordinateSpace, canvas, annotationId, field);
}

function isRect(value: AnnotationTarget): value is Rect {
  return "width" in value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function sortJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        sorted[key] = sortJsonValue(item);
      }
    }
    return sorted;
  }

  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}
