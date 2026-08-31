# UI bug annotation

A synthetic release-settings screen using AnnotationSpec 1.1 danger tone only for a real validation failure.

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
