# AnnotationSpec v1.0

AnnotationSpec is AgentCallout's strict, replayable description of annotations over an existing image. It contains no input/output paths, timestamps, hashes, random values, or renderer state. The source image and concrete canvas size are supplied separately.

## Root object

```json
{
  "version": "1.0",
  "coordinateSpace": "pixel",
  "annotations": []
}
```

| Field             | Required | Value                                                                |
| ----------------- | -------- | -------------------------------------------------------------------- |
| `version`         | yes      | Exactly `"1.0"`. Other versions are rejected.                        |
| `coordinateSpace` | no       | `"pixel"` or `"normalized"`; defaults to `"pixel"`.                  |
| `annotations`     | yes      | Up to 200 annotation objects in paint order. The array may be empty. |

Root, annotation, geometry, and style objects are strict: unknown fields are rejected. Annotation order is significant and is retained during parsing, resolution, and canonicalization.

The combined `text` length across `text`, `callout`, and `numbered-callout` annotations must not exceed 100,000 UTF-16 code units. This bounds validation and renderer work before image allocation.

Every annotation accepts these common fields:

| Field             | Required | Value                                                                            |
| ----------------- | -------- | -------------------------------------------------------------------------------- |
| `type`            | yes      | One of the ten annotation types below.                                           |
| `id`              | no       | Stable identifier matching `^[A-Za-z0-9][A-Za-z0-9_-]*$`, at most 64 characters. |
| `coordinateSpace` | no       | Overrides the root coordinate space for this annotation.                         |
| `style`           | no       | Strict style object described under [Styles](#styles).                           |

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

## Styles

Colors accept only `#RRGGBB` or `#RRGGBBAA`, with alpha last. Three-digit colors, named CSS colors, functions, and other CSS strings are rejected. Parsing normalizes letters to uppercase. The `redact.color` field is stricter and accepts no alpha channel.

| Field             | Range            | Resolved base default |
| ----------------- | ---------------- | --------------------- |
| `strokeColor`     | strict hex color | `#FF3B30`             |
| `fillColor`       | strict hex color | `#00000000`           |
| `textColor`       | strict hex color | `#FFFFFF`             |
| `backgroundColor` | strict hex color | `#D92D20`             |
| `strokeWidth`     | `0` to `64`      | `3`                   |
| `fontSize`        | `6` to `256`     | `24`                  |
| `opacity`         | `0` to `1`       | `1`                   |
| `padding`         | `0` to `128`     | `10`                  |
| `cornerRadius`    | `0` to `256`     | `6`                   |
| `lineHeight`      | `1` to `3`       | `1.25`                |
| `arrowHeadSize`   | `1` to `128`     | `12`                  |

Type-specific resolved defaults override the base before user-supplied style values are applied:

| Type        | Overrides                                                                          |
| ----------- | ---------------------------------------------------------------------------------- |
| `text`      | `strokeWidth: 0`, `textColor: #FF3B30`, transparent background                     |
| `highlight` | `strokeColor: #FFD43B00`, `fillColor: #FFD43B80`                                   |
| `spotlight` | `strokeColor: #FFFFFF`, `fillColor: #000000A6`                                     |
| `blur`      | `strokeWidth: 0`                                                                   |
| `redact`    | `strokeWidth: 0`; resolved `fillColor` is its opaque `color`, and `opacity` is `1` |

Rectangle, ellipse, arrow, callout, and numbered-callout use the base defaults unless their `style` overrides a value.

## Stable IDs

Explicit IDs are preserved and duplicate explicit IDs are rejected. Missing IDs are generated deterministically in annotation order as `a1`, `a2`, and so on. Generation skips every explicit ID already present anywhere in the input. For example, if a later annotation explicitly uses `a1`, the first missing ID becomes `a2`.

Use meaningful explicit IDs when another report or workflow needs to refer to an annotation. Otherwise, generated IDs are stable for the same ordered input.

## Blur and redact are not interchangeable

`blur` is reversible visual weakening: structure and sometimes text may remain inferable, and the output region is not guaranteed to be safe against recovery techniques. Use it only for de-emphasis or low-risk privacy treatment.

`redact` is the security control. The renderer replaces the selected output pixels with a fully opaque solid color. Use it for passwords, tokens, credentials, personal identifiers, or any content that must not remain in the output image. Never describe a blurred value as removed.

## Canonicalization and replay

`canonicalizeSpec(value)` first performs the same strict parse as `parseAnnotationSpec`. It therefore inserts the root coordinate-space default, generated IDs, default placement, default blur sigma, default redact color, and uppercase color spelling. It then recursively sorts object keys and emits compact JSON. Annotation array order is retained.

The canonical string is stable for semantically identical valid input regardless of object key order. Canonicalization never invents timestamps or random IDs: explicit IDs are preserved and missing IDs use the deterministic sequence described above. Runtime timestamp fields, random-seed fields, source paths, hashes, and warnings are not accepted AnnotationSpec fields. Replaying the same canonical spec against the same canvas dimensions produces the same resolved pixel spec. Pixel-identical rendered output additionally requires the same source image, renderer version, fonts, and rendering environment.

## Complete compact examples

### UI bug

```json
{
  "version": "1.0",
  "coordinateSpace": "normalized",
  "annotations": [
    {
      "id": "invalid-field",
      "type": "rectangle",
      "rect": { "x": 0.61, "y": 0.28, "width": 0.3, "height": 0.13 },
      "style": { "strokeColor": "#FF3B30", "strokeWidth": 4 }
    },
    {
      "id": "save-arrow",
      "type": "arrow",
      "start": { "x": 0.48, "y": 0.83 },
      "target": { "x": 0.82, "y": 0.78 },
      "style": { "strokeColor": "#FF3B30" }
    },
    {
      "id": "save-note",
      "type": "callout",
      "target": { "x": 0.72, "y": 0.72, "width": 0.2, "height": 0.12 },
      "text": "点击保存后没有响应",
      "placement": "top"
    }
  ]
}
```

### Numbered review

```json
{
  "version": "1.0",
  "coordinateSpace": "normalized",
  "annotations": [
    {
      "id": "review-1",
      "type": "numbered-callout",
      "target": { "x": 0.08, "y": 0.14, "width": 0.22, "height": 0.12 },
      "text": "标题层级不清晰",
      "number": 1,
      "placement": "right"
    },
    {
      "id": "review-2",
      "type": "numbered-callout",
      "target": { "x": 0.43, "y": 0.38, "width": 0.28, "height": 0.16 },
      "text": "状态信息缺少上下文",
      "number": 2,
      "placement": "left"
    },
    {
      "id": "review-3",
      "type": "numbered-callout",
      "target": { "x": 0.68, "y": 0.76, "width": 0.2, "height": 0.1 },
      "text": "主要操作不够醒目",
      "number": 3,
      "placement": "top"
    }
  ]
}
```

### Privacy

```json
{
  "version": "1.0",
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
      "style": { "textColor": "#DC2626", "fontSize": 22 }
    }
  ]
}
```

Validate a spec before rendering, resolve it against the inspected image dimensions, retain its warnings, and save the canonical or sidecar representation needed for replay.
