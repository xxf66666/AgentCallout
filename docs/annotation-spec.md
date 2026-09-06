# AnnotationSpec 1.0 and 1.1

AnnotationSpec is AgentCallout's strict, replayable description of annotations over an existing image. It contains no input/output paths, timestamps, hashes, random values, or renderer state. The source image and concrete canvas size are supplied separately.

Use version `"1.1"` for new specs. It provides readable document-oriented defaults, reusable presets, semantic tones, root style defaults, independent numbered-marker colors, and explicit text width. Version `"1.0"` remains supported exactly for replay: its parsing, canonical JSON, resolved style/geometry, and renderer defaults are unchanged.

The dense layout and preview metrics below describe the **unreleased v0.2.1 implementation**. They do not change `AnnotationSpec.version`: the new layout applies only to 1.1. Release and real-client verification status is tracked in [compatibility](compatibility.md) and [PROGRESS](../PROGRESS.md).

## Root object

```json
{
  "version": "1.1",
  "coordinateSpace": "pixel",
  "preset": "docs-light",
  "defaults": { "maxWidth": 360 },
  "annotations": []
}
```

| Field             | Required | Value                                                                                                |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `version`         | yes      | Exactly `"1.0"` or `"1.1"`. Other versions are rejected.                                             |
| `coordinateSpace` | no       | `"pixel"` or `"normalized"`; defaults to `"pixel"`.                                                  |
| `preset`          | 1.1 only | One of the four [1.1 presets](#11-presets); defaults to `"docs-light"`.                              |
| `defaults`        | 1.1 only | A strict shared style patch below annotation tone/style and above the selected preset/type defaults. |
| `annotations`     | yes      | Up to 200 annotation objects in paint order. The array may be empty.                                 |

Root, annotation, geometry, and style objects are strict in both versions: unknown fields are rejected. A 1.0 spec also rejects every 1.1-only field. Annotation order is significant and is retained during parsing, resolution, and canonicalization.

The combined `text` length across `text`, `callout`, and `numbered-callout` annotations must not exceed 100,000 UTF-16 code units. This bounds validation and renderer work before image allocation.

Every annotation accepts these common fields:

| Field             | Required | Value                                                                                |
| ----------------- | -------- | ------------------------------------------------------------------------------------ |
| `type`            | yes      | One of the ten annotation types below.                                               |
| `id`              | no       | Stable identifier matching `^[A-Za-z0-9][A-Za-z0-9_-]*$`, at most 64 characters.     |
| `coordinateSpace` | no       | Overrides the root coordinate space for this annotation.                             |
| `style`           | no       | Strict, version-specific style object described under [Styles](#styles).             |
| `tone`            | 1.1 only | Optional semantic color patch: `neutral`, `info`, `success`, `warning`, or `danger`. |

## Coordinates and geometry

The origin is the top-left corner. Positive `x` goes right and positive `y` goes down.

A point is `{ "x": number, "y": number }`. A rectangle is `{ "x": number, "y": number, "width": positive-number, "height": positive-number }`. A target is either a point or a rectangle. All numbers must be finite; `NaN` and infinities are invalid.

### Pixel coordinates

Pixel `x` and `y` values may be fractional. Points must lie inside the image before rounding: `0 <= x < imageWidth` and `0 <= y < imageHeight`. They resolve by rounding to the nearest integer pixel and constraining that integer to the final pixel index.

Rectangle edges resolve as `round(x)`, `round(y)`, `round(x + width)`, and `round(y + height)`. A rectangle may begin outside the image if it still intersects the canvas.

### Normalized coordinates

Normalized point components must be in `[0, 1]`. Normalized rectangle `x` and `y` must be in `[0, 1]`, while `width` and `height` must be in `(0, 1]`. A rectangle whose origin and size are each valid may extend past the right or bottom edge; resolution will clamp the intersecting portion.

Normalized points resolve against the last addressable pixel:

- `pixelX = round(x * (imageWidth - 1))`
- `pixelY = round(y * (imageHeight - 1))`

Normalized rectangle edges resolve against the canvas extent:

- horizontal edges: `round(x * imageWidth)` and `round((x + width) * imageWidth)`
- vertical edges: `round(y * imageHeight)` and `round((y + height) * imageHeight)`

This distinction makes normalized point `(1, 1)` select the bottom-right pixel while a normalized rectangle `{ "x": 0, "y": 0, "width": 1, "height": 1 }` covers the complete canvas.

### Bounds behavior

`resolveAnnotationSpec(spec, { width, height })` requires positive integer canvas dimensions and returns `{ spec, warnings }`. The returned spec always uses `"pixel"`, and all returned coordinates and rectangle dimensions are finite integers.

- An intersecting rectangle that crosses a canvas edge is clamped and emits a deterministic warning naming the annotation and field.
- A rectangle wholly outside the canvas is an error.
- A rectangle that becomes empty after integer resolution is an error.
- An out-of-canvas point is an error; a point has no partially visible area to clamp.
- `width` and `height` must be positive at schema-validation time.

Warnings are part of validation/render results, not part of AnnotationSpec itself. Do not silently discard them.

## Annotation shapes

The snippets below show the fields in addition to the common `type`, optional `id`, optional `coordinateSpace`, and optional `style`.

### `rectangle`

```json
{ "type": "rectangle", "rect": { "x": 20, "y": 30, "width": 160, "height": 60 } }
```

Draws a rectangular outline around `rect`.

### `ellipse`

```json
{ "type": "ellipse", "rect": { "x": 20, "y": 30, "width": 160, "height": 60 } }
```

Draws an ellipse fitted inside `rect`.

### `arrow`

```json
{ "type": "arrow", "start": { "x": 40, "y": 40 }, "target": { "x": 180, "y": 90 } }
```

`start` is a point. `target` may be a point or a rectangle. A rectangular target lets the renderer connect the leader to the target boundary instead of requiring a guessed endpoint.

### `text`

```json
{ "type": "text", "position": { "x": 20, "y": 30 }, "text": "保存失败" }
```

`text` must contain 1 to 10,000 UTF-16 code units. `position` is the text anchor. Chinese and English use identical coordinate semantics; text measurement and wrapping occur later in the renderer.

### `callout`

```json
{
  "type": "callout",
  "target": { "x": 100, "y": 80, "width": 120, "height": 40 },
  "text": "Clicking Save does nothing",
  "placement": "auto"
}
```

`target` is a point or rectangle, `text` is required, and `placement` is `"auto"`, `"top"`, `"right"`, `"bottom"`, or `"left"`. Placement defaults to `"auto"`. Explicit placement is a request for that side; the box may still be shifted within the canvas and a warning is returned when clamping or overlap cannot be avoided.

### `numbered-callout`

```json
{
  "type": "numbered-callout",
  "target": { "x": 100, "y": 80 },
  "text": "First review finding",
  "number": 1,
  "placement": "right"
}
```

This has the same target, text, and placement behavior as `callout`, plus an integer `number` from 1 through 9,999.

Numbered geometry is versioned without adding public input fields:

- Version 1.0 preserves the legacy replay path byte-for-byte: the marker remains centered on the target and the existing fixed-gap label/leader composition is unchanged.
- Version 1.1 treats `target`, `marker`, `label`, and `leader` as separate resolved geometry. The marker prefers the outside label edge facing the target; another label edge can be selected when needed for clearance. The leader runs from the painted outer marker boundary to the exact point target or the boundary of a rectangular target. The marker and its number participate in target and label avoidance.
- On a feasible canvas, the exposed 1.1 leader is at least 24 pixels. Placement scoring reserves the painted label/marker bounds and leader corridor. Edge clamping, very small canvases, dense occupied layouts, invisible leader styles, and strokes too wide for the canvas remain deterministic; when visibility or separation cannot be met, the renderer keeps the output decodable and emits a warning containing the annotation ID.

The 1.1 sidecar records `target`, `marker` (including painted bounds), `label`, and `leader`. Renderer 0.2.1 adds the complete routed leader geometry described below. These are resolved output fields, not AnnotationSpec input fields; supplying `marker`, `label`, or `leader` in an input annotation is still rejected as an unknown field.

Marker-aware 1.1 numbered geometry first shipped with renderer 0.1.3; dense planning and routed geometry use renderer 0.2.1. A 1.1 sidecar is not a promise of pixel-equivalent replay under a different renderer build: retain and check its renderer/font metadata, then regenerate and visually review it. Version 1.0 keeps its legacy rendering branch and fixed PNG regression baseline on the recorded platform/font/Sharp environment; this does not promise cross-platform byte equality.

### `highlight`

```json
{ "type": "highlight", "rect": { "x": 20, "y": 30, "width": 160, "height": 60 } }
```

Applies a translucent emphasis tint to `rect`.

### `spotlight`

```json
{ "type": "spotlight", "rect": { "x": 20, "y": 30, "width": 160, "height": 60 } }
```

Uses `rect` as the focus region while dimming the surrounding image.

### `blur`

```json
{
  "type": "blur",
  "rect": { "x": 20, "y": 30, "width": 160, "height": 60 },
  "sigma": 18
}
```

`sigma` is finite and ranges from `0.3` through `1000`; it defaults to `10`.

### `redact`

```json
{
  "type": "redact",
  "rect": { "x": 20, "y": 30, "width": 160, "height": 60 },
  "color": "#000000"
}
```

`color` must be opaque `#RRGGBB` and defaults to black. A redact annotation rejects any style opacity other than `1`. During resolution its fill color is forced to `color` and its opacity is forced to `1`.

## Dense layout and resolved geometry (v0.2.1)

Version 1.1 measures all `text`, `callout`, and `numbered-callout` labels before painting. A deterministic bounded beam search places the callout labels together, considering their painted borders and numbered-marker footprint. All callout and standalone-arrow targets are known at planning time, including targets that occur later in paint order. Explicit `text` boxes remain fixed obstacles. Point targets reserve a small local region for avoidance; rectangle targets retain their actual bounds.

After label and marker placement, leaders and standalone arrows use straight or orthogonal paths around labels, markers, fixed text, and other targets. The renderer checks painted shaft width and arrowhead geometry, and may choose another boundary point on a rectangle target. A connection can touch its own target; annotations sharing identical target bounds can connect to that shared target. The original annotation array still determines paint order.

`placement` remains a side preference. Avoiding covered targets, overlapping labels, and canvas overflow can require another side. Space can be insufficient even for a valid spec. In that case the renderer preserves a deterministic result with explicit diagnostics rather than promising a globally optimal or collision-free layout. Intentional effects such as `redact`, `blur`, and `highlight` keep their specified regions; the planner does not discover screenshot content or move these effects.

The search is bounded independently of image size: at most 200 callouts, at most 128 label candidates per item, and a beam width capped at 128 (default 96). Candidate/beam budgets decrease above 10, 32, and 96 items. Routing also caps its candidate channels. These are library implementation limits, not additional AnnotationSpec fields; the low-level layout API rejects non-finite or excessive geometry options and an out-of-range `beamWidth`.

### Routed output contract

In `resolvedAnnotations`, both callout types expose `label.box`, `label.paintedBounds`, and `leader`; numbered callouts additionally expose `marker`. Standalone `arrow` uses `path`. `leader` and `path` share this shape:

| Field          | Meaning                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| `kind`         | `straight` for zero bends; otherwise `orthogonal`.                                |
| `start`, `end` | Resolved connection endpoints in full-image pixel coordinates.                    |
| `length`       | Compatibility field: direct endpoint distance, **not** the length of a bent path. |
| `pathLength`   | Sum of the rendered route segment lengths.                                        |
| `points`       | Ordered endpoints and bends.                                                      |
| `segments`     | Ordered `{ start, end }` pairs between distinct route points.                     |
| `bendCount`    | Number of route bends.                                                            |
| `bounds`       | Bounds of the shaft including stroke width; omitted when there are no segments.   |
| `strokeWidth`  | Effective rendered shaft width.                                                   |
| `collisionIds` | Present only when the selected route still intersects obstacles.                  |

Plain callouts with an arrowhead and standalone arrows also expose `arrowHead: { tip, wings, bounds }`; `wings` contains the two triangle corners. Shaft `bounds` does not include the arrowhead. Consumers computing a review crop must include both, plus label and marker painted bounds. A zero-segment route is not proof of a visible leader: check `layout` and its warnings.

Resolved `layout` is `{ "status": "ok" | "degraded", "issues": [...] }`. Each issue contains `code`, `annotationId`, `relatedIds`, `message`, and optional numeric `metrics`. Empty issues mean `ok`; any issue means `degraded`. IDs in relationships can identify an obstacle role such as `label:save-note` or `target:save-note`. These output records support inspection and review; they are not editable spec fields.

### Layout warnings and text fitting

Version 1.1 layout warnings use the string prefix `[CODE]` and are also stored as structured issues on the affected resolved annotation. Match the code, not the human message wording. Existing schema/coordinate warnings and 1.0 legacy warnings keep their existing forms.

| Code                   | Meaning                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `LEADER_TOO_SHORT`     | The exposed leader misses the 24px target, including a style that makes it invisible.     |
| `TEXT_CLIPPED`         | Callout text still exceeded its available sprite area at the 6px minimum and was cropped. |
| `TARGET_COVERED`       | A label, marker, or arrowhead still overlaps a protected target.                          |
| `CALLOUT_OVERLAP`      | Protected label/marker geometry or fixed text still overlaps.                             |
| `INSUFFICIENT_SPACE`   | The available canvas/candidate space cannot satisfy required separation or text fit.      |
| `LEADER_ROUTE_BLOCKED` | The chosen route still intersects an obstacle; inspect the related IDs.                   |
| `TEXT_SIZE_REDUCED`    | Text was reduced from the requested font size to fit without clipping.                    |
| `GEOMETRY_CLIPPED`     | Geometry was reduced or clipped to fit the canvas.                                        |

Only 1.1 `callout` and `numbered-callout` may fall back to bounded text cropping. Their `TEXT_CLIPPED` issue includes requested/resolved font sizes, unclipped/clipped width and height, and `clippedAlphaPixelCount`, the count of nontransparent text pixels omitted. It is accompanied by `INSUFFICIENT_SPACE`; the sidecar retains the full text. Standalone `text` and the 1.0 renderer keep their fail-rather-than-clip behavior. Reduce text, split notes, change width, or use a larger source canvas before treating a degraded result as reviewed.

## Styles

Colors accept only `#RRGGBB` or `#RRGGBBAA`, with alpha last. Three-digit colors, named CSS colors, functions, and other CSS strings are rejected. Parsing normalizes letters to uppercase. The `redact.color` field is stricter and accepts no alpha channel.

The shared fields and validation ranges are:

| Field               | Versions | Range            |
| ------------------- | -------- | ---------------- |
| `strokeColor`       | both     | strict hex color |
| `fillColor`         | both     | strict hex color |
| `textColor`         | both     | strict hex color |
| `backgroundColor`   | both     | strict hex color |
| `strokeWidth`       | both     | `0` to `64`      |
| `fontSize`          | both     | `6` to `256`     |
| `opacity`           | both     | `0` to `1`       |
| `padding`           | both     | `0` to `128`     |
| `cornerRadius`      | both     | `0` to `256`     |
| `lineHeight`        | both     | `1` to `3`       |
| `arrowHeadSize`     | both     | `1` to `128`     |
| `maxWidth`          | 1.1 only | `48` to `4096`   |
| `markerStrokeColor` | 1.1 only | strict hex color |
| `markerFillColor`   | 1.1 only | strict hex color |
| `markerTextColor`   | 1.1 only | strict hex color |

`maxWidth` bounds text measurement for `text`, `callout`, and `numbered-callout`; the renderer wraps Chinese and English with the same width rule. Other annotation types accept the resolved field but do not use it. The three `marker*` fields affect only a `numbered-callout` marker, so its outline, fill, and number no longer need to inherit the label colors.

### 1.1 resolution priority

Version 1.1 resolves every style field independently in this exact order, from highest priority to lowest:

1. the annotation's `style` field;
2. the annotation's semantic `tone` color patch;
3. root `defaults`;
4. the selected preset and type-specific defaults.

Omitting `tone` means no tone patch; it does not silently mean `neutral`. This lets root color defaults remain effective. Tone changes colors only, so dimensions such as `fontSize`, `padding`, and `maxWidth` continue to come from `style`, root defaults, or the preset.

For `redact`, the security rule runs after all style resolution: resolved `fillColor` is always the annotation's opaque `color`, and resolved `opacity` is always `1`. A local redact style with any other opacity is rejected. Root defaults and tones cannot weaken this rule.

### 1.1 presets

| Preset          | Label text / background | Border    | Marker fill / text    | Purpose                                   |
| --------------- | ----------------------- | --------- | --------------------- | ----------------------------------------- |
| `docs-light`    | `#0F172A` / `#EFF6FF`   | `#2563EB` | `#2563EB` / `#FFFFFF` | Default light documentation style         |
| `docs-dark`     | `#F8FAFC` / `#1E293B`   | `#60A5FA` | `#2563EB` / `#FFFFFF` | Labels over dark screenshots              |
| `high-contrast` | `#FFFFFF` / `#000000`   | `#FACC15` | `#FACC15` / `#000000` | Maximum built-in text and marker contrast |
| `classic-red`   | `#FFFFFF` / `#D92D20`   | `#FF3B30` | `#D92D20` / `#FFFFFF` | Explicit legacy-red visual style          |

The first three presets use `fontSize: 22`, `padding: 12`, `maxWidth: 360`, `cornerRadius: 8`, `lineHeight: 1.35`, and `arrowHeadSize: 12`. Their default stroke width is `2`, except `high-contrast` uses `3`. `classic-red` uses the 1.0 geometry defaults and adds resolved marker colors plus `maxWidth: 360`.

### 1.1 semantic tones

| Tone      | Label text / background | Border    | Marker fill / text    |
| --------- | ----------------------- | --------- | --------------------- |
| `neutral` | `#0F172A` / `#F1F5F9`   | `#64748B` | `#475569` / `#FFFFFF` |
| `info`    | `#0F172A` / `#EFF6FF`   | `#2563EB` | `#2563EB` / `#FFFFFF` |
| `success` | `#14532D` / `#F0FDF4`   | `#15803D` | `#15803D` / `#FFFFFF` |
| `warning` | `#78350F` / `#FFFBEB`   | `#B45309` | `#B45309` / `#FFFFFF` |
| `danger`  | `#7F1D1D` / `#FEF2F2`   | `#DC2626` | `#DC2626` / `#FFFFFF` |

All built-in label and marker text pairs have a contrast ratio of at least 4.5:1. The built-in palette emits red only through `danger` and `classic-red`; ordinary explanatory notes should omit `tone` or use `neutral`/`info`. This reservation does not prohibit or rewrite an explicit valid hex color. An explicit color is authoritative whenever it wins the documented per-field priority (for example, annotation `style` remains above `tone`, while root `defaults` remains below it), and the author is responsible for its contrast and semantic meaning.

### 1.0 legacy defaults

Version 1.0 retains its original resolved base defaults and does not accept `preset`, `defaults`, `tone`, `maxWidth`, or marker color fields:

| Field             | 1.0 resolved base default |
| ----------------- | ------------------------- |
| `strokeColor`     | `#FF3B30`                 |
| `fillColor`       | `#00000000`               |
| `textColor`       | `#FFFFFF`                 |
| `backgroundColor` | `#D92D20`                 |
| `strokeWidth`     | `3`                       |
| `fontSize`        | `24`                      |
| `opacity`         | `1`                       |
| `padding`         | `10`                      |
| `cornerRadius`    | `6`                       |
| `lineHeight`      | `1.25`                    |
| `arrowHeadSize`   | `12`                      |

Type-specific 1.0 defaults remain unchanged: `text` uses no stroke, red text, and a transparent background; `highlight` uses `#FFD43B00`/`#FFD43B80`; `spotlight` uses `#FFFFFF`/`#000000A6`; `blur` has no stroke; and `redact` is forced to its opaque replacement color.

## Stable IDs

Explicit IDs are preserved and duplicate explicit IDs are rejected. Missing IDs are generated deterministically in annotation order as `a1`, `a2`, and so on. Generation skips every explicit ID already present anywhere in the input. For example, if a later annotation explicitly uses `a1`, the first missing ID becomes `a2`.

Use meaningful explicit IDs when another report or workflow needs to refer to an annotation. Otherwise, generated IDs are stable for the same ordered input.

## Blur and redact are not interchangeable

`blur` is reversible visual weakening: structure and sometimes text may remain inferable, and the output region is not guaranteed to be safe against recovery techniques. Use it only for de-emphasis or low-risk privacy treatment.

`redact` is the security control. The renderer replaces the selected output pixels with a fully opaque solid color. Use it for passwords, tokens, credentials, personal identifiers, or any content that must not remain in the output image. Never describe a blurred value as removed.

## Canonicalization and replay

`canonicalizeSpec(value)` first performs the same strict parse as `parseAnnotationSpec`. It therefore inserts the root coordinate-space default, generated IDs, default placement, default blur sigma, default redact color, and uppercase color spelling. Version 1.1 additionally inserts `preset: "docs-light"` when it was omitted. Version 1.0 does not gain that field or any other 1.1 default. Canonicalization then recursively sorts object keys and emits compact JSON. Annotation array order is retained.

The canonical string is stable for semantically identical valid input regardless of object key order. Canonicalization never invents timestamps or random IDs: explicit IDs are preserved and missing IDs use the deterministic sequence described above. Runtime timestamp fields, random-seed fields, source paths, hashes, and warnings are not accepted AnnotationSpec fields. Replaying the same canonical spec against the same canvas dimensions produces the same resolved pixel spec. Pixel-identical rendered output additionally requires the same source image, renderer version, fonts, and rendering environment.

## Complete compact examples

### UI bug

```json
{
  "version": "1.1",
  "coordinateSpace": "normalized",
  "preset": "docs-light",
  "annotations": [
    {
      "id": "invalid-field",
      "type": "rectangle",
      "rect": { "x": 0.61, "y": 0.28, "width": 0.3, "height": 0.13 },
      "tone": "danger",
      "style": { "strokeWidth": 4 }
    },
    {
      "id": "save-arrow",
      "type": "arrow",
      "start": { "x": 0.48, "y": 0.83 },
      "target": { "x": 0.82, "y": 0.78 },
      "tone": "danger"
    },
    {
      "id": "save-note",
      "type": "callout",
      "target": { "x": 0.72, "y": 0.72, "width": 0.2, "height": 0.12 },
      "text": "点击保存后没有响应",
      "placement": "top",
      "tone": "danger"
    }
  ]
}
```

### Numbered review

```json
{
  "version": "1.1",
  "coordinateSpace": "normalized",
  "defaults": { "fontSize": 22, "maxWidth": 280 },
  "annotations": [
    {
      "id": "review-1",
      "type": "numbered-callout",
      "target": { "x": 0.08, "y": 0.14, "width": 0.22, "height": 0.12 },
      "text": "标题层级不清晰",
      "number": 1,
      "placement": "right",
      "tone": "neutral"
    },
    {
      "id": "review-2",
      "type": "numbered-callout",
      "target": { "x": 0.43, "y": 0.38, "width": 0.28, "height": 0.16 },
      "text": "状态信息缺少上下文",
      "number": 2,
      "placement": "left",
      "tone": "warning"
    },
    {
      "id": "review-3",
      "type": "numbered-callout",
      "target": { "x": 0.68, "y": 0.76, "width": 0.2, "height": 0.1 },
      "text": "主要操作不够醒目",
      "number": 3,
      "placement": "top",
      "tone": "info"
    }
  ]
}
```

### Privacy

```json
{
  "version": "1.1",
  "coordinateSpace": "pixel",
  "annotations": [
    {
      "id": "email-blur",
      "type": "blur",
      "rect": { "x": 168, "y": 92, "width": 286, "height": 34 },
      "sigma": 18
    },
    {
      "id": "token-redact",
      "type": "redact",
      "rect": { "x": 168, "y": 146, "width": 412, "height": 34 },
      "color": "#111827"
    },
    {
      "id": "privacy-note",
      "type": "text",
      "position": { "x": 168, "y": 206 },
      "text": "Token 已永久遮挡",
      "tone": "danger",
      "style": { "fontSize": 22 }
    }
  ]
}
```

## Migrating from 1.0

Do not rewrite a stored 1.0 sidecar merely to adopt new colors; replay it as 1.0 when the old canonical and pixels matter. For a newly authored standalone 1.1 spec, change `version` to `"1.1"`, choose a preset only when the `docs-light` default is unsuitable, move shared dimensions into root `defaults`, and use `tone` for semantic color. Keep ordinary explanations non-red; use `danger` only for an actual error or risk. Use `classic-red` only when the legacy red visual is explicitly desired. The revision API below deliberately preserves the parent root version and cannot perform this migration.

Version 1.0 has no `marker*` fields: a `numbered-callout` marker takes its outline from the resolved `strokeColor`, its fill from the resolved `backgroundColor`, and its number from the resolved `textColor`. Version 1.1 resolves those marker colors independently. When converting a custom 1.0 numbered callout and preserving its marker appearance matters, copy those former resolved values explicitly to `markerStrokeColor`, `markerFillColor`, and `markerTextColor`, respectively, in the standalone migrated 1.1 spec. Omit them when intentionally adopting the selected 1.1 preset/tone marker palette, and never add them to a 1.0 spec because 1.0 rejects those fields.

Version 1.0 retains the existing one-at-a-time candidate order, fixed gaps, and legacy paint composition. Renderer 0.2.1 uses the dense preplanning pass above for both 1.1 callout types and routes their leaders together with standalone arrows. `maxWidth` can change wrapping and therefore other labels' selected positions. A migration to 1.1 can change pixels even with `classic-red`; that preset selects style defaults, not the 1.0 renderer.

Validate a spec before rendering, resolve it against the inspected image dimensions, retain its warnings, and save the canonical or sidecar representation needed for replay.

## Revising a committed annotation

`revise_annotation` changes only the `annotations` array of a trusted annotate sidecar. It accepts an ordered array of strict edits:

- `{ "op": "add", "annotation": { ... } }` appends a complete annotation with a new explicit ID; optional `afterId` inserts it immediately after a current ID.
- `{ "op": "set", "id": "...", "annotation": { ... } }` replaces the complete annotation at that position. The annotation must carry the same ID.
- `{ "op": "remove", "id": "..." }` removes one current annotation.

Unknown IDs, duplicate IDs, a second edit touching the same ID, no-op sets, unknown fields, and invalid final specs fail the whole transaction. The API deliberately has no root-spec patch, merge/JSON Patch, output path, overwrite switch, or caller-selected revision number.

Every revision is rendered from the original image and written as the next `.revN.png/.json` pair. If a relative original moved, explicitly supply its new path; a basename-only record always requires the explicit path. SHA-256 must match the validated parent record. `manifestVersion: "1.1"` describes the sidecar revision envelope; it is independent of `AnnotationSpec.version`, which remains the parent root version. The `revision` block stores the number, lineage ID, parent sidecar/output/spec hashes, normalized edits, and edits hash so the canonical spec/edit chain can be replayed. Pixel-identical replay additionally requires the same input, renderer, font and platform.

One transaction accepts 1–400 edits. A parent sidecar is limited to 10 MiB; one working copy supports at most 255 revisions/256 sidecars and a 512 MiB cumulative sidecar+output chain budget. The valid, read-back-verified JSON sidecar is published last as the commit marker; this is not a power-loss-atomic two-file transaction. Dead-process residue is cleaned only when lock token, lineage, parent, paths and hashes prove ownership. A committed result can separately return `recoveryWarnings` when post-commit lock/temp cleanup needs recovery.

The lock coordinates one sidecar directory. Copying the whole lineage elsewhere creates an independent working copy that can fork. A flattened PNG alone cannot tell another AI which pixels are annotations; pass the versioned sidecar with the PNG. Reading that JSON needs no AgentCallout installation, while validation, re-rendering and further revisions do.

### Revision review result

The transient `review` result does not change the sidecar or renderer:

- `changed-region` returns one crop covering every actual changed RGBA pixel together with directly touched annotations and any untargeted annotation whose auto-layout geometry moved. `sourceRect` is expressed in full-output pixels; the crop proves only local review.
- `compact-overview` retains the 512px/64 KiB low-detail full output when edits are dispersed, exceed half the canvas, affect a global spotlight, lack reliable geometry, cannot reproduce the parent output with the current renderer, or the direct parent/revised spec contains blur/redact.
- `none` returns no ImageContent when an existing blur/redact annotation is removed or any of its fields change. This avoids automatically transmitting pixels that may have become newly readable.

Each MCP result contains at most one preview image. Focus and compact-overview encoding failures do not undo an already committed revision; they return `preview.available=false`, `fallbackReason: "encoding-failed"`, and the full local output path.

### Preview pixel metrics (v0.2.1)

Successful MCP ImageContent results include `preview.pixelMetrics` in JSON TextContent and the identical object in image `_meta["agent-callout/pixelMetrics"]`. Core `createImagePreview` returns it as `pixelMetrics`. It describes the final encoded preview after EXIF orientation, optional crop, and resize. It is transient result data; it is not added to AnnotationSpec or persisted in the preview sidecar.

Let `F` be the full oriented input raster's pixel count, `S` the selected source region's pixel count (`F` for an overview), and `P` the final preview width times height:

| Field                        | Value         |
| ---------------------------- | ------------- |
| `fullRasterPixelCount`       | `F`           |
| `sourceRegionPixelCount`     | `S`           |
| `previewRasterPixelCount`    | `P`           |
| `sourceRegionCoverageRatio`  | `S / F`       |
| `previewToSourceRegionRatio` | `P / S`       |
| `previewToFullRasterRatio`   | `P / F`       |
| `previewPixelReductionRatio` | `(F - P) / F` |

Ratios are rounded to six decimals and clamped to `[0, 1]`. The reduction combines crop and resize; it does not measure retained detail or compression bytes. It is **not a model token count, token reduction, or price estimate**. Metrics are omitted when no image is sent, including `review.mode=none`, encoding failure, or failed integrity validation.

Before transmission, MCP binds the preview's input hash and dimensions to the committed output, then re-reads the final preview bytes and verifies their hash against the generated preview. It checks PNG format, single-page metadata, dimensions, and byte/pixel limits on those same bytes before base64 encoding. Failure returns text-only `encoding-failed`; the committed annotation remains available locally.

### Safe sidecar summary

`inspectAnnotationSidecar`, `agent-callout inspect-sidecar`, and MCP `inspect_annotation_sidecar` validate the strict manifest, paired output and complete parent chain without opening the original input. The result is a path/text/hash-free summary of at most 4 KiB: versions, output dimensions, counts by annotation type, identity alignment of the resolved inventory, revision number/depth and coordination boundary, warning count, integrity states, blur/redact flags, and flattened-PNG portability facts. It deliberately excludes annotation IDs/text/style/resolved geometry, raw warnings, paths/Markdown, hashes/lineage/edits, renderer/font metadata and ImageContent. The original input is therefore reported as `record-only`, never “verified.”
