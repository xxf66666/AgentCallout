// Browser DOM locate worker. Runs as a subprocess:
//   node locate-worker.mjs --request <request.json>
// Request: { url, locator: { kind, value, exact?, role? }, screenshotPath,
//            viewport?, timeoutMs?, maxCandidates?, executablePath? }
// Result:  { ok, candidates: [{rect, framePath, tag, role, name, text}],
//            totalCandidates, truncated, page, screenshot: { path, sha256 } }
// Any failure produces { ok: false, code, message } on stdout.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

function normalizeText(value) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function collapseCjkSpaces(value) {
  return value.replace(/([㐀-䶿一-鿿぀-ヿ가-힯])\s+([㐀-䶿一-鿿぀-ヿ가-힯])/gu, "$1$2");
}

// Evaluated inside the page; returns plain serializable data.
const COLLECT_SCRIPT = `
  (config) => {
    const collapse = (value) => value.replace(
      /([\\u3400-\\u4DBF\\u4E00-\\u9FFF\\u3040-\\u30FF\\uAC00-\\uD7AF])\\s+([\\u3400-\\u4DBF\\u4E00-\\u9FFF\\u3040-\\u30FF\\uAC00-\\uD7AF])/gu,
      "$1$2"
    );
    const normalize = (value) =>
      value === null || value === undefined
        ? ""
        : collapse(String(value).normalize("NFKC").replace(/\\s+/gu, " ")).trim();
    const matches = (value) => {
      const normalized = normalize(value);
      if (normalized === "") return false;
      return config.exact ? normalized === config.query : normalized.includes(config.query);
    };
    const implicitRole = (element) => {
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "img") return "img";
      if (["h1","h2","h3","h4","h5","h6"].includes(tag)) return "heading";
      if (tag === "input") {
        const type = (element.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (["submit","button","reset"].includes(type)) return "button";
        return "textbox";
      }
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (tag === "label") return "label";
      if (tag === "nav") return "navigation";
      if (tag === "main") return "main";
      if (tag === "header") return "banner";
      if (tag === "footer") return "contentinfo";
      return null;
    };
    const accessibleName = (element) =>
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      (element.tagName.toLowerCase() === "img" ? element.getAttribute("alt") : null) ||
      (element.labels && element.labels[0] ? element.labels[0].textContent : null) ||
      element.textContent;
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const out = [];
    if (config.kind === "selector") {
      for (const element of document.querySelectorAll(config.query)) {
        if (!visible(element)) continue;
        const rect = element.getBoundingClientRect();
        out.push({
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || implicitRole(element),
          name: normalize(accessibleName(element)).slice(0, 200),
          text: normalize(element.textContent).slice(0, 200)
        });
      }
      return out;
    }
    for (const element of document.querySelectorAll("*")) {
      if (!visible(element)) continue;
      if (config.kind === "text") {
        const own = normalize(element.textContent);
        if (!matches(own)) continue;
        // Keep leaf-most matches so containers are not reported alongside
        // every child that also contains the text.
        let deeper = false;
        for (const child of element.querySelectorAll("*")) {
          if (visible(child) && matches(normalize(child.textContent))) {
            deeper = true;
            break;
          }
        }
        if (deeper) continue;
      } else {
        const role = element.getAttribute("role") || implicitRole(element);
        if (config.role && role !== config.role) continue;
        if (!matches(accessibleName(element))) continue;
      }
      const rect = element.getBoundingClientRect();
      out.push({
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || implicitRole(element),
        name: normalize(accessibleName(element)).slice(0, 200),
        text: normalize(element.textContent).slice(0, 200)
      });
    }
    return out;
  }
`;

// Resolve each frame's top-level page offset by locating its owning element
// inside the parent frame and adding the parent's own accumulated offset.
// Detached or inaccessible frames are skipped defensively so one bad frame
// cannot crash the worker.
async function frameOffsets(page) {
  const offsets = new Map([[page.mainFrame(), { x: 0, y: 0 }]]);
  const visit = async (parent, parentOffset) => {
    for (const child of parent.childFrames()) {
      let element = null;
      try {
        element = await child.frameElement();
        if (element === null) continue;
        const ownerOffset = await element.evaluate((iframe) => {
          const rect = iframe.getBoundingClientRect();
          return { x: rect.left + globalThis.scrollX, y: rect.top + globalThis.scrollY };
        });
        offsets.set(child, {
          x: parentOffset.x + ownerOffset.x,
          y: parentOffset.y + ownerOffset.y
        });
        await visit(child, offsets.get(child));
      } catch {
        // Detached or inaccessible frames contribute no offsets.
      } finally {
        if (element !== null) {
          await element.dispose().catch(() => {});
        }
      }
    }
  };
  await visit(page.mainFrame(), { x: 0, y: 0 });
  return offsets;
}

