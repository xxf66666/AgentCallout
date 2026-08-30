# UI bug annotation

A synthetic release-settings screen with a boxed validation error, an arrow to Save, and a Chinese callout.

## Generate

```powershell
node dist/cli.js annotate examples/ui-bug/input.png --spec examples/ui-bug/annotations.json --output examples/ui-bug/output.png --allow-root . --overwrite
```

## Files

- Original: [input.png](input.png)
- AnnotationSpec: [annotations.json](annotations.json)
- Generated PNG: [output.png](output.png)
- Replay sidecar: [output.json](output.json)

![UI bug annotation](output.png)
