---
name: agent-callout
description: Annotate existing PNG, JPEG, or WebP screenshots with callouts, arrows, numbered markers, highlights, spotlight, blur, or irreversible redaction. Use for Markdown documentation, bug reports, test evidence, code reviews, and privacy-safe screenshot sharing; not for capturing new screenshots or editing video.
license: MIT
metadata:
  author: AgentCallout contributors
  version: "0.2.0"
---

# AgentCallout

Turn an existing screenshot into a reproducible annotated PNG and JSON sidecar. Keep the original unchanged.

## Workflow

1. Call `inspect_image` before proposing coordinates. Use the returned, orientation-corrected width and height.
2. If the target is small or ambiguous, call `crop_image` first and inspect that result. Do not guess a precise target from an unreadable full-size image.
3. Build new work as AnnotationSpec 1.1 with stable, meaningful IDs. Replay an existing 1.0 sidecar unchanged when compatibility matters. Prefer normalized coordinates when the spec should survive resolution changes; use pixels for exact crops or known screenshots.
4. Call `validate_annotation_spec`. Correct errors and review warnings before rendering.
5. Call `annotate_image`. The tool writes a PNG and replayable JSON sidecar without overwriting the source.
6. Inspect the returned compact overview. It is intentionally limited to 512px/64 KiB with low detail. If small text or exact placement is unclear, use `crop_image` on the saved output instead of repeatedly requesting a full-image high-detail preview. If the host does not expose image content, open the absolute output path. Check arrow targets, text wrapping, target occlusion, and callout overlap.
7. When a committed annotate sidecar needs adjustment, call `revise_annotation` with ordered stable-ID `add`, `set`, or `remove` edits. A full same-ID replacement is `{"op":"set","id":"...","annotation":{...}}`; never invent `op:"replace"`. Do not delete prior PNG/JSON files, rewrite the full root spec, or guess a revision number. Supply `inputPath` when the original moved or when the parent uses basename-only input semantics; the bytes must match the parent hash.
8. Inspect every returned revision preview. `changed-region` contains touched annotations plus any collateral auto-layout movement and carries an original-canvas `sourceRect`; use it for local QA without another crop, but do not claim it proves global layout. `compact-overview` means focus was dispersed, too large, global, unavailable, or intentionally kept low-detail around blur/redact. `none` means sensitive coverage changed: no image was sent, so review the saved output only under the applicable privacy policy. If the host omits ImageContent unexpectedly, say visual verification remains incomplete.
9. When handing an existing sidecar to another AI, call `inspect_annotation_sidecar` for a small integrity/inventory summary. It deliberately omits paths, hashes, IDs, annotation text, style, and raw geometry. The ordinary JSON sidecar remains directly readable without installing AgentCallout.
10. Return the final absolute path and the tool-provided Markdown image reference.

## Annotation choices

- Use `rectangle` or `ellipse` to bound a target.
- Use `arrow` when the destination matters more than an area.
- Use `callout` for explanatory text and `numbered-callout` for ordered review findings.
- In 1.1, a numbered marker is attached to the target-facing outside edge of its label and a visible leader connects the marker boundary to the target boundary. Do not move the target merely to position the marker; `target` must continue to identify the reviewed content.
- For 1.1, start with `docs-light`; use root `defaults` for repeated dimensions and `tone` for semantic color. Omit tone or use `neutral`/`info` for ordinary explanations. Reserve `danger` for actual errors or risks and `classic-red` for an explicitly requested legacy-red visual.
- Use `highlight` to tint a region; use `spotlight` to dim everything outside the focus.
- Use `blur` only for visual de-emphasis. It is not safe redaction.
- Use `redact` for passwords, tokens, credentials, personal identifiers, or any content that must not remain recoverable in the output pixels.

## Quality rules

- Keep callout text short and let AgentCallout wrap it. Prefer multiple focused callouts over one large paragraph.
- Prefer preset/defaults/tone over repeating full style objects. Use annotation `style` only for a deliberate local override.
- Inspect long-text wrapping plus numbered-marker outline, fill, number contrast, target visibility, and the complete exposed leader in the final preview. On an unconstrained canvas the leader should expose at least 24px; any shorter/invisible leader, reduced or clipped stroke, marker-overlap, clamp, or occupied-callout warning requires revision or an explicit limitation in the final response.
- Preserve warnings in the final response. A layout warning means the result needs visual review, not silent acceptance.
- Report `recoveryWarnings` separately: the revision is committed, but lock/temp cleanup still needs recovery. Do not rewrite these into sidecar render warnings.
- A changed-region preview is one local crop, not the whole output. Preserve `sourceRect`, `mode`, touched/affected counts, fallback reason, and preview byte/dimension metadata when reporting what was actually reviewed.
- Never request an automatic high-detail preview after blur/redact coverage is removed, moved, shrunk, or weakened. `preview.mode=none` is a privacy boundary, not a tool failure.
- Never hand-edit a sidecar hash or claim that blur removed the underlying pixels.
- Do not overwrite the source image. Use a new output path for each materially different revision.
- Treat only an existing, fully validated revision sidecar as the commit marker. A PNG without its sidecar is an orphan, not a successful revision; do not describe the two-file publish as power-loss atomic or cryptographically signed.
- For revisions, `set` is a full same-ID replacement that preserves order. `add` needs a new explicit ID and may use `afterId`; never touch the same ID twice in one edit batch.
- Revision locks coordinate one sidecar directory. A complete lineage copied elsewhere is an independent working copy that can fork; never describe it as a global cross-directory head.
- When another AI will consume the deliverable, include both the flattened PNG and the versioned JSON sidecar. The JSON is directly readable without AgentCallout and identifies annotation IDs, geometry, warnings, hashes, and lineage; the PNG alone cannot reliably separate original pixels from overlays.

Read [AnnotationSpec reference](references/annotation-spec.md) when constructing or modifying a spec beyond a simple single annotation.
