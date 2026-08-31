export const NUMBERED_CALLOUT_CANVAS = { width: 640, height: 400 } as const;

export const NUMBERED_CALLOUT_V11_SPEC = {
  version: "1.1",
  preset: "docs-light",
  defaults: { fontSize: 16, maxWidth: 160, padding: 8 },
  annotations: [
    {
      id: "public-entry-leader",
      type: "numbered-callout",
      target: { x: 420, y: 170, width: 80, height: 60 },
      text: "可见编号引线 / Visible numbered leader",
      number: 7,
      placement: "left",
      tone: "info",
      style: {
        strokeColor: "#0A7A42",
        strokeWidth: 3,
        markerStrokeColor: "#5B21B6",
        markerFillColor: "#7C3AED",
        markerTextColor: "#FFFFFF"
      }
    }
  ]
} as const;
