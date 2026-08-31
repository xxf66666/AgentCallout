import { z } from "zod";

/**
 * @deprecated Legacy AnnotationSpec 1.0 replay constant. Existing consumers may
 * keep using it for byte-compatible replay; new authoring should use
 * LATEST_ANNOTATION_SPEC_VERSION.
 */
export const ANNOTATION_SPEC_VERSION = "1.0" as const;
export const LATEST_ANNOTATION_SPEC_VERSION = "1.1" as const;
export const ANNOTATION_SPEC_VERSIONS = [
  ANNOTATION_SPEC_VERSION,
  LATEST_ANNOTATION_SPEC_VERSION
] as const;
export const MAX_ANNOTATIONS = 200;
export const MAX_TOTAL_TEXT_LENGTH = 100_000;

export const ANNOTATION_PRESETS = [
  "docs-light",
  "docs-dark",
  "high-contrast",
  "classic-red"
] as const;
export const ANNOTATION_TONES = ["neutral", "info", "success", "warning", "danger"] as const;

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
export type AnnotationSpecVersion = (typeof ANNOTATION_SPEC_VERSIONS)[number];
export type AnnotationPreset = (typeof ANNOTATION_PRESETS)[number];
export type AnnotationTone = (typeof ANNOTATION_TONES)[number];
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

const legacyStyleSchema = z
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

const styleSchema = legacyStyleSchema.extend({
  markerStrokeColor: hexColorSchema.optional(),
  markerFillColor: hexColorSchema.optional(),
  markerTextColor: hexColorSchema.optional(),
  maxWidth: finiteNumberSchema.min(48).max(4_096).optional()
});

