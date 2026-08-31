# Constructing AnnotationSpec 1.1

Use 1.1 for new annotations. Existing 1.0 sidecars remain valid and must be replayed as 1.0 when their canonical JSON or pixels matter; 1.0 rejects every 1.1-only field. Both versions are strict at the root, annotation, geometry, and style levels.

The repository's normative manual is [AnnotationSpec 1.0 and 1.1](../../../../../docs/annotation-spec.md). This installed reference contains the complete 1.1 authoring contract needed by an agent.

## Minimal skeleton

```json
{
  "version": "1.1",
  "coordinateSpace": "normalized",
  "preset": "docs-light",
  "annotations": [
    {
      "id": "save-button",
      "type": "rectangle",
      "rect": { "x": 0.72, "y": 0.74, "width": 0.2, "height": 0.12 }
    }
  ]
}
```

- `version` is exactly `"1.1"` for new work or `"1.0"` for legacy replay.
- `coordinateSpace` is `"pixel"` or `"normalized"` and defaults to `"pixel"`.
- Each annotation may set its own `coordinateSpace` to override the root value; otherwise it inherits the root value.
- 1.1 `preset` is `docs-light`, `docs-dark`, `high-contrast`, or `classic-red`; it defaults to `docs-light`.
- Optional root `defaults` is a strict style patch shared by all annotations.
- Use at most 200 annotations. Each `text` value contains 1 to 10,000 UTF-16 code units, and all `text` values together contain at most 100,000.
- IDs are optional, at most 64 characters, and match `^[A-Za-z0-9][A-Za-z0-9_-]*$`; missing IDs become deterministic `a1`, `a2`, and so on.
- A `numbered-callout` number is an integer from 1 through 9,999.
- A `blur` sigma is finite, ranges from `0.3` through `1000`, and defaults to `10`.

## Coordinates and bounds

The origin is the top-left corner. A point is `{ "x": number, "y": number }`; a rectangle is `{ "x": number, "y": number, "width": positive-number, "height": positive-number }`; and a target may be either. Geometry objects are strict, and every number must be finite.

- In `pixel` space, fractional values are allowed. A point must be inside the image before rounding: `0 <= x < imageWidth` and `0 <= y < imageHeight`. A rectangle may start outside the image, but its width and height must be positive and it must intersect the canvas.
- In `normalized` space, point components and rectangle `x`/`y` are in `[0, 1]`; rectangle `width`/`height` are in `(0, 1]`. A valid normalized rectangle may extend past the right or bottom edge when its origin and size sum to more than `1`.

Points resolve to the nearest pixel; normalized points scale against `imageWidth - 1` and `imageHeight - 1`, so `(1, 1)` selects the bottom-right pixel. Rectangle edges scale against the full canvas extent. An intersecting rectangle that crosses an edge is clamped with a warning. A wholly outside or integer-empty rectangle is an error, and an out-of-canvas point is always an error.

## Choose geometry by intent

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

For callouts, omit `placement` or use `auto` first. Other values are `top`, `right`, `bottom`, and `left`. Prefer a rectangular target when its bounds are known.

For a 1.1 `numbered-callout`, keep `target` on the reviewed point or rectangle. The renderer separately resolves the label, attaches the marker immediately outside the label edge facing that target, and connects the painted marker boundary to the point or rectangular boundary. It reserves at least 24px of exposed leader when the canvas and occupied annotations permit. The sidecar records `target`, `marker`, `label`, and `leader`; these are audit output only and remain invalid as input fields. Version 1.0 deliberately retains its original target-centered marker and paint order.

The marker-aware 1.1 numbered geometry is versioned with renderer 0.1.3. Check sidecar renderer/font metadata and regenerate plus visually review under a changed renderer; do not claim cross-build pixel equivalence. Frozen 1.0 replay remains unchanged.

## Style without repetition

Every field resolves independently in this order:

```text
annotation.style > annotation.tone > root defaults > preset/type defaults
```

Omitting `tone` means no tone patch, not `neutral`. Put repeated width, font, padding, or other shared values in root `defaults`; use annotation `style` only for a local override.

Shared style keys are `strokeColor`, `fillColor`, `textColor`, `backgroundColor`, `strokeWidth` (`0..64`), `fontSize` (`6..256`), `opacity` (`0..1`), `padding` (`0..128`), `cornerRadius` (`0..256`), `lineHeight` (`1..3`), and `arrowHeadSize` (`1..128`). Version 1.1 adds:

- `maxWidth` (`48..4096`) for text/callout wrapping;
- `markerStrokeColor`, `markerFillColor`, and `markerTextColor` for a numbered marker independent of its label.

Colors are only `#RRGGBB` or `#RRGGBBAA`; parsing uppercases them. Named colors, three-digit hex, functions, and unknown fields fail validation.

## Presets and tones

| Preset          | Label text / background | Border    | Marker fill / text    |
| --------------- | ----------------------- | --------- | --------------------- |
| `docs-light`    | `#0F172A` / `#EFF6FF`   | `#2563EB` | `#2563EB` / `#FFFFFF` |
| `docs-dark`     | `#F8FAFC` / `#1E293B`   | `#60A5FA` | `#2563EB` / `#FFFFFF` |
| `high-contrast` | `#FFFFFF` / `#000000`   | `#FACC15` | `#FACC15` / `#000000` |
| `classic-red`   | `#FFFFFF` / `#D92D20`   | `#FF3B30` | `#D92D20` / `#FFFFFF` |

