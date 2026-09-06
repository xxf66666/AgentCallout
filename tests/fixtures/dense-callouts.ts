export const DENSE_CANVAS = Object.freeze({ width: 960, height: 640 });

export const DENSE_COUNTS = [1, 3, 6, 10] as const;

export type DenseCalloutKind = "plain" | "numbered" | "mixed";

export interface FixtureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PlainCalloutFixture {
  id: string;
  type: "callout";
  target: FixtureRect;
  text: string;
  placement: "auto" | "top" | "right" | "bottom" | "left";
  style?: { arrowHeadSize?: number; strokeColor?: string; strokeWidth?: number };
}

interface NumberedCalloutFixture {
  id: string;
  type: "numbered-callout";
  target: FixtureRect;
  text: string;
  number: number;
  placement: "auto" | "top" | "right" | "bottom" | "left";
}

interface ArrowFixture {
  id: string;
  type: "arrow";
  start: { x: number; y: number };
  target: FixtureRect;
  style?: { arrowHeadSize?: number; strokeColor?: string; strokeWidth?: number };
}

interface TextFixture {
  id: string;
  type: "text";
  position: { x: number; y: number };
  text: string;
}

export type DenseCalloutFixture = PlainCalloutFixture | NumberedCalloutFixture;
export type DenseAnnotationFixture = DenseCalloutFixture | ArrowFixture | TextFixture;

export interface DenseSpecFixture {
  version: "1.1";
  coordinateSpace: "pixel";
  preset: "docs-light";
  defaults: {
    fontSize: number;
    maxWidth: number;
    padding: number;
    strokeWidth: number;
  };
  annotations: DenseAnnotationFixture[];
}

export interface DenseScenarioFixture {
  name: string;
  kind: DenseCalloutKind;
  count: (typeof DENSE_COUNTS)[number];
  spec: DenseSpecFixture;
}

const DENSE_TARGETS: readonly FixtureRect[] = [
  { x: 474, y: 314, width: 12, height: 10 },
  { x: 514, y: 314, width: 12, height: 10 },
  { x: 434, y: 314, width: 12, height: 10 },
  { x: 474, y: 354, width: 12, height: 10 },
  { x: 474, y: 274, width: 12, height: 10 },
  { x: 514, y: 354, width: 12, height: 10 },
  { x: 434, y: 274, width: 12, height: 10 },
  { x: 514, y: 274, width: 12, height: 10 },
  { x: 434, y: 354, width: 12, height: 10 },
  { x: 494, y: 334, width: 12, height: 10 }
];

function annotationType(kind: DenseCalloutKind, index: number): "callout" | "numbered-callout" {
  if (kind === "plain") return "callout";
  if (kind === "numbered") return "numbered-callout";
  return index % 2 === 0 ? "callout" : "numbered-callout";
}

function makeDenseAnnotation(
  kind: DenseCalloutKind,
  count: number,
  index: number
): DenseCalloutFixture {
  const type = annotationType(kind, index);
  const id = `dense-${kind}-${count}-${index + 1}`;
  const target = DENSE_TARGETS[index];
  if (target === undefined) throw new Error(`Missing dense target ${index}.`);
  const common = {
    id,
    target: { ...target },
    text: index % 2 === 0 ? `检查项 ${index + 1}` : `Check ${index + 1}`,
    placement: "auto" as const
  };
  return type === "callout" ? { ...common, type } : { ...common, type, number: index + 1 };
}

export function makeDenseSpec(kind: DenseCalloutKind, count: number): DenseSpecFixture {
  return {
    version: "1.1",
    coordinateSpace: "pixel",
    preset: "docs-light",
    defaults: { fontSize: 12, maxWidth: 112, padding: 4, strokeWidth: 2 },
    annotations: Array.from({ length: count }, (_value, index) =>
      makeDenseAnnotation(kind, count, index)
    )
  };
}

export const DENSE_SCENARIOS: readonly DenseScenarioFixture[] = (
  ["plain", "numbered", "mixed"] as const
).flatMap((kind) =>
  DENSE_COUNTS.map((count) => ({
    name: `${kind}-${count}`,
    kind,
    count,
    spec: makeDenseSpec(kind, count)
  }))
);

