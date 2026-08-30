# Privacy-safe output

A synthetic account screen: ordinary email is blurred, while the fictional token is destroyed with opaque redact pixels.

## Generate

```powershell
node dist/cli.js annotate examples/privacy/input.png --spec examples/privacy/annotations.json --output examples/privacy/output.png --allow-root . --overwrite
```

## Files

- Original: [input.png](input.png)
- AnnotationSpec: [annotations.json](annotations.json)
- Generated PNG: [output.png](output.png)
- Replay sidecar: [output.json](output.json)

![Privacy-safe output](output.png)
