import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { annotateImage, validateSpecForImage } from "../src/core/index.js";
import { circleOverlapsTarget } from "../src/layout/index.js";
import { paintedSegmentIntersectsRect, renderAnnotations } from "../src/renderer/index.js";
import {
  NUMBERED_CALLOUT_CANVAS,
  NUMBERED_CALLOUT_V11_SPEC
} from "./fixtures/numbered-callout-v11.js";

interface ResolvedNumberedCallout {
  target: { x: number; y: number; width?: number; height?: number };
  box: { x: number; y: number; width: number; height: number };
  marker: {
    center: { x: number; y: number };
    radius: number;
    paintedRadius: number;
    labelSide?: "top" | "right" | "bottom" | "left";
    bounds: { x: number; y: number; width: number; height: number };
  };
  label: {
    box: { x: number; y: number; width: number; height: number };
    paintedBounds: { x: number; y: number; width: number; height: number };
    placement: "top" | "right" | "bottom" | "left";
    fontSize?: number;
  };
  leader: {
    start: { x: number; y: number };
    end: { x: number; y: number };
    length: number;
    bounds?: { x: number; y: number; width: number; height: number };
    strokeWidth?: number;
  };
}

async function writePattern(filePath: string, width: number, height: number): Promise<void> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 11 + y * 3) % 251;
      pixels[offset + 1] = (x * 5 + y * 13) % 241;
      pixels[offset + 2] = (x * 7 + y * 17) % 239;
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(filePath);
}

async function rgbAt(filePath: string, x: number, y: number): Promise<[number, number, number]> {
  const raw = await sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * raw.info.width + x) * raw.info.channels;
  return [raw.data[offset] ?? -1, raw.data[offset + 1] ?? -1, raw.data[offset + 2] ?? -1];
}

async function resolvedNumberedCallout(sidecarPath: string): Promise<ResolvedNumberedCallout> {
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as {
    resolvedAnnotations: ResolvedNumberedCallout[];
  };
  const resolved = sidecar.resolvedAnnotations[0];
  if (resolved === undefined) throw new Error("Missing resolved numbered callout.");
  return resolved;
}

function markerOverlapsTarget(resolved: ResolvedNumberedCallout): boolean {
  const { center, paintedRadius } = resolved.marker;
  const target = resolved.target;
  if (target.width === undefined || target.height === undefined) {
    return Math.hypot(center.x - target.x, center.y - target.y) < paintedRadius;
  }
  const closestX = Math.min(target.x + target.width, Math.max(target.x, center.x));
  const closestY = Math.min(target.y + target.height, Math.max(target.y, center.y));
  return Math.hypot(center.x - closestX, center.y - closestY) < paintedRadius;
}

function expectPointOnTargetBoundary(resolved: ResolvedNumberedCallout): void {
  const target = resolved.target;
  if (target.width === undefined || target.height === undefined) {
    expect(resolved.leader.end.x).toBeCloseTo(target.x, 6);
    expect(resolved.leader.end.y).toBeCloseTo(target.y, 6);
    return;
  }
  const end = resolved.leader.end;
  const onVerticalEdge =
    (Math.abs(end.x - target.x) <= 2 || Math.abs(end.x - (target.x + target.width)) <= 2) &&
    end.y >= target.y - 2 &&
    end.y <= target.y + target.height + 2;
  const onHorizontalEdge =
    (Math.abs(end.y - target.y) <= 2 || Math.abs(end.y - (target.y + target.height)) <= 2) &&
    end.x >= target.x - 2 &&
    end.x <= target.x + target.width + 2;
  expect(onVerticalEdge || onHorizontalEdge).toBe(true);
}