export const CORNER_SMALL_BUTTON_SPEC: DenseSpecFixture = {
  version: "1.1",
  coordinateSpace: "pixel",
  preset: "docs-light",
  defaults: { fontSize: 11, maxWidth: 104, padding: 4, strokeWidth: 2 },
  annotations: [
    {
      id: "corner-top-left",
      type: "callout",
      target: { x: 4, y: 4, width: 8, height: 8 },
      text: "左上 8px",
      placement: "auto"
    },
    {
      id: "corner-top-right",
      type: "numbered-callout",
      target: { x: 948, y: 4, width: 8, height: 8 },
      text: "Top right",
      number: 2,
      placement: "auto"
    },
    {
      id: "corner-bottom-left",
      type: "numbered-callout",
      target: { x: 4, y: 628, width: 8, height: 8 },
      text: "Bottom left",
      number: 3,
      placement: "auto"
    },
    {
      id: "corner-bottom-right",
      type: "callout",
      target: { x: 948, y: 628, width: 8, height: 8 },
      text: "右下 8px",
      placement: "auto"
    }
  ]
};

/** The first greedy top label lands on the target declared later in the list. */
export const FUTURE_TARGET_SPEC: DenseSpecFixture = {
  version: "1.1",
  coordinateSpace: "pixel",
  preset: "docs-light",
  defaults: { fontSize: 12, maxWidth: 148, padding: 4, strokeWidth: 2 },
  annotations: [
    {
      id: "future-primary",
      type: "callout",
      target: { x: 476, y: 316, width: 8, height: 8 },
      text: "Primary explanation",
      placement: "top"
    },
    {
      id: "future-protected",
      type: "numbered-callout",
      target: { x: 476, y: 276, width: 8, height: 8 },
      text: "Must stay visible",
      number: 2,
      placement: "auto"
    }
  ]
};

/** A wide future target blocks the direct target-facing route of the first annotation. */
export const FORCED_ORTHOGONAL_ROUTE_SPEC: DenseSpecFixture = {
  version: "1.1",
  coordinateSpace: "pixel",
  preset: "docs-light",
  defaults: { fontSize: 12, maxWidth: 132, padding: 4, strokeWidth: 2 },
  annotations: [
    {
      id: "route-primary",
      type: "numbered-callout",
      target: { x: 476, y: 540, width: 8, height: 8 },
      text: "Route around target",
      number: 1,
      placement: "top"
    },
    {
      id: "route-barrier",
      type: "callout",
      target: { x: 300, y: 500, width: 360, height: 4 },
      text: "Protected barrier target",
      placement: "right"
    }
  ]
};

/** The arrow has to route around a future annotation target instead of crossing it. */
export const FORCED_ORTHOGONAL_ARROW_SPEC: DenseSpecFixture = {
  version: "1.1",
  coordinateSpace: "pixel",
  preset: "docs-light",
  defaults: { fontSize: 12, maxWidth: 132, padding: 4, strokeWidth: 2 },
  annotations: [
    {
      id: "arrow-primary",
      type: "arrow",
      start: { x: 480, y: 300 },
      target: { x: 476, y: 500, width: 8, height: 8 }
    },
    {
      id: "arrow-barrier",
      type: "callout",
      target: { x: 300, y: 390, width: 360, height: 16 },
      text: "Protected arrow barrier",
      placement: "right"
    }
  ]
};

export const ARROW_HEAD_PROTECTION_CANVAS = Object.freeze({ width: 360, height: 240 });

/** The unobstructed red arrowhead paints this future target unless its final approach changes. */
export const ARROW_HEAD_PROTECTION_SPEC: DenseSpecFixture = {
  version: "1.1",
  coordinateSpace: "pixel",
  preset: "docs-light",
  defaults: { fontSize: 12, maxWidth: 112, padding: 4, strokeWidth: 2 },
  annotations: [
    {
      id: "head-primary",
      type: "arrow",
      start: { x: 40, y: 150 },
      target: { x: 200, y: 145, width: 20, height: 10 },
      style: { arrowHeadSize: 20, strokeColor: "#ff0000", strokeWidth: 2 }
    },
    {
      id: "head-protected",
      type: "arrow",
      start: { x: 187, y: 220 },
      target: { x: 184, y: 155, width: 6, height: 4 }
    }
  ]
};