const commonAnnotationShape = {
  id: annotationIdSchema.optional(),
  coordinateSpace: z.enum(["pixel", "normalized"]).optional(),
  style: legacyStyleSchema.optional()
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

const toneSchema = z.enum(ANNOTATION_TONES);

const v11RectangleAnnotationSchema = rectangleAnnotationSchema.extend({
  tone: toneSchema.optional(),
  style: styleSchema.optional()
});
const v11EllipseAnnotationSchema = ellipseAnnotationSchema.extend({
  tone: toneSchema.optional(),
  style: styleSchema.optional()
});
const v11ArrowAnnotationSchema = arrowAnnotationSchema.extend({
  tone: toneSchema.optional(),
  style: styleSchema.optional()
});
const v11TextAnnotationSchema = textAnnotationSchema.extend({
  tone: toneSchema.optional(),
  style: styleSchema.optional()
});
const v11CalloutAnnotationSchema = calloutAnnotationSchema.extend({
  tone: toneSchema.optional(),
  style: styleSchema.optional()
});
const v11NumberedCalloutAnnotationSchema = numberedCalloutAnnotationSchema.extend({
  tone: toneSchema.optional(),
  style: styleSchema.optional()
});
const v11HighlightAnnotationSchema = highlightAnnotationSchema.extend({
  tone: toneSchema.optional(),
  style: styleSchema.optional()
});
const v11SpotlightAnnotationSchema = spotlightAnnotationSchema.extend({
  tone: toneSchema.optional(),
  style: styleSchema.optional()
});
const v11BlurAnnotationSchema = blurAnnotationSchema.extend({
  tone: toneSchema.optional(),
  style: styleSchema.optional()
});
const v11RedactAnnotationSchema = redactAnnotationSchema.extend({
  tone: toneSchema.optional(),
  style: styleSchema.optional()
});

const v11AnnotationUnionSchema = z.discriminatedUnion("type", [
  v11RectangleAnnotationSchema,
  v11EllipseAnnotationSchema,
  v11ArrowAnnotationSchema,
  v11TextAnnotationSchema,
  v11CalloutAnnotationSchema,
  v11NumberedCalloutAnnotationSchema,
  v11HighlightAnnotationSchema,
  v11SpotlightAnnotationSchema,
  v11BlurAnnotationSchema,
  v11RedactAnnotationSchema
]);

type ParsedLegacyAnnotationWithOptionalId = z.output<typeof annotationUnionSchema>;
type ParsedV11AnnotationWithOptionalId = z.output<typeof v11AnnotationUnionSchema>;
type ParsedAnnotationWithOptionalId =
  ParsedLegacyAnnotationWithOptionalId | ParsedV11AnnotationWithOptionalId;
type WithRequiredId<T> = T extends unknown ? Omit<T, "id"> & { id: string } : never;

export type Point = z.output<typeof pointSchema>;
export type Rect = z.output<typeof rectSchema>;
export type AnnotationTarget = z.output<typeof targetSchema>;
export type AnnotationStyle = z.output<typeof styleSchema>;
export type AnnotationInput =
  z.input<typeof annotationUnionSchema> | z.input<typeof v11AnnotationUnionSchema>;
export type LegacyAnnotation = WithRequiredId<ParsedLegacyAnnotationWithOptionalId>;
export type AnnotationV11 = WithRequiredId<ParsedV11AnnotationWithOptionalId>;
export type Annotation = LegacyAnnotation | AnnotationV11;
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

export interface AnnotationSpecV1 {
  version: typeof ANNOTATION_SPEC_VERSION;
  coordinateSpace: CoordinateSpace;
  annotations: LegacyAnnotation[];
}

export interface AnnotationSpecV11 {
  version: typeof LATEST_ANNOTATION_SPEC_VERSION;
  coordinateSpace: CoordinateSpace;
  preset: AnnotationPreset;
  defaults?: AnnotationStyle;
  annotations: AnnotationV11[];
}

export type AnnotationSpec = AnnotationSpecV1 | AnnotationSpecV11;

const rawV1AnnotationSpecSchema = z
  .object({
    version: z.literal(ANNOTATION_SPEC_VERSION),
    coordinateSpace: z.enum(["pixel", "normalized"]).default("pixel"),
    annotations: z.array(annotationUnionSchema).max(MAX_ANNOTATIONS)
  })
  .strict();

const rawV11AnnotationSpecSchema = z
  .object({
    version: z.literal(LATEST_ANNOTATION_SPEC_VERSION),
    coordinateSpace: z.enum(["pixel", "normalized"]).default("pixel"),
    preset: z.enum(ANNOTATION_PRESETS).default("docs-light"),
    defaults: styleSchema.optional(),
    annotations: z.array(v11AnnotationUnionSchema).max(MAX_ANNOTATIONS)
  })
  .strict();

const rawAnnotationSpecSchema = z
  .discriminatedUnion("version", [rawV1AnnotationSpecSchema, rawV11AnnotationSpecSchema])
  .superRefine((spec, context) => {
    const seenIds = new Map<string, number>();
    let totalTextLength = 0;

    for (const [index, annotation] of spec.annotations.entries()) {
      if (
        annotation.type === "text" ||
        annotation.type === "callout" ||
        annotation.type === "numbered-callout"
      ) {
        totalTextLength += annotation.text.length;
      }
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

    if (totalTextLength > MAX_TOTAL_TEXT_LENGTH) {
      context.addIssue({
        code: "custom",
        message: `Total annotation text must not exceed ${MAX_TOTAL_TEXT_LENGTH} characters`,
        path: ["annotations"]
      });
    }
  });

/**
 * Strict AnnotationSpec 1.0/1.1 schema. Parsing also supplies root defaults and
 * deterministic IDs for annotations that omitted one.
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

  if (spec.version === LATEST_ANNOTATION_SPEC_VERSION) {
    return {
      version: spec.version,
      coordinateSpace: spec.coordinateSpace,
      preset: spec.preset,
      ...(spec.defaults === undefined ? {} : { defaults: spec.defaults }),
      annotations
    };
  }

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
  markerStrokeColor?: string;
  markerFillColor?: string;
  markerTextColor?: string;
  strokeWidth: number;
  fontSize: number;
  opacity: number;
  padding: number;
  maxWidth?: number;
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
  version: AnnotationSpecVersion;
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

type ResolvedAnnotationStyleV11 = ResolvedAnnotationStyle & {
  markerStrokeColor: string;
  markerFillColor: string;
  markerTextColor: string;
  maxWidth: number;
};

type ResolvedAnnotationStyleLayer = {
  [Field in keyof ResolvedAnnotationStyleV11]?: ResolvedAnnotationStyleV11[Field] | undefined;
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

const V11_PRESET_STYLES: Record<AnnotationPreset, ResolvedAnnotationStyleV11> = {
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
    ...BASE_STYLE,
    markerStrokeColor: "#FF3B30",
    markerFillColor: "#D92D20",
    markerTextColor: "#FFFFFF",
    maxWidth: 360
  }
};

const V11_TYPE_DEFAULTS: Record<AnnotationType, ResolvedAnnotationStyleLayer> = {
  rectangle: {},
  ellipse: {},
  arrow: {},
  text: {
    strokeWidth: 0,
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

const V11_TONE_STYLES: Record<AnnotationTone, ResolvedAnnotationStyleLayer> = {
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
    const tone = "tone" in annotation ? annotation.tone : undefined;
    const style =
      spec.version === ANNOTATION_SPEC_VERSION
        ? resolveLegacyStyle(annotation.type, annotation.style)
        : resolveV11Style(annotation.type, spec.preset, spec.defaults, tone, annotation.style);
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
      version: spec.version,
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

function resolveLegacyStyle(
  type: AnnotationType,
  style?: AnnotationStyle
): ResolvedAnnotationStyle {
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

function resolveV11Style(
  type: AnnotationType,
  preset: AnnotationPreset,
  rootDefaults?: AnnotationStyle,
  tone?: AnnotationTone,
  annotationStyle?: AnnotationStyle
): ResolvedAnnotationStyleV11 {
  const presetStyle = V11_PRESET_STYLES[preset];
  const typeStyle: ResolvedAnnotationStyleLayer = {
    ...V11_TYPE_DEFAULTS[type],
    ...(type === "text" && preset === "classic-red" ? { textColor: "#FF3B30" } : {})
  };
  const toneStyle = tone === undefined ? undefined : V11_TONE_STYLES[tone];
  const layers = [typeStyle, rootDefaults, toneStyle, annotationStyle];
  const resolved: ResolvedAnnotationStyleV11 = { ...presetStyle };

  for (const layer of layers) {
    applyDefinedStyle(resolved, layer);
  }
  return resolved;
}

function applyDefinedStyle(
  target: ResolvedAnnotationStyleV11,
  layer: ResolvedAnnotationStyleLayer | undefined
): void {
  if (layer === undefined) return;
  if (layer.strokeColor !== undefined) target.strokeColor = layer.strokeColor;
  if (layer.fillColor !== undefined) target.fillColor = layer.fillColor;
  if (layer.textColor !== undefined) target.textColor = layer.textColor;
  if (layer.backgroundColor !== undefined) target.backgroundColor = layer.backgroundColor;
  if (layer.markerStrokeColor !== undefined) {
    target.markerStrokeColor = layer.markerStrokeColor;
  }
  if (layer.markerFillColor !== undefined) target.markerFillColor = layer.markerFillColor;
  if (layer.markerTextColor !== undefined) target.markerTextColor = layer.markerTextColor;
  if (layer.strokeWidth !== undefined) target.strokeWidth = layer.strokeWidth;
  if (layer.fontSize !== undefined) target.fontSize = layer.fontSize;
  if (layer.opacity !== undefined) target.opacity = layer.opacity;
  if (layer.padding !== undefined) target.padding = layer.padding;
  if (layer.maxWidth !== undefined) target.maxWidth = layer.maxWidth;
  if (layer.cornerRadius !== undefined) target.cornerRadius = layer.cornerRadius;
  if (layer.lineHeight !== undefined) target.lineHeight = layer.lineHeight;
  if (layer.arrowHeadSize !== undefined) target.arrowHeadSize = layer.arrowHeadSize;
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
