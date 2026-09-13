import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { inspectBrowserRuntime, locateDom } from "../src/locator/dom/index.js";

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

  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const chromeInstalled = existsSync(chromePath);
  const installedRuntime = "/tmp/dom-rt";

  test.skipIf(!chromeInstalled || !existsSync(join(installedRuntime, "node_modules")))(
    "locates text and accessible-name candidates with screenshot-bound evidence",
    async () => {
      const result = await locateDom({
        url: "file:///private/tmp/dom-fixture.html",
        locator: { kind: "accessible", value: "保存 Save", exact: true },
        screenshotPath: join(directory, "验收页面.png")
      });
      expect(result.ok).toBe(true);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.rect).toEqual({ x: 40, y: 120, width: 120, height: 40 });
      expect(result.screenshot.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.page.title).toContain("验收页面");
    }
  );
});