export const CALLOUT_HEAD_LABEL_CANVAS = Object.freeze({ width: 400, height: 300 });

/** A large plain-callout arrowhead must not fold back into its own painted label. */
export const CALLOUT_HEAD_LABEL_SPEC: DenseSpecFixture = {
  version: "1.1",
  coordinateSpace: "pixel",
  preset: "docs-light",
  defaults: { fontSize: 12, maxWidth: 112, padding: 4, strokeWidth: 2 },
  annotations: [
    {
      id: "callout-head-label",
      type: "callout",
      target: { x: 190, y: 150, width: 20, height: 20 },
      text: "Callout",
      placement: "top",
      style: { arrowHeadSize: 128, strokeColor: "#ff0000", strokeWidth: 2 }
    }
  ]
};

export const TINY_TEXT_CLIPPING_CANVAS = Object.freeze({ width: 96, height: 64 });

export const TINY_TEXT_CLIPPING_SPEC: DenseSpecFixture = {
  version: "1.1",
  coordinateSpace: "pixel",
  preset: "docs-light",
  defaults: { fontSize: 20, maxWidth: 80, padding: 4, strokeWidth: 2 },
  annotations: [
    {
      id: "tiny-long-a",
      type: "callout",
      target: { x: 42, y: 26, width: 8, height: 8 },
      text: "无法完整容纳的中英文说明 Text must be clipped safely ".repeat(12),
      placement: "auto"
    },
    {
      id: "tiny-long-b",
      type: "numbered-callout",
      target: { x: 54, y: 38, width: 8, height: 8 },
      text: "第二条同样超出可用空间 Second long annotation ".repeat(12),
      number: 2,
      placement: "auto"
    }
  ]
};

export const UNAVOIDABLE_TARGET_CANVAS = Object.freeze({ width: 96, height: 64 });

export const UNAVOIDABLE_TARGET_SPEC: DenseSpecFixture = {
  version: "1.1",
  coordinateSpace: "pixel",
  preset: "docs-light",
  defaults: { fontSize: 8, maxWidth: 48, padding: 2, strokeWidth: 2 },
  annotations: [
    {
      id: "unavoidable-target",
      type: "callout",
      target: { x: 0, y: 0, width: 96, height: 64 },
      text: "No free space",
      placement: "auto"
    }
  ]
};

export const SHORT_LEADER_CANVAS = Object.freeze({ width: 48, height: 48 });

export const SHORT_LEADER_SPEC: DenseSpecFixture = {
  version: "1.1",
  coordinateSpace: "pixel",
  preset: "docs-light",
  defaults: { fontSize: 6, maxWidth: 48, padding: 0, strokeWidth: 2 },
  annotations: [
    {
      id: "short-leader",
      type: "callout",
      target: { x: 20, y: 20, width: 8, height: 8 },
      text: ".",
      placement: "top",
      style: { arrowHeadSize: 1 }
    }
  ]
};

export const BLOCKED_ROUTE_CANVAS = Object.freeze({ width: 128, height: 96 });

/** The future target fills the canvas, so no route for the first callout can avoid it. */
export const BLOCKED_ROUTE_SPEC: DenseSpecFixture = {
  version: "1.1",
  coordinateSpace: "pixel",
  preset: "docs-light",
  defaults: { fontSize: 7, maxWidth: 48, padding: 1, strokeWidth: 2 },
  annotations: [
    {
      id: "blocked-primary",
      type: "callout",
      target: { x: 58, y: 68, width: 8, height: 8 },
      text: "Blocked",
      placement: "top"
    },
    {
      id: "blocked-barrier",
      type: "callout",
      target: { x: 0, y: 0, width: 128, height: 96 },
      text: "Barrier",
      placement: "auto"
    }
  ]
};
