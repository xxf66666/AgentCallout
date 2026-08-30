---
name: agent-callout
description: Annotate existing PNG, JPEG, or WebP screenshots with callouts, arrows, numbered markers, highlights, spotlight, blur, or irreversible redaction. Use for Markdown documentation, bug reports, test evidence, code reviews, and privacy-safe screenshot sharing; not for capturing new screenshots or editing video.
license: MIT
metadata:
  author: AgentCallout contributors
  version: "0.1.2"
---

# AgentCallout

Turn an existing screenshot into a reproducible annotated PNG and JSON sidecar. Keep the original unchanged.

## Workflow

1. Call `inspect_image` before proposing coordinates. Use the returned, orientation-corrected width and height.
2. If the target is small or ambiguous, call `crop_image` first and inspect that result. Do not guess a precise target from an unreadable full-size image.
3. Build an AnnotationSpec with stable, meaningful IDs. Prefer normalized coordinates when the spec should survive resolution changes; use pixels for exact crops or known screenshots.
4. Call `validate_annotation_spec`. Correct errors and review warnings before rendering.
5. Call `annotate_image`. The tool writes a PNG and replayable JSON sidecar without overwriting the source.
6. Inspect the returned preview. If the host does not expose image content, open the absolute output path or use `crop_image` on the result. Check arrow targets, text wrapping, target occlusion, and callout overlap.
7. Revise the same spec and render again when placement is weak. Do not claim success until the final image has been viewed.
8. Return the final absolute path and the tool-provided Markdown image reference.

## Annotation choices

- Use `rectangle` or `ellipse` to bound a target.
- Use `arrow` when the destination matters more than an area.
- Use `callout` for explanatory text and `numbered-callout` for ordered review findings.
- Use `highlight` to tint a region; use `spotlight` to dim everything outside the focus.
- Use `blur` only for visual de-emphasis. It is not safe redaction.
- Use `redact` for passwords, tokens, credentials, personal identifiers, or any content that must not remain recoverable in the output pixels.

## Quality rules

- Keep callout text short and let AgentCallout wrap it. Prefer multiple focused callouts over one large paragraph.
- Preserve warnings in the final response. A layout warning means the result needs visual review, not silent acceptance.
- Never hand-edit a sidecar hash or claim that blur removed the underlying pixels.
- Do not overwrite the source image. Use a new output path for each materially different revision.

Read [AnnotationSpec reference](references/annotation-spec.md) when constructing or modifying a spec beyond a simple single annotation.