describe("Sharp annotation renderer", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "agent-callout-render-"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("uses stroke-aware segment/rectangle intersection instead of a diagonal AABB", () => {
    const segment = { start: { x: 10, y: 10 }, end: { x: 90, y: 90 }, strokeWidth: 4 };

    expect(paintedSegmentIntersectsRect(segment, { x: 10, y: 80, width: 8, height: 8 })).toBe(
      false
    );
    expect(paintedSegmentIntersectsRect(segment, { x: 48, y: 48, width: 4, height: 4 })).toBe(true);
  });

  it("rejects malformed direct-renderer targets and unsupported runtime spec versions", async () => {
    for (const specVersion of ["1.2", null, 1]) {
      await expect(
        renderAnnotations(Buffer.alloc(0), [], { specVersion } as never)
      ).rejects.toThrow(/Unsupported renderer AnnotationSpec version/u);
    }

    const input = await sharp({
      create: { width: 80, height: 60, channels: 3, background: "white" }
    })
      .png()
      .toBuffer();
    await expect(renderAnnotations(input, [])).resolves.toMatchObject({ width: 80, height: 60 });
    for (const target of [
      { x: 40, y: 30, width: 8 },
      { x: 40, y: 30, stray: true }
    ]) {
      await expect(
        renderAnnotations(
          input,
          [
            {
              id: "bad-runtime-target",
              type: "numbered-callout",
              target,
              text: "bad",
              number: 1
            }
          ],
          { specVersion: "1.1" }
        )
      ).rejects.toThrow(/target must contain|target must contain only/u);
    }
  });

  it("renders all ten annotation types with bounded Chinese/English callouts", async () => {
    const inputPath = path.join(temporaryDirectory, "ui source.png");
    const outputPath = path.join(temporaryDirectory, "all types.png");
    await writePattern(inputPath, 640, 420);
    const longText =
      "中文说明与 English explanation wrap together, including a deliberatelyLongTokenWithoutSpaces1234567890 and <literal markup> & symbols.";
    const spec = {
      version: "1.0",
      annotations: [
        {
          id: "spot",
          type: "spotlight",
          rect: { x: 300, y: 210, width: 250, height: 150 }
        },
        {
          id: "rect",
          type: "rectangle",
          rect: { x: 290, y: 200, width: 270, height: 170 },
          style: { strokeWidth: 6, cornerRadius: 18 }
        },
        {
          id: "ellipse",
          type: "ellipse",
          rect: { x: 45, y: 35, width: 120, height: 80 }
        },
        {
          id: "arrow",
          type: "arrow",
          start: { x: 230, y: 110 },
          target: { x: 320, y: 230 },
          style: { arrowHeadSize: 24 }
        },
        {
          id: "text",
          type: "text",
          position: { x: 20, y: 135 },
          text: longText,
          style: { fontSize: 22, lineHeight: 1.4 }
        },
        {
          id: "callout",
          type: "callout",
          target: { x: 350, y: 250, width: 100, height: 45 },
          text: `点击后没有响应。${longText}`,
          placement: "auto"
        },
        {
          id: "numbered",
          type: "numbered-callout",
          target: { x: 520, y: 90 },
          number: 3,
          text: "第三处问题 / issue three",
          placement: "auto"
        },
        {
          id: "highlight",
          type: "highlight",
          rect: { x: 25, y: 335, width: 220, height: 42 },
          style: { strokeWidth: 0 }
        },
        {
          id: "blur",
          type: "blur",
          rect: { x: 40, y: 260, width: 100, height: 45 },
          sigma: 5
        },
        {
          id: "redact",
          type: "redact",
          rect: { x: 160, y: 260, width: 105, height: 45 },
          color: "#101820"
        }
      ]
    };

    const result = await annotateImage({
      inputPath,
      outputPath,
      spec,
      allowedRoots: [temporaryDirectory]
    });
    const decoded = await sharp(result.outputPath).metadata();
    const manifest = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
      resolvedAnnotations: Record<string, unknown>[];
      annotationSpec: { annotations: { text?: string }[] };
    };

    expect(decoded.format).toBe("png");
    expect(decoded.width).toBe(640);
    expect(decoded.height).toBe(420);
    expect(result.annotationCount).toBe(10);
    expect(result.usesBlur).toBe(true);
    expect(result.usesRedact).toBe(true);
    expect(manifest.resolvedAnnotations.map((item) => item.type)).toEqual(
      spec.annotations.map((item) => item.type)
    );
    expect(manifest.annotationSpec.annotations[4]?.text).toBe(longText);

    for (const annotation of manifest.resolvedAnnotations) {
      const box = annotation.box as
        { x: number; y: number; width: number; height: number } | undefined;
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(640);
        expect(box.y + box.height).toBeLessThanOrEqual(420);
      }
    }
  });

  it("keeps the fixed 1.0 canonical and PNG golden unchanged", async () => {
    const inputPath = path.join(temporaryDirectory, "v1 baseline input.png");
    const outputPath = path.join(temporaryDirectory, "v1 baseline output.png");
    await writePattern(inputPath, 480, 320);
    const spec = {
      version: "1.0",
      annotations: [
        {
          id: "legacy-box",
          type: "rectangle",
          rect: { x: 255, y: 140, width: 145, height: 90 }
        },
        {
          id: "legacy-note",
          type: "numbered-callout",
          target: { x: 280, y: 150, width: 80, height: 60 },
          text: "旧版红色批注 / legacy",
          number: 2,
          placement: "left"
        },
        {
          id: "legacy-text",
          type: "text",
          position: { x: 24, y: 250 },
          text: "重放基线"
        }
      ]
    };
    const result = await annotateImage({
      inputPath,
      outputPath,
      allowedRoots: [temporaryDirectory],
      spec
    });
    const replay = await annotateImage({
      inputPath,
      outputPath: path.join(temporaryDirectory, "v1 baseline replay.png"),
      allowedRoots: [temporaryDirectory],
      spec
    });

    expect(result.specSha256).toBe(
      "4ed8780284eb6083556c5bb4a7635f17e21b5d132ae6ffc36f8e4342e4781bd7"
    );
    expect(replay.specSha256).toBe(result.specSha256);
    expect(replay.outputSha256).toBe(result.outputSha256);
    const verifiedWindowsRenderer =
      process.platform === "win32" &&
      result.renderer.name === "sharp-svg-pango" &&
      result.renderer.version === "0.1.3" &&
      result.renderer.sharp === "0.35.4" &&
      result.renderer.libvips === "8.18.6" &&
      result.renderer.font.sha256 ===
        "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b";
    if (verifiedWindowsRenderer) {
      expect(result.outputSha256).toBe(
        "d7e8bc66e2db71bd948542e1f54bb5ddc2557fbab1cfb76aab4599b1ce9949d2"
      );
    }
    expect(result.warnings).toEqual([]);
    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
      resolvedAnnotations: { style?: Record<string, unknown> }[];
    };
    expect(sidecar.resolvedAnnotations).toEqual([
      {
        id: "legacy-box",
        rect: { height: 90, width: 145, x: 255, y: 140 },
        style: {
          arrowHeadSize: 12,
          backgroundColor: "#d92d20",
          blurSigma: 10,
          cornerRadius: 6,
          fillColor: "#00000000",
          fontSize: 24,
          lineHeight: 1.25,
          maxWidth: 360,
          opacity: 1,
          padding: 10,
          strokeColor: "#ff3b30",
          strokeWidth: 3,
          textColor: "#ffffff"
        },
        type: "rectangle"
      },
      {
        anchor: { x: 266, y: 180 },
        box: { height: 47, width: 253, x: 13, y: 157 },
        fontSize: 24,
        id: "legacy-note",
        marker: { center: { x: 320, y: 180 }, radius: 17 },
        number: 2,
        placement: "left",
        target: { height: 60, width: 80, x: 280, y: 150 },
        targetAnchor: { x: 280, y: 181 },
        text: "旧版红色批注 / legacy",
        type: "numbered-callout"
      },
      {
        box: { height: 44, width: 115, x: 24, y: 250 },
        fontSize: 24,
        id: "legacy-text",
        position: { x: 24, y: 250 },
        text: "重放基线",
        type: "text"
      }
    ]);
    const legacyStyle = sidecar.resolvedAnnotations[0]?.style ?? {};
    expect(legacyStyle).not.toHaveProperty("markerStrokeColor");
    expect(legacyStyle).not.toHaveProperty("markerFillColor");
    expect(legacyStyle).not.toHaveProperty("markerTextColor");
    expect(sidecar.resolvedAnnotations[1]).not.toHaveProperty("style");
  });

  it("keeps 1.1 point/rect targets visible across all numbered placements", async () => {
    const inputPath = path.join(temporaryDirectory, "numbered geometry source.png");
    await sharp({ create: { width: 720, height: 480, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const targets = [
      { name: "point", value: { x: 360, y: 240 } },
      { name: "rect", value: { x: 330, y: 210, width: 60, height: 60 } }
    ] as const;
    const placements = ["auto", "top", "right", "bottom", "left"] as const;

    for (const target of targets) {
      for (const placement of placements) {
        const expectedPlacement = placement === "auto" ? "top" : placement;
        const result = await annotateImage({
          inputPath,
          outputPath: path.join(temporaryDirectory, `${target.name}-${placement}.png`),
          allowedRoots: [temporaryDirectory],
          spec: {
            version: "1.1",
            defaults: { fontSize: 14, maxWidth: 120, padding: 6 },
            annotations: [
              {
                id: `${target.name}-${placement}`,
                type: "numbered-callout",
                target: target.value,
                text: "Visible leader",
                number: 3,
                placement,
                style: { strokeColor: "#0A7A42", strokeWidth: 3 }
              }
            ]
          }
        });
        const resolved = await resolvedNumberedCallout(result.sidecarPath);
        const markerDistance = Math.hypot(
          resolved.leader.start.x - resolved.marker.center.x,
          resolved.leader.start.y - resolved.marker.center.y
        );

        expect(result.warnings).toEqual([]);
        expect(resolved.label.placement).toBe(expectedPlacement);
        expect(resolved.label.box).toEqual(resolved.box);
        const paintedLabelOverlap =
          Math.max(
            0,
            Math.min(
              resolved.label.paintedBounds.x + resolved.label.paintedBounds.width,
              resolved.marker.bounds.x + resolved.marker.bounds.width
            ) - Math.max(resolved.label.paintedBounds.x, resolved.marker.bounds.x)
          ) *
          Math.max(
            0,
            Math.min(
              resolved.label.paintedBounds.y + resolved.label.paintedBounds.height,
              resolved.marker.bounds.y + resolved.marker.bounds.height
            ) - Math.max(resolved.label.paintedBounds.y, resolved.marker.bounds.y)
          );
        expect(paintedLabelOverlap).toBe(0);
        expect(resolved.leader.length).toBeGreaterThanOrEqual(24);
        expect(markerDistance).toBeCloseTo(resolved.marker.paintedRadius, 6);
        expect(
          Math.hypot(
            resolved.leader.end.x - resolved.leader.start.x,
            resolved.leader.end.y - resolved.leader.start.y
          )
        ).toBeCloseTo(resolved.leader.length, 6);
        expectPointOnTargetBoundary(resolved);
        expect(markerOverlapsTarget(resolved)).toBe(false);
        expect(resolved.box.x).toBeGreaterThanOrEqual(0);
        expect(resolved.box.y).toBeGreaterThanOrEqual(0);
        expect(resolved.box.x + resolved.box.width).toBeLessThanOrEqual(720);
        expect(resolved.box.y + resolved.box.height).toBeLessThanOrEqual(480);
        expect(resolved.marker.bounds.x).toBeGreaterThanOrEqual(0);
        expect(resolved.marker.bounds.y).toBeGreaterThanOrEqual(0);
        expect(resolved.marker.bounds.x + resolved.marker.bounds.width).toBeLessThanOrEqual(720);
        expect(resolved.marker.bounds.y + resolved.marker.bounds.height).toBeLessThanOrEqual(480);

        switch (expectedPlacement) {
          case "top":
            expect(resolved.marker.center.y).toBe(
              resolved.label.paintedBounds.y +
                resolved.label.paintedBounds.height +
                resolved.marker.paintedRadius
            );
            break;
          case "right":
            expect(resolved.marker.center.x).toBe(
              resolved.label.paintedBounds.x - resolved.marker.paintedRadius
            );
            break;
          case "bottom":
            expect(resolved.marker.center.y).toBe(
              resolved.label.paintedBounds.y - resolved.marker.paintedRadius
            );
            break;
          case "left":
            expect(resolved.marker.center.x).toBe(
              resolved.label.paintedBounds.x +
                resolved.label.paintedBounds.width +
                resolved.marker.paintedRadius
            );
            break;
        }

        const raw = await sharp(result.outputPath)
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const leaderDistance = Math.hypot(
          resolved.leader.end.x - resolved.leader.start.x,
          resolved.leader.end.y - resolved.leader.start.y
        );
        let visibleStrokeSamples = 0;
        for (let distance = 1; distance < Math.floor(leaderDistance); distance += 1) {
          const ratio = distance / leaderDistance;
          const x = Math.round(
            resolved.leader.start.x + (resolved.leader.end.x - resolved.leader.start.x) * ratio
          );
          const y = Math.round(
            resolved.leader.start.y + (resolved.leader.end.y - resolved.leader.start.y) * ratio
          );
          const offset = (y * raw.info.width + x) * raw.info.channels;
          if (
            raw.data[offset] === 10 &&
            raw.data[offset + 1] === 122 &&
            raw.data[offset + 2] === 66
          ) {
            visibleStrokeSamples += 1;
          }
        }
        expect(visibleStrokeSamples).toBeGreaterThanOrEqual(24);
      }
    }
  });

  it("resolves equivalent pixel/normalized numbered geometry and repeats each hash", async () => {
    const inputPath = path.join(temporaryDirectory, "coordinate equivalence source.png");
    await sharp({
      create: { ...NUMBERED_CALLOUT_CANVAS, channels: 3, background: "white" }
    })
      .png()
      .toFile(inputPath);
    const normalizedSpec = {
      ...NUMBERED_CALLOUT_V11_SPEC,
      coordinateSpace: "normalized",
      annotations: [
        {
          ...NUMBERED_CALLOUT_V11_SPEC.annotations[0],
          target: { x: 0.65625, y: 0.425, width: 0.125, height: 0.15 }
        }
      ]
    } as const;
    const cases: { name: string; spec: unknown }[] = [
      { name: "pixel-first", spec: NUMBERED_CALLOUT_V11_SPEC },
      { name: "pixel-second", spec: NUMBERED_CALLOUT_V11_SPEC },
      { name: "normalized-first", spec: normalizedSpec },
      { name: "normalized-second", spec: normalizedSpec }
    ];
    const runs = await Promise.all(
      cases.map(async ({ name, spec }) =>
        annotateImage({
          inputPath,
          outputPath: path.join(temporaryDirectory, `${name}.png`),
          allowedRoots: [temporaryDirectory],
          spec
        })
      )
    );
    const [pixelFirst, pixelSecond, normalizedFirst, normalizedSecond] = runs;
    if (!pixelFirst || !pixelSecond || !normalizedFirst || !normalizedSecond) {
      throw new Error("Missing coordinate-equivalence render result.");
    }
    const pixelGeometry = await resolvedNumberedCallout(pixelFirst.sidecarPath);
    const normalizedGeometry = await resolvedNumberedCallout(normalizedFirst.sidecarPath);

    expect(pixelFirst.outputSha256).toBe(pixelSecond.outputSha256);
    expect(pixelFirst.specSha256).toBe(pixelSecond.specSha256);
    expect(normalizedFirst.outputSha256).toBe(normalizedSecond.outputSha256);
    expect(normalizedFirst.specSha256).toBe(normalizedSecond.specSha256);
    expect(normalizedGeometry).toEqual(pixelGeometry);
    expect(normalizedFirst.outputSha256).toBe(pixelFirst.outputSha256);
    expect(pixelFirst.warnings).toEqual([]);
    expect(normalizedFirst.warnings).toEqual([]);
  });

  it("renders constrained repeated numbered callouts and names every degraded annotation", async () => {
    const inputPath = path.join(temporaryDirectory, "constrained numbered source.png");
    const outputPath = path.join(temporaryDirectory, "constrained numbered output.png");
    await sharp({ create: { width: 128, height: 96, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const result = await annotateImage({
      inputPath,
      outputPath,
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.1",
        defaults: { fontSize: 8, maxWidth: 48, padding: 2 },
        annotations: [
          {
            id: "tight-first",
            type: "numbered-callout",
            target: { x: 4, y: 48 },
            text: "One",
            number: 1,
            placement: "left"
          },
          {
            id: "tight-second",
            type: "numbered-callout",
            target: { x: 4, y: 48 },
            text: "Two",
            number: 2,
            placement: "left"
          }
        ]
      }
    });
    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
      resolvedAnnotations: ResolvedNumberedCallout[];
    };

    expect(await sharp(result.outputPath).metadata()).toMatchObject({
      format: "png",
      width: 128,
      height: 96
    });
    expect(result.warnings.some((warning) => warning.includes("tight-first"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("tight-second"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("visible leader"))).toBe(true);
    const occupiedWarnings = result.warnings.filter((warning) =>
      warning.includes("occupied annotation")
    );
    expect(occupiedWarnings).toHaveLength(1);
    expect(occupiedWarnings[0]).toContain("1 occupied annotation");
    expect(result.warnings.some((warning) => warning.includes("hides the leader"))).toBe(true);
    for (const resolved of sidecar.resolvedAnnotations) {
      expect(resolved.box.x).toBeGreaterThanOrEqual(0);
      expect(resolved.box.y).toBeGreaterThanOrEqual(0);
      expect(resolved.box.x + resolved.box.width).toBeLessThanOrEqual(128);
      expect(resolved.box.y + resolved.box.height).toBeLessThanOrEqual(96);
      expect(resolved.marker.bounds.x).toBeGreaterThanOrEqual(0);
      expect(resolved.marker.bounds.y).toBeGreaterThanOrEqual(0);
      expect(resolved.marker.bounds.x + resolved.marker.bounds.width).toBeLessThanOrEqual(128);
      expect(resolved.marker.bounds.y + resolved.marker.bounds.height).toBeLessThanOrEqual(96);
    }
  });

  it("warns and reports zero visible length when a valid style hides the leader", async () => {
    const inputPath = path.join(temporaryDirectory, "invisible leader source.png");
    await sharp({
      create: { ...NUMBERED_CALLOUT_CANVAS, channels: 3, background: "white" }
    })
      .png()
      .toFile(inputPath);
    const cases = [
      { name: "zero-width", style: { strokeColor: "#FF0000", strokeWidth: 0 } },
      { name: "alpha-zero", style: { strokeColor: "#FF000000", strokeWidth: 4 } },
      {
        name: "rounded-opacity-zero",
        style: { strokeColor: "#FF0000", strokeWidth: 4, opacity: 0.0004 }
      }
    ] as const;
    for (const item of cases) {
      const result = await annotateImage({
        inputPath,
        outputPath: path.join(temporaryDirectory, `invisible-${item.name}.png`),
        allowedRoots: [temporaryDirectory],
        spec: {
          ...NUMBERED_CALLOUT_V11_SPEC,
          annotations: [
            {
              ...NUMBERED_CALLOUT_V11_SPEC.annotations[0],
              id: `hidden-${item.name}`,
              style: {
                ...NUMBERED_CALLOUT_V11_SPEC.annotations[0].style,
                ...item.style,
                markerStrokeColor: "#0000FF"
              }
            }
          ]
        }
      });
      const resolved = await resolvedNumberedCallout(result.sidecarPath);
      const raw = await sharp(result.outputPath).removeAlpha().raw().toBuffer();
      let redPixels = 0;
      for (let index = 0; index < raw.length; index += 3) {
        if (raw[index] === 255 && raw[index + 1] === 0 && raw[index + 2] === 0) {
          redPixels += 1;
        }
      }

      expect(resolved.leader).not.toHaveProperty("bounds");
      expect(resolved.leader.start).toEqual(resolved.leader.end);
      expect(resolved.leader.length).toBe(0);
      expect(result.warnings.every((warning) => warning.includes(`hidden-${item.name}`))).toBe(
        true
      );
      expect(result.warnings.some((warning) => warning.includes("leader is invisible"))).toBe(true);
      expect(result.warnings.some((warning) => warning.includes("0px of visible leader"))).toBe(
        true
      );
      expect(redPixels).toBe(0);
    }
  });

  it("degrades a high-stroke numbered marker on a small canvas instead of throwing", async () => {
    const inputPath = path.join(temporaryDirectory, "small high-stroke source.png");
    await sharp({ create: { width: 60, height: 60, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const result = await annotateImage({
      inputPath,
      outputPath: path.join(temporaryDirectory, "small high-stroke.png"),
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.1",
        defaults: { fontSize: 6, padding: 0, maxWidth: 48 },
        annotations: [
          {
            id: "small-high-stroke",
            type: "numbered-callout",
            target: { x: 30, y: 30 },
            text: "1",
            number: 1,
            placement: "auto",
            style: { strokeWidth: 64 }
          }
        ]
      }
    });
    const resolved = await resolvedNumberedCallout(result.sidecarPath);

    expect(await sharp(result.outputPath).metadata()).toMatchObject({
      format: "png",
      width: 60,
      height: 60
    });
    expect(result.warnings.every((warning) => warning.includes("small-high-stroke"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("marker stroke width"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("leader stroke width"))).toBe(true);
    expect(resolved.marker.radius).toBeGreaterThanOrEqual(6);
    expect(markerOverlapsTarget(resolved)).toBe(false);
    expect(resolved.label.paintedBounds.x).toBeGreaterThanOrEqual(0);
    expect(resolved.label.paintedBounds.y).toBeGreaterThanOrEqual(0);
    expect(resolved.label.paintedBounds.x + resolved.label.paintedBounds.width).toBeLessThanOrEqual(
      60
    );
    expect(
      resolved.label.paintedBounds.y + resolved.label.paintedBounds.height
    ).toBeLessThanOrEqual(60);
    expect(resolved.marker.bounds.x).toBeGreaterThanOrEqual(0);
    expect(resolved.marker.bounds.y).toBeGreaterThanOrEqual(0);
    expect(resolved.marker.bounds.x + resolved.marker.bounds.width).toBeLessThanOrEqual(60);
    expect(resolved.marker.bounds.y + resolved.marker.bounds.height).toBeLessThanOrEqual(60);
  });

  it("reduces a 24x24 marker and keeps the fitted painted geometry decodable", async () => {
    const inputPath = path.join(temporaryDirectory, "tiny numbered source.png");
    await sharp({ create: { width: 24, height: 24, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const result = await annotateImage({
      inputPath,
      outputPath: path.join(temporaryDirectory, "tiny numbered.png"),
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.1",
        defaults: { fontSize: 64, padding: 0, maxWidth: 48 },
        annotations: [
          {
            id: "tiny-radius",
            type: "numbered-callout",
            target: { x: 12, y: 12 },
            text: "1",
            number: 1,
            placement: "auto",
            style: { strokeWidth: 2 }
          }
        ]
      }
    });
    const resolved = await resolvedNumberedCallout(result.sidecarPath);

    expect(await sharp(result.outputPath).metadata()).toMatchObject({
      format: "png",
      width: 24,
      height: 24
    });
    expect(result.warnings.every((warning) => warning.includes("tiny-radius"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("marker radius was reduced"))).toBe(
      true
    );
    expect(resolved.marker.bounds.x).toBeGreaterThanOrEqual(0);
    expect(resolved.marker.bounds.y).toBeGreaterThanOrEqual(0);
    expect(resolved.marker.bounds.x + resolved.marker.bounds.width).toBeLessThanOrEqual(24);
    expect(resolved.marker.bounds.y + resolved.marker.bounds.height).toBeLessThanOrEqual(24);
    expect(markerOverlapsTarget(resolved)).toBe(false);
  });

  it("does not let a transparent marker stroke enlarge its painted radius or gap", async () => {
    const inputPath = path.join(temporaryDirectory, "marker alpha source.png");
    await sharp({
      create: { ...NUMBERED_CALLOUT_CANVAS, channels: 3, background: "white" }
    })
      .png()
      .toFile(inputPath);
    const renders = await Promise.all(
      [
        { name: "visible", markerStrokeColor: "#5B21B6" },
        { name: "transparent", markerStrokeColor: "#5B21B600" }
      ].map(async (item) => {
        const result = await annotateImage({
          inputPath,
          outputPath: path.join(temporaryDirectory, `marker-${item.name}.png`),
          allowedRoots: [temporaryDirectory],
          spec: {
            ...NUMBERED_CALLOUT_V11_SPEC,
            annotations: [
              {
                ...NUMBERED_CALLOUT_V11_SPEC.annotations[0],
                style: {
                  ...NUMBERED_CALLOUT_V11_SPEC.annotations[0].style,
                  strokeWidth: 8,
                  markerStrokeColor: item.markerStrokeColor
                }
              }
            ]
          }
        });
        return { geometry: await resolvedNumberedCallout(result.sidecarPath), result };
      })
    );
    const [visible, transparent] = renders;
    if (!visible || !transparent) throw new Error("Missing marker-alpha render.");

    expect(transparent.geometry.marker.paintedRadius).toBe(transparent.geometry.marker.radius);
    expect(visible.geometry.marker.paintedRadius).toBeGreaterThan(visible.geometry.marker.radius);
    expect(transparent.geometry.marker.paintedRadius).toBeLessThan(
      visible.geometry.marker.paintedRadius
    );
    expect(transparent.geometry.leader.length).toBeGreaterThanOrEqual(24);
    expect(transparent.result.warnings).toEqual([]);
  });

  it("relocates the final marker face after clamping instead of overlapping its label", async () => {
    const inputPath = path.join(temporaryDirectory, "face relocation source.png");
    await sharp({ create: { width: 200, height: 120, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const result = await annotateImage({
      inputPath,
      outputPath: path.join(temporaryDirectory, "face relocation.png"),
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.1",
        defaults: { fontSize: 10, padding: 2, maxWidth: 80 },
        annotations: [
          {
            id: "face-relocation",
            type: "numbered-callout",
            target: { x: 100, y: 0 },
            text: "Edge",
            number: 1,
            placement: "top"
          }
        ]
      }
    });
    const resolved = await resolvedNumberedCallout(result.sidecarPath);

    expect(
      circleOverlapsTarget(
        { center: resolved.marker.center, radius: resolved.marker.paintedRadius },
        resolved.label.paintedBounds
      )
    ).toBe(false);
    expect(resolved.marker.labelSide).not.toBe("bottom");
    expect(result.warnings.some((warning) => warning.includes("face-relocation"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("marker moved"))).toBe(true);
  });

  it("moves an auto callout to a collision-free final candidate", async () => {
    const inputPath = path.join(temporaryDirectory, "final candidate source.png");
    await sharp({ create: { width: 480, height: 320, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const result = await annotateImage({
      inputPath,
      outputPath: path.join(temporaryDirectory, "final candidates.png"),
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.1",
        defaults: { fontSize: 12, padding: 4, maxWidth: 100 },
        annotations: [
          {
            id: "candidate-first",
            type: "numbered-callout",
            target: { x: 240, y: 160 },
            text: "First",
            number: 1,
            placement: "auto"
          },
          {
            id: "candidate-second",
            type: "numbered-callout",
            target: { x: 240, y: 160 },
            text: "Second",
            number: 2,
            placement: "auto"
          }
        ]
      }
    });
    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
      resolvedAnnotations: ResolvedNumberedCallout[];
    };

    expect(sidecar.resolvedAnnotations[0]?.label.placement).toBe("top");
    expect(sidecar.resolvedAnnotations[1]?.label.placement).not.toBe("top");
    expect(result.warnings.some((warning) => warning.includes("occupied annotation"))).toBe(false);
  });

  it("normalizes overlapping leader geometry and does not paint a round-cap point", async () => {
    const inputPath = path.join(temporaryDirectory, "overlap source.png");
    await sharp({ create: { width: 200, height: 120, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const result = await annotateImage({
      inputPath,
      outputPath: path.join(temporaryDirectory, "overlap.png"),
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.1",
        defaults: { fontSize: 10, padding: 2, maxWidth: 80 },
        annotations: [
          {
            id: "contained-target",
            type: "numbered-callout",
            target: { x: 0, y: 0, width: 200, height: 120 },
            text: "Contained",
            number: 1,
            placement: "auto",
            style: {
              strokeColor: "#FF0000",
              markerStrokeColor: "#0000FF",
              markerFillColor: "#0000FF"
            }
          }
        ]
      }
    });
    const resolved = await resolvedNumberedCallout(result.sidecarPath);
    const raw = await sharp(result.outputPath)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let redOutsideOwnedGeometry = 0;
    for (let y = 0; y < raw.info.height; y += 1) {
      for (let x = 0; x < raw.info.width; x += 1) {
        const inLabel =
          x >= resolved.label.paintedBounds.x &&
          x <= resolved.label.paintedBounds.x + resolved.label.paintedBounds.width &&
          y >= resolved.label.paintedBounds.y &&
          y <= resolved.label.paintedBounds.y + resolved.label.paintedBounds.height;
        const inMarker =
          x >= resolved.marker.bounds.x &&
          x <= resolved.marker.bounds.x + resolved.marker.bounds.width &&
          y >= resolved.marker.bounds.y &&
          y <= resolved.marker.bounds.y + resolved.marker.bounds.height;
        const offset = (y * raw.info.width + x) * raw.info.channels;
        if (
          !inLabel &&
          !inMarker &&
          raw.data[offset] === 255 &&
          raw.data[offset + 1] === 0 &&
          raw.data[offset + 2] === 0
        ) {
          redOutsideOwnedGeometry += 1;
        }
      }
    }

    expect(resolved.leader).not.toHaveProperty("bounds");
    expect(resolved.leader.start).toEqual(resolved.leader.end);
    expect(resolved.leader.length).toBe(0);
    expect(redOutsideOwnedGeometry).toBe(0);
  });

  it("warns when an exact-edge painted leader is unavoidably clipped", async () => {
    const inputPath = path.join(temporaryDirectory, "edge leader source.png");
    await sharp({ create: { width: 200, height: 100, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const result = await annotateImage({
      inputPath,
      outputPath: path.join(temporaryDirectory, "edge leader.png"),
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.1",
        defaults: { fontSize: 10, padding: 2, maxWidth: 80 },
        annotations: [
          {
            id: "edge-leader",
            type: "numbered-callout",
            target: { x: 0, y: 50 },
            text: "Edge",
            number: 1,
            placement: "right",
            style: { strokeWidth: 3 }
          }
        ]
      }
    });
    const resolved = await resolvedNumberedCallout(result.sidecarPath);

    expect(resolved.leader.bounds?.x).toBeLessThan(0);
    expect(result.warnings.some((warning) => warning.includes("edge-leader"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("painted leader was clipped"))).toBe(
      true
    );
    expect(
      result.warnings.some((warning) => warning.includes("facing decoration footprint overflowed"))
    ).toBe(true);
  });

  it("renders a minimal 1.1 numbered callout with a light label and blue border/marker", async () => {
    const inputPath = path.join(temporaryDirectory, "minimal v11 source.png");
    const outputPath = path.join(temporaryDirectory, "minimal v11 output.png");
    await sharp({ create: { width: 640, height: 400, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const result = await annotateImage({
      inputPath,
      outputPath,
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.1",
        annotations: [
          {
            type: "numbered-callout",
            target: { x: 410, y: 175, width: 110, height: 70 },
            text: "普通说明",
            number: 1,
            placement: "left"
          }
        ]
      }
    });
    const raw = await sharp(result.outputPath)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
      resolvedAnnotations: {
        marker: { center: { x: number; y: number }; radius: number };
      }[];
    };
    const marker = sidecar.resolvedAnnotations[0]?.marker;
    expect(marker).toBeDefined();
    if (marker === undefined) throw new Error("Missing resolved marker.");
    const colors = new Map<string, number>();
    let markerBluePixels = 0;
    for (let index = 0; index < raw.data.length; index += raw.info.channels) {
      const color = `${raw.data[index]},${raw.data[index + 1]},${raw.data[index + 2]}`;
      colors.set(color, (colors.get(color) ?? 0) + 1);
      const pixelIndex = index / raw.info.channels;
      const x = pixelIndex % raw.info.width;
      const y = Math.floor(pixelIndex / raw.info.width);
      if (
        x >= marker.center.x - marker.radius &&
        x < marker.center.x + marker.radius &&
        y >= marker.center.y - marker.radius &&
        y < marker.center.y + marker.radius &&
        color === "37,99,235"
      ) {
        markerBluePixels += 1;
      }
    }

    expect(result.warnings).toEqual([]);
    expect(colors.get("239,246,255") ?? 0).toBeGreaterThan(300);
    expect(colors.get("15,23,42") ?? 0).toBeGreaterThan(10);
    expect(colors.get("37,99,235") ?? 0).toBeGreaterThan(300);
    expect(markerBluePixels).toBeGreaterThan(200);
  });

  it("renders readable 1.1 labels, independent markers, bounded Chinese text, and repeatable PNGs", async () => {
    const inputPath = path.join(temporaryDirectory, "v11 source.png");
    const firstPath = path.join(temporaryDirectory, "v11 first.png");
    const secondPath = path.join(temporaryDirectory, "v11 second.png");
    await sharp({ create: { width: 720, height: 440, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const spec = {
      version: "1.1",
      defaults: { fontSize: 22, maxWidth: 168 },
      annotations: [
        {
          id: "readable-note",
          type: "numbered-callout",
          target: { x: 420, y: 190, width: 100, height: 70 },
          text: "这是一段用于验证最大宽度与中文自动换行的普通说明",
          number: 4,
          placement: "left",
          style: {
            markerStrokeColor: "#6D28D9",
            markerFillColor: "#7C3AED",
            markerTextColor: "#00E5FF"
          }
        }
      ]
    };
    const first = await annotateImage({
      inputPath,
      outputPath: firstPath,
      spec,
      allowedRoots: [temporaryDirectory]
    });
    const second = await annotateImage({
      inputPath,
      outputPath: secondPath,
      spec,
      allowedRoots: [temporaryDirectory]
    });
    const sidecar = JSON.parse(await readFile(first.sidecarPath, "utf8")) as {
      resolvedAnnotations: {
        box: { x: number; y: number; width: number; height: number };
        marker: { center: { x: number; y: number }; radius: number };
        style: Record<string, unknown>;
      }[];
    };
    const resolved = sidecar.resolvedAnnotations[0];
    expect(resolved).toBeDefined();
    if (resolved === undefined) throw new Error("Missing resolved numbered callout.");

    expect(first.outputSha256).toBe(second.outputSha256);
    expect(first.specSha256).toBe(second.specSha256);
    expect(first.warnings).toEqual([]);
    expect(resolved.box.width).toBeLessThanOrEqual(168 + 24);
    expect(resolved.box.x).toBeGreaterThanOrEqual(0);
    expect(resolved.box.x + resolved.box.width).toBeLessThanOrEqual(720);
    expect(resolved.box.y).toBeGreaterThanOrEqual(0);
    expect(resolved.box.y + resolved.box.height).toBeLessThanOrEqual(440);
    expect(resolved.style).toMatchObject({
      textColor: "#0f172a",
      markerStrokeColor: "#6d28d9",
      markerFillColor: "#7c3aed",
      markerTextColor: "#00e5ff",
      maxWidth: 168
    });

    const raw = await sharp(first.outputPath)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const colors = new Map<string, number>();
    let markerGlyphPixels = 0;
    for (let index = 0; index < raw.data.length; index += raw.info.channels) {
      const color = `${raw.data[index]},${raw.data[index + 1]},${raw.data[index + 2]}`;
      colors.set(color, (colors.get(color) ?? 0) + 1);
      const pixelIndex = index / raw.info.channels;
      const x = pixelIndex % raw.info.width;
      const y = Math.floor(pixelIndex / raw.info.width);
      const distance = Math.hypot(x - resolved.marker.center.x, y - resolved.marker.center.y);
      if (distance <= resolved.marker.radius - 2 && color === "0,229,255") {
        markerGlyphPixels += 1;
      }
    }
    expect(colors.get("239,246,255") ?? 0).toBeGreaterThan(500);
    expect(colors.get("15,23,42") ?? 0).toBeGreaterThan(10);
    expect(colors.get("124,58,237") ?? 0).toBeGreaterThan(200);
    expect(colors.get("109,40,217") ?? 0).toBeGreaterThan(20);
    expect(markerGlyphPixels).toBeGreaterThan(5);
  });

  it("renders non-default presets and tones with their resolved callout styles", async () => {
    const inputPath = path.join(temporaryDirectory, "palette source.png");
    await sharp({ create: { width: 520, height: 280, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const cases = [
      {
        name: "docs-dark",
        preset: "docs-dark",
        expectedText: "#f8fafc",
        expectedBackground: "#1e293b"
      },
      {
        name: "high-contrast",
        preset: "high-contrast",
        expectedText: "#ffffff",
        expectedBackground: "#000000"
      },
      {
        name: "success",
        preset: "docs-light",
        tone: "success",
        expectedText: "#14532d",
        expectedBackground: "#f0fdf4"
      },
      {
        name: "warning",
        preset: "docs-light",
        tone: "warning",
        expectedText: "#78350f",
        expectedBackground: "#fffbeb"
      }
    ];

    for (const item of cases) {
      const result = await annotateImage({
        inputPath,
        outputPath: path.join(temporaryDirectory, `palette-${item.name}.png`),
        allowedRoots: [temporaryDirectory],
        spec: {
          version: "1.1",
          preset: item.preset,
          annotations: [
            {
              type: "callout",
              target: { x: 380, y: 105, width: 80, height: 55 },
              text: `Palette ${item.name}`,
              placement: "left",
              ...(item.tone === undefined ? {} : { tone: item.tone })
            }
          ]
        }
      });
      const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
        resolvedAnnotations: {
          box: { x: number; y: number; width: number; height: number };
          style: { textColor: string; backgroundColor: string };
        }[];
      };
      const resolved = sidecar.resolvedAnnotations[0];
      expect(resolved).toBeDefined();
      if (resolved === undefined) throw new Error(`Missing ${item.name} callout.`);
      expect(resolved.style).toMatchObject({
        textColor: item.expectedText,
        backgroundColor: item.expectedBackground
      });
      expect(result.warnings).toEqual([]);

      const raw = await sharp(result.outputPath)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const expectedText = item.expectedText
        .slice(1)
        .match(/.{2}/gu)
        ?.map((part) => Number.parseInt(part, 16));
      const expectedBackground = item.expectedBackground
        .slice(1)
        .match(/.{2}/gu)
        ?.map((part) => Number.parseInt(part, 16));
      let textPixels = 0;
      let backgroundPixels = 0;
      for (let y = resolved.box.y + 3; y < resolved.box.y + resolved.box.height - 3; y += 1) {
        for (let x = resolved.box.x + 3; x < resolved.box.x + resolved.box.width - 3; x += 1) {
          const offset = (y * raw.info.width + x) * raw.info.channels;
          const pixel = [raw.data[offset], raw.data[offset + 1], raw.data[offset + 2]];
          if (pixel.every((value, index) => value === expectedText?.[index])) textPixels += 1;
          if (pixel.every((value, index) => value === expectedBackground?.[index])) {
            backgroundPixels += 1;
          }
        }
      }
      expect(textPixels).toBeGreaterThan(5);
      expect(backgroundPixels).toBeGreaterThan(100);
    }
  });

  it("bounds 1.1 standalone text and plain callouts at min/max maxWidth", async () => {
    const inputPath = path.join(temporaryDirectory, "width source.png");
    await sharp({ create: { width: 620, height: 360, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const cases = [
      {
        name: "text-chinese-min",
        maxWidth: 48,
        padding: 4,
        annotation: {
          type: "text",
          position: { x: 12, y: 12 },
          text: "中文最小宽度换行验证中文最小宽度换行验证"
        }
      },
      {
        name: "text-unbreakable",
        maxWidth: 96,
        padding: 4,
        annotation: {
          type: "text",
          position: { x: 12, y: 12 },
          text: "UnbreakableTokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        }
      },
      {
        name: "callout-chinese-min",
        maxWidth: 48,
        padding: 4,
        annotation: {
          type: "callout",
          target: { x: 500, y: 130, width: 70, height: 50 },
          text: "中文说明自动换行中文说明自动换行",
          placement: "left"
        }
      },
      {
        name: "callout-unbreakable-max",
        maxWidth: 4_096,
        padding: 4,
        annotation: {
          type: "callout",
          target: { x: 500, y: 130, width: 70, height: 50 },
          text: "UnbreakableTokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
          placement: "left"
        }
      }
    ];

    for (const item of cases) {
      const result = await annotateImage({
        inputPath,
        outputPath: path.join(temporaryDirectory, `${item.name}.png`),
        allowedRoots: [temporaryDirectory],
        spec: {
          version: "1.1",
          annotations: [
            {
              ...item.annotation,
              style: { maxWidth: item.maxWidth, padding: item.padding }
            }
          ]
        }
      });
      const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
        resolvedAnnotations: {
          box: { x: number; y: number; width: number; height: number };
          style?: { maxWidth: number };
        }[];
      };
      const resolved = sidecar.resolvedAnnotations[0];
      expect(resolved).toBeDefined();
      if (resolved === undefined) throw new Error(`Missing ${item.name}.`);
      expect(resolved.box.width).toBeLessThanOrEqual(
        Math.min(item.maxWidth + item.padding * 2, 612)
      );
      expect(resolved.box.x).toBeGreaterThanOrEqual(0);
      expect(resolved.box.x + resolved.box.width).toBeLessThanOrEqual(620);
      expect(resolved.box.y).toBeGreaterThanOrEqual(0);
      expect(resolved.box.y + resolved.box.height).toBeLessThanOrEqual(360);
      if (item.annotation.type === "callout") {
        expect(resolved.style?.maxWidth).toBe(item.maxWidth);
      }
    }
  });

  it("fails rather than returning a glyph wider than the effective small-canvas width", async () => {
    const inputPath = path.join(temporaryDirectory, "small width source.png");
    const outputPath = path.join(temporaryDirectory, "small width output.png");
    await sharp({ create: { width: 48, height: 48, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);

    await expect(
      annotateImage({
        inputPath,
        outputPath,
        allowedRoots: [temporaryDirectory],
        spec: {
          version: "1.1",
          annotations: [
            {
              type: "text",
              position: { x: 47, y: 0 },
              text: "W",
              style: { maxWidth: 48, padding: 0, fontSize: 22 }
            }
          ]
        }
      })
    ).rejects.toThrow(/cannot fit within 1x48 pixels/u);
    await expect(access(outputPath)).rejects.toThrow();
  });

  it("does not write output when a 1.1 version, tone, maxWidth, color, or field is invalid", async () => {
    const inputPath = path.join(temporaryDirectory, "invalid source.png");
    await sharp({ create: { width: 80, height: 60, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const invalidSpecs = [
      { version: "1.2", annotations: [] },
      {
        version: "1.1",
        annotations: [{ type: "callout", target: { x: 10, y: 10 }, text: "bad", tone: "urgent" }]
      },
      {
        version: "1.1",
        annotations: [
          {
            type: "callout",
            target: { x: 10, y: 10 },
            text: "bad",
            style: { maxWidth: 12 }
          }
        ]
      },
      { version: "1.1", defaults: { markerFillColor: "red" }, annotations: [] },
      { version: "1.1", annotations: [], unexpected: true }
    ];

    for (const [index, spec] of invalidSpecs.entries()) {
      const outputPath = path.join(temporaryDirectory, `invalid-${index}.png`);
      await expect(
        annotateImage({ inputPath, outputPath, spec, allowedRoots: [temporaryDirectory] })
      ).rejects.toThrow();
      await expect(access(outputPath)).rejects.toThrow();
      await expect(access(outputPath.replace(/\.png$/u, ".json"))).rejects.toThrow();
    }
  });

  it("dims only outside the spotlight instead of making it opaque black", async () => {
    const inputPath = path.join(temporaryDirectory, "solid.png");
    const outputPath = path.join(temporaryDirectory, "spotlight.png");
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 200, g: 160, b: 120 } }
    })
      .png()
      .toFile(inputPath);
    await annotateImage({
      inputPath,
      outputPath,
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.0",
        annotations: [{ type: "spotlight", rect: { x: 30, y: 30, width: 40, height: 40 } }]
      }
    });

    const inside = await rgbAt(outputPath, 50, 50);
    const outside = await rgbAt(outputPath, 10, 10);
    expect(inside).toEqual([200, 160, 120]);
    expect(outside[0]).toBeGreaterThan(20);
    expect(outside[0]).toBeLessThan(120);
    expect(outside[1]).toBeLessThan(inside[1]);
    expect(outside[2]).toBeLessThan(inside[2]);
  });

  it("uses Gaussian blur and replaces redact pixels with one opaque color", async () => {
    const inputPath = path.join(temporaryDirectory, "privacy source.png");
    const outputPath = path.join(temporaryDirectory, "privacy output.png");
    await writePattern(inputPath, 120, 80);
    const result = await annotateImage({
      inputPath,
      outputPath,
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.0",
        annotations: [
          { type: "blur", rect: { x: 8, y: 8, width: 42, height: 42 }, sigma: 4 },
          { type: "redact", rect: { x: 70, y: 10, width: 30, height: 30 }, color: "#112233" }
        ]
      }
    });
    const original = await sharp(inputPath)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rendered = await sharp(outputPath)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const redacted = new Set<string>();
    let changedBlurPixels = 0;
    const blurredValues = new Set<string>();
    for (let y = 0; y < 80; y += 1) {
      for (let x = 0; x < 120; x += 1) {
        const offset = (y * 120 + x) * 3;
        const value = `${rendered.data[offset]},${rendered.data[offset + 1]},${rendered.data[offset + 2]}`;
        if (x >= 70 && x < 100 && y >= 10 && y < 40) redacted.add(value);
        if (x >= 8 && x < 50 && y >= 8 && y < 50) {
          blurredValues.add(value);
          if (
            rendered.data[offset] !== original.data[offset] ||
            rendered.data[offset + 1] !== original.data[offset + 1] ||
            rendered.data[offset + 2] !== original.data[offset + 2]
          ) {
            changedBlurPixels += 1;
          }
        }
      }
    }

    expect(result.usesBlur).toBe(true);
    expect(result.usesRedact).toBe(true);
    expect([...redacted]).toEqual(["17,34,51"]);
    expect(changedBlurPixels).toBeGreaterThan(500);
    expect(blurredValues.size).toBeGreaterThan(8);
  });

  it("is deterministic on the same platform and protects existing outputs", async () => {
    const inputPath = path.join(temporaryDirectory, "deterministic.png");
    const firstPath = path.join(temporaryDirectory, "first.png");
    const secondPath = path.join(temporaryDirectory, "second.png");
    await writePattern(inputPath, 280, 180);
    const spec = {
      version: "1.0",
      coordinateSpace: "normalized",
      annotations: [
        {
          id: "box",
          type: "rectangle",
          rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.3 }
        },
        {
          id: "safe-text",
          type: "text",
          position: { x: 0.05, y: 0.55 },
          text: '<span foreground="#00FF00">literal, not markup</span> & 中文'
        }
      ]
    };
    const first = await annotateImage({
      inputPath,
      outputPath: firstPath,
      spec,
      allowedRoots: [temporaryDirectory]
    });
    const validation = await validateSpecForImage({
      inputPath,
      spec,
      allowedRoots: [temporaryDirectory]
    });
    const firstSidecar = await readFile(first.sidecarPath);
    const second = await annotateImage({
      inputPath,
      outputPath: secondPath,
      spec,
      allowedRoots: [temporaryDirectory]
    });

    expect(first.outputSha256).toBe(second.outputSha256);
    expect(first.specSha256).toBe(second.specSha256);
    expect(first.specSha256).toBe(validation.specSha256);
    await expect(
      annotateImage({
        inputPath,
        outputPath: firstPath,
        spec,
        allowedRoots: [temporaryDirectory]
      })
    ).rejects.toThrow(/already exists/u);
    const overwritten = await annotateImage({
      inputPath,
      outputPath: firstPath,
      spec,
      overwrite: true,
      allowedRoots: [temporaryDirectory]
    });
    expect(overwritten.outputSha256).toBe(first.outputSha256);
    expect(await readFile(overwritten.sidecarPath)).toEqual(firstSidecar);
    expect((await sharp(overwritten.outputPath).metadata()).format).toBe("png");
    await expect(
      annotateImage({
        inputPath,
        outputPath: inputPath,
        spec,
        overwrite: true,
        allowedRoots: [temporaryDirectory]
      })
    ).rejects.toThrow(/must not overwrite|alias any input/u);
  });

  it("fails clearly instead of clipping text that cannot fit", async () => {
    const inputPath = path.join(temporaryDirectory, "tiny.png");
    await sharp({ create: { width: 64, height: 32, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    await expect(
      annotateImage({
        inputPath,
        outputPath: path.join(temporaryDirectory, "tiny output.png"),
        allowedRoots: [temporaryDirectory],
        spec: {
          version: "1.0",
          annotations: [
            {
              type: "text",
              position: { x: 1, y: 1 },
              text: "无法容纳的中英文内容 ".repeat(200),
              style: { fontSize: 64 }
            }
          ]
        }
      })
    ).rejects.toThrow(/minimum supported font size \(6px\)/u);
  });
});
