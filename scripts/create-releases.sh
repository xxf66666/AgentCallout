#!/usr/bin/env bash
# Create GitHub Release pages for every released tag whose docs exist.
# Requires: gh auth login (once). Idempotent: existing releases are skipped.
set -euo pipefail

for spec in \
  "v0.1.2:" \
  "v0.1.3:docs/releases/0.1.3.md" \
  "v0.2.0:docs/releases/0.2.0.md" \
  "v0.2.1:docs/releases/0.2.1.md" \
  "v0.3.0:docs/releases/0.3.0.md" \
  "v0.3.1:docs/releases/0.3.1.md" \
  "v0.4.0:docs/releases/0.4.0.md" \
  "v0.4.1:docs/releases/0.4.1.md" \
  "v0.5.0:docs/releases/0.5.0.md" \
  "v0.5.1:docs/releases/0.5.1.md" \
  "v0.6.0:docs/releases/0.6.0.md" \
  "v0.6.1:docs/releases/0.6.1.md" \
  "v0.7.0:docs/releases/0.7.0.md"
do
  tag="${spec%%:*}"
  doc="${spec#*:}"
  if gh release view "$tag" > /dev/null 2>&1; then
    echo "skip $tag (already exists)"
    continue
  fi
  notes="See docs${doc#docs} for the full release record."
  if [ -n "$doc" ] && [ -f "$doc" ]; then
    notes=$(cat "$doc")
  fi
  gh release create "$tag" --title "AgentCallout $tag" --notes "$notes"
  echo "created $tag"
done
echo "done. Missing v0.1.2 notes: write a short docs/releases/0.1.2.md or leave the default note."
