# Constructing AnnotationSpec v1.0

Use this guide while composing tool input. The normative field definitions, limits, defaults, and complete examples are in the repository's [AnnotationSpec manual](../../../../../docs/annotation-spec.md).

## Minimal skeleton

```json
{
  "version": "1.0",
  "coordinateSpace": "normalized",
  "annotations": [
    {
      "id": "save-button",
      "type": "rectangle",
      "rect": { "x": 0.72, "y": 0.74, "width": 0.2, "height": 0.12 }
    }
  ]
}
```

- Set `version` to exactly `"1.0"`.
- `coordinateSpace` defaults to `"pixel"`; override it on one annotation only when needed.
- Use finite numbers. Rectangles need positive `width` and `height`.
- Use at most 200 annotations; combined annotation text is capped at 100,000 characters.
- In normalized space, point components and rectangle origins are in `[0, 1]`; normalized sizes are in `(0, 1]`.
- IDs are optional. Prefer safe, meaningful IDs using letters, digits, `_`, and `-`. Missing IDs become deterministic `a1`, `a2`, and so on.

## Choose the geometry that matches the intent

| Intent                              | Type and required geometry                                     |
| ----------------------------------- | -------------------------------------------------------------- |
| Bound an area                       | `rectangle` or `ellipse` with `rect`                           |
| Point at something                  | `arrow` with point `start` and point-or-rect `target`          |
| Place unconnected text              | `text` with `position` and `text`                              |
| Explain a target                    | `callout` with point-or-rect `target` and `text`               |
| Build an ordered review             | `numbered-callout` with `target`, `text`, and integer `number` |
| Tint an area                        | `highlight` with `rect`                                        |
| Dim everything except an area       | `spotlight` with `rect`                                        |
| Visually weaken low-risk content    | `blur` with `rect` and optional `sigma`                        |
| Irreversibly cover sensitive pixels | `redact` with `rect` and optional opaque `color`               |

For callouts, omit `placement` or use `"auto"` first. The other values are `"top"`, `"right"`, `"bottom"`, and `"left"`. Prefer a rectangular target when its bounds are known; this gives the leader and collision logic more useful geometry.

## Style safely

Use only `#RRGGBB` or `#RRGGBBAA` colors. Common style keys are `strokeColor`, `fillColor`, `textColor`, `backgroundColor`, `strokeWidth`, `fontSize`, `opacity`, `padding`, `cornerRadius`, `lineHeight`, and `arrowHeadSize`. Omit style fields when the defaults are adequate; do not copy a complete style block into every annotation.

`blur` is not secure redaction. Use `redact` for credentials, tokens, personal identifiers, or anything that must not survive in output pixels. A redact color must be opaque `#RRGGBB`, and redact opacity cannot be reduced.

## Validation loop

1. Inspect the image and use its orientation-corrected dimensions.
2. Construct a strict spec; do not add comments, paths, timestamps, selector metadata, or arbitrary fields.
3. Validate and resolve it against the actual image size.
4. Treat wholly outside or empty geometry as an error. Review every clamp or layout warning.
5. Render, inspect the output, and revise coordinates or placement when a callout obscures its target.
6. Preserve annotation order and IDs when revising so replay and references remain stable.

Canonicalization inserts schema defaults and generated IDs, uppercases hex colors, sorts object keys, and preserves annotation array order. The same canonical spec and canvas size produce the same resolved pixel geometry; the same source image and renderer environment are also needed for pixel-identical output.