async function run() {
  const requestPath = process.argv[process.argv.indexOf("--request") + 1];
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const viewport = {
    width: Math.min(Math.max(Number(request.viewport?.width) || 1280, 320), 4096),
    height: Math.min(Math.max(Number(request.viewport?.height) || 800, 240), 4096)
  };
  const timeoutMs = Math.min(Math.max(Number(request.timeoutMs) || 15000, 1000), 120000);
  const maxCandidates = Math.min(Math.max(Number(request.maxCandidates) || 100, 1), 100);
  const locator = request.locator ?? {};
  if (!["selector", "text", "accessible"].includes(locator.kind)) {
    throw Object.assign(new Error("locator.kind is required."), { code: "DOM_LOCATOR_INVALID" });
  }
  if (typeof locator.value !== "string" || locator.value.trim() === "") {
    throw Object.assign(new Error("locator.value is required."), { code: "DOM_LOCATOR_INVALID" });
  }
  if (typeof request.url !== "string" || request.url.trim() === "") {
    throw Object.assign(new Error("url is required."), { code: "DOM_LOCATOR_INVALID" });
  }
  if (typeof request.screenshotPath !== "string" || request.screenshotPath.trim() === "") {
    throw Object.assign(new Error("screenshotPath is required."), { code: "DOM_LOCATOR_INVALID" });
  }

  const launchOptions = { channel: "chrome", headless: true };
  if (request.executablePath) launchOptions.executablePath = request.executablePath;
  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      viewport: { width: viewport.width, height: viewport.height }
    });
    const page = await context.newPage();
    await page.goto(request.url, { waitUntil: "load", timeout: timeoutMs });
    await page
      .waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 5000) })
      .catch(() => {});

    const offsets = await frameOffsets(page);
    const normalizedQuery = collapseCjkSpaces(normalizeText(locator.value));
    const candidates = [];
    for (const frame of page.frames()) {
      const offset = offsets.get(frame) ?? { x: 0, y: 0 };
      const collected = await frame.evaluate(
        `(${COLLECT_SCRIPT})(${JSON.stringify({
          kind: locator.kind,
          query: normalizedQuery,
          exact: locator.exact ?? false,
          role: locator.role ?? null
        })})`
      );
      for (const item of collected) {
        candidates.push({
          rect: {
            x: Math.round(offset.x + item.rect.x),
            y: Math.round(offset.y + item.rect.y),
            width: Math.round(item.rect.width),
            height: Math.round(item.rect.height)
          },
          framePath: frame === page.mainFrame() ? [] : frame.url(),
          tag: item.tag,
          role: item.role,
          name: item.name,
          text: item.text
        });
      }
    }

    const totalCandidates = candidates.length;
    const limited = candidates.slice(0, maxCandidates);
    const scroll = await page.evaluate(() => ({ x: globalThis.scrollX, y: globalThis.scrollY }));
    const screenshotBuffer = await page.screenshot({ fullPage: true, type: "png" });
    await writeFile(request.screenshotPath, screenshotBuffer);
    const screenshotSha256 = createHash("sha256").update(screenshotBuffer).digest("hex");

    return {
      ok: true,
      candidates: limited,
      totalCandidates,
      truncated: totalCandidates > limited.length,
      page: {
        url: page.url(),
        title: await page.title(),
        viewport,
        scroll
      },
      screenshot: {
        path: request.screenshotPath,
        sha256: screenshotSha256,
        sizeBytes: screenshotBuffer.byteLength
      }
    };
  } finally {
    await browser.close();
  }
}

try {
  const result = await run();
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      code: error?.code ?? "DOM_LOCATE_FAILED",
      message: error instanceof Error ? error.message : String(error)
    })
  );
  process.exit(1);
}
