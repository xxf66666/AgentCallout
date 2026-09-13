import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  installBrowserRuntime,
  inspectBrowserRuntime,
  locateDom
} from "../src/locator/dom/index.js";

// The committed fixture pages replace machine-local fixtures: they travel
// with the repo and resolve through file:// URLs from this test file.
function fixtureUrl(name: string): string {
  return new URL(`./fixtures/dom/${name}`, import.meta.url).href;
}

// One real runtime install per file run, kept inside a suite-local temp
// directory so no machine state outside the test can influence it.
const suiteRoot = await realpath(await mkdtemp(join(tmpdir(), "agent-callout-dom-suite-")));
const runtimeDirectory = join(suiteRoot, "runtime");
let runtimeReady = false;
let runtimeIssues: string[] = [];
try {
  await installBrowserRuntime({ runtimeDirectory });
  const status = await inspectBrowserRuntime({ runtimeDirectory });
  runtimeReady = status.ready;
  runtimeIssues = status.issues;
} catch (error) {
  runtimeIssues = [String(error)];
}

describe("AgentCallout browser DOM locator", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "agent-callout-dom-测试-")));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("status reports not-installed without implicit installation", async () => {
    const runtime = join(directory, "not-installed-browser");
    const status = await inspectBrowserRuntime({ runtimeDirectory: runtime });
    expect(status.status).toBe("not-installed");
    expect(status.ready).toBe(false);
    expect(status.issues.join(" ")).toContain("browser install");
    expect(existsSync(join(runtime, "node_modules"))).toBe(false);
  });

  test("locate fails cleanly and never launches without an installed runtime", async () => {
    const runtime = join(directory, "not-installed-browser");
    await expect(
      locateDom({
        url: "file:///dev/null",
        locator: { kind: "text", value: "保存" },
        screenshotPath: join(directory, "shot.png"),
        runtimeDirectory: runtime
      })
    ).rejects.toThrow(/DOM_RUNTIME_NOT_READY/u);
    expect(existsSync(join(runtime, "node_modules"))).toBe(false);
  });

  test(
    "locates selector, text and accessible candidates on committed fixtures",
    { timeout: 240_000 },
    async (ctx) => {
      if (!runtimeReady) {
        // Visible skip with the exact runtime reason (usually a missing
        // Chrome on the runner, or a network-less install failure).
        ctx.skip(true, runtimeIssues.join(" ") || "browser runtime not ready");
        return;
      }
      const byText = await locateDom({
        url: fixtureUrl("outer.html"),
        locator: { kind: "text", value: "保存 Save", exact: true },
        screenshotPath: join(directory, "验收页面.png"),
        runtimeDirectory
      });
      expect(byText.candidates).toHaveLength(1);
      expect(byText.candidates[0]?.rect).toEqual({ x: 40, y: 120, width: 120, height: 40 });
      expect(byText.candidates[0]?.tag).toBe("button");
      expect(byText.page.title).toContain("DOM fixture outer");
      expect(byText.screenshot.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(byText.screenshot.sizeBytes).toBeGreaterThan(0);
      expect(existsSync(byText.screenshot.path)).toBe(true);

      const bySelector = await locateDom({
        url: fixtureUrl("outer.html"),
        locator: { kind: "selector", value: "#save" },
        screenshotPath: join(directory, "验收页面-selector.png"),
        runtimeDirectory
      });
      expect(bySelector.candidates[0]?.rect).toEqual({ x: 40, y: 120, width: 120, height: 40 });

      const byAccessible = await locateDom({
        url: fixtureUrl("outer.html"),
        locator: { kind: "accessible", value: "保存 Save", exact: true },
        screenshotPath: join(directory, "验收页面-accessible.png"),
        runtimeDirectory
      });
      expect(byAccessible.candidates[0]?.rect).toEqual({ x: 40, y: 120, width: 120, height: 40 });
      expect(byAccessible.candidates[0]?.role).toBe("button");
    }
  );

  test(
    "locates iframe content in top-level page coordinates",
    { timeout: 240_000 },
    async (ctx) => {
      if (!runtimeReady) {
        ctx.skip(true, runtimeIssues.join(" ") || "browser runtime not ready");
        return;
      }
      const inner = await locateDom({
        url: fixtureUrl("outer.html"),
        locator: { kind: "text", value: "内框按钮", exact: true },
        screenshotPath: join(directory, "验收页面-inner.png"),
        runtimeDirectory
      });
      expect(inner.candidates).toHaveLength(1);
      const innerRect = inner.candidates[0]?.rect;
      expect(innerRect?.x).toBeGreaterThanOrEqual(39);
      expect(innerRect?.x).toBeLessThanOrEqual(43);
      expect(innerRect?.y).toBeGreaterThanOrEqual(499);
      expect(innerRect?.y).toBeLessThanOrEqual(503);
      expect(inner.candidates[0]?.framePath.length).toBeGreaterThan(0);
    }
  );

  test(
    "re-installs idempotently inside the requested directory",
    { timeout: 240_000 },
    async () => {
      if (!runtimeReady) return; // nothing to re-install; the install itself failed
      await installBrowserRuntime({ runtimeDirectory });
      const status = await inspectBrowserRuntime({ runtimeDirectory });
      expect(status.playwrightVersion).toMatch(/^\d+\./);
      const entries = (await readdir(runtimeDirectory)).sort();
      expect(entries).toEqual(
        expect.arrayContaining(["package.json", "package-lock.json", "locate-worker.mjs"])
      );
    }
  );
});