| Tone      | Label text / background | Border    | Marker fill / text    |
| --------- | ----------------------- | --------- | --------------------- |
| `neutral` | `#0F172A` / `#F1F5F9`   | `#64748B` | `#475569` / `#FFFFFF` |
| `info`    | `#0F172A` / `#EFF6FF`   | `#2563EB` | `#2563EB` / `#FFFFFF` |
| `success` | `#14532D` / `#F0FDF4`   | `#15803D` | `#15803D` / `#FFFFFF` |
| `warning` | `#78350F` / `#FFFBEB`   | `#B45309` | `#B45309` / `#FFFFFF` |
| `danger`  | `#7F1D1D` / `#FEF2F2`   | `#DC2626` | `#DC2626` / `#FFFFFF` |

The built-in palette emits red only through `danger` and `classic-red`. Keep ordinary explanatory notes on the preset default or use `neutral`/`info`. This reservation does not prohibit or rewrite an explicit valid hex color: it is authoritative whenever it wins the documented per-field priority (annotation `style` remains above `tone`, while root `defaults` remains below it). Visually check the contrast and semantic meaning of every custom color.

## Migrating numbered-callout markers from 1.0

Replay a stored 1.0 spec as 1.0 when its canonical JSON or pixels matter; do not add 1.1-only fields to it. Version 1.0 has no `marker*` fields: a `numbered-callout` marker takes its outline from the resolved `strokeColor`, its fill from the resolved `backgroundColor`, and its number from the resolved `textColor`.

Version 1.1 resolves marker colors independently. When authoring a standalone migrated 1.1 spec from a custom 1.0 numbered callout and preserving its marker appearance matters, copy those former resolved values to `markerStrokeColor`, `markerFillColor`, and `markerTextColor`, respectively. Omit the three fields when intentionally adopting the selected 1.1 preset/tone marker palette. `revise_annotation` preserves the parent root version and cannot perform this migration.

## Redact is the safety boundary

`blur` is reversible visual weakening, not safe deletion. Use `redact` for credentials, tokens, identifiers, or anything that must not survive in output pixels. `redact.color` is opaque `#RRGGBB`. After all preset/default/tone/style resolution, redact still forces `fillColor` to that color and `opacity` to `1`; a local redact opacity other than `1` is rejected.

## Safe versioned revisions

Once `annotate_image` has committed a PNG and sidecar, modify it with `revise_annotation` instead of deleting files, overwriting output, or submitting a replacement root spec. The tool accepts:

```json
{
  "parentSidecarPath": "C:\\work\\shot.annotated.json",
  "edits": [
    {
      "op": "add",
      "afterId": "save-button",
      "annotation": {
        "id": "save-note",
        "type": "callout",
        "target": { "x": 420, "y": 260, "width": 120, "height": 44 },
        "text": "Save does not respond"
      }
    }
  ]
}
```

- `add` requires a new explicit annotation ID. Omit `afterId` to append, or name an annotation that exists at that point in the ordered edit sequence.
- `set` requires both `id` and a complete `annotation` with the same ID. It replaces the whole annotation in place; it is not merge or JSON Patch.
- `remove` contains only `op` and an existing `id`.
- One transaction may not touch the same ID twice. Unknown IDs, duplicate IDs, missing IDs, no-op sets, unknown fields, or an invalid final AnnotationSpec reject the whole transaction.
- Do not pass `outputPath`, `overwrite`, or `revisionNumber`; the next `.revN.png/.json` is derived from the committed head.
- If the recorded relative original is missing, pass `inputPath` for the moved original. Basename-only records always require it. Different bytes fail with `INPUT_HASH_MISMATCH`; the tool never scans the disk to guess.

The renderer always starts from the original image, not from the annotated parent PNG and never from `resolvedAnnotations`. The new sidecar records the parent hashes and normalized edits. `manifestVersion: "1.1"` is the revision envelope and does not change `AnnotationSpec.version`. Only a sidecar that exists and passes complete readback validation is the commit marker; a PNG without it is not a committed revision. A revision-aware reader can therefore reject a half-published pair, but this is not a power-loss-atomic two-file transaction.

One transaction accepts 1–400 edits. Parent sidecars are limited to 10 MiB; one working copy supports 255 revisions/256 sidecars and a 512 MiB cumulative sidecar+output chain budget. Dead-process residue is auto-cleaned only when token, lineage, parent, paths, and hashes prove ownership. Report `recoveryWarnings` separately from render/layout `warnings`.

The lock coordinates one sidecar directory, not every copied checkout. A full lineage copied elsewhere is an independent working copy and can fork. When handing the result to another AI, include both PNG and JSON sidecar: the JSON is readable without AgentCallout, while validation, replay, or further revision requires the CLI/MCP.

## Validation and replay loop

1. Inspect the image and use its orientation-corrected dimensions.
2. Construct a strict spec without comments, paths, timestamps, selector metadata, or arbitrary fields.
3. Validate and resolve it against the actual image size.
4. Treat wholly outside or empty geometry as an error. Review every clamp or layout warning.
5. Render and inspect label wrapping, marker contrast, target visibility, callout overlap, and the full numbered leader. A 1.1 warning about a leader shorter than 24px or invisible, a reduced/clipped stroke, marker/target overlap, marker/label overlap, or occupied geometry means the placement is degraded and must not be silently accepted.
6. Revise coordinates or placement as needed while preserving annotation order and IDs.

Canonicalization inserts schema defaults and generated IDs, uppercases hex colors, sorts object keys, and preserves annotation order. Version 1.1 also inserts `preset: "docs-light"`; version 1.0 canonical output remains unchanged. Pixel-identical replay additionally requires the same source image, renderer, fonts, and platform.
