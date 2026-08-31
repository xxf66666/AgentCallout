# Numbered review

A synthetic operations dashboard showing visible boundary-to-boundary numbered leaders without covering reviewed targets.

## Generate

```powershell
node dist/cli.js annotate examples/numbered-review/input.png --spec examples/numbered-review/annotations.json --output examples/numbered-review/output.png --allow-root . --overwrite
```

## Files

- Original: [input.png](input.png)
- AnnotationSpec: [annotations.json](annotations.json)
- Generated PNG: [output.png](output.png)
- Replay sidecar: [output.json](output.json)

![Numbered review](output.png)
