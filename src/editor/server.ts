import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  annotateImage,
  DEFAULT_IMAGE_LIMITS,
  inspectImage,
  type GeneratedImageResult,
  type ImageInspection
} from "../core/index.js";
import {
  createRedactionProject,
  parseRedactionProject,
  writeRedactionProject,
  type RedactionProject
} from "./project.js";

const MAX_REQUEST_BYTES = 1_000_000;

export interface RedactionEditorOptions {
  inputPath: string;
  outputPath: string;
  projectPath: string;
}

export interface RedactionEditorSession {
  url: string;
  close(): Promise<void>;
}

interface EditorState {
  inspection: ImageInspection;
  project: RedactionProject;
}

function html(token: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentCallout 遮挡编辑器</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f4f6;color:#172033;font:14px system-ui,sans-serif}header{height:54px;padding:12px 18px;background:#172033;color:white;font-weight:700}main{display:grid;grid-template-columns:minmax(0,1fr) 270px;min-height:calc(100vh - 54px)}#canvas-wrap{overflow:auto;padding:24px;background:#e5e7eb}#canvas{display:inline-block;box-shadow:0 3px 15px #0003;line-height:0}aside{padding:18px;background:#fff;border-left:1px solid #d1d5db}button,input{font:inherit}button{width:100%;padding:9px;margin:0 0 10px;border:0;border-radius:6px;background:#d92d20;color:#fff;font-weight:650;cursor:pointer}button.secondary{background:#e5e7eb;color:#172033}button:disabled{opacity:.5;cursor:not-allowed}label{display:block;margin:15px 0 6px;font-weight:650}.hint{color:#4b5563;line-height:1.45}.status{margin-top:16px;white-space:pre-wrap;color:#374151}.security{margin-top:20px;padding:10px;background:#fff6e8;color:#854d0e;border-radius:6px;line-height:1.4}@media(max-width:760px){main{grid-template-columns:1fr}aside{border-left:0;border-top:1px solid #d1d5db}}
</style></head><body><header>AgentCallout · 可编辑纯色遮挡</header><main><section id="canvas-wrap"><div id="canvas"></div></section><aside>
<button id="add">新增遮挡块</button><button id="undo" class="secondary">撤销</button><button id="delete" class="secondary">删除选中项</button><label for="color">遮挡颜色</label><input id="color" type="color" value="#000000"><button id="save" class="secondary">保存项目</button><button id="export">导出安全 PNG</button><p class="hint">拖拽色块可移动；拖动八个手柄可改变范围。所有颜色均为完全不透明。</p><p class="security">导出会从原图重新渲染，并覆盖遮挡区的源像素。已分享的导出文件不会被修改。</p><div id="status" class="status"></div></aside></main>
<script>window.AGENT_CALLOUT_TOKEN=${JSON.stringify(token)};</script><script src="/editor.js?token=${encodeURIComponent(token)}"></script></body></html>`;
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType: string
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Security-Policy":
      "default-src 'none'; connect-src 'self'; img-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "Content-Type": contentType,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function tokenFrom(request: IncomingMessage): string | undefined {
  const address = new URL(request.url ?? "/", "http://127.0.0.1");
  return address.searchParams.get("token") ?? undefined;
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  request.setEncoding("utf8");
  let source = "";
  let size = 0;
  for await (const chunk of request) {
    const text = String(chunk);
    size += Buffer.byteLength(text);
    if (size > MAX_REQUEST_BYTES) throw new Error("Request body is too large.");
    source += text;
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function statusError(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function safeProjectPath(requestedPath: string, inputPath: string): Promise<string> {
  const absolute = path.resolve(requestedPath);
  if (path.extname(absolute).toLowerCase() !== ".json") {
    throw new Error("Editor project paths must use a .json extension.");
  }
  const parent = await realpath(path.dirname(absolute));
  const candidate = path.join(parent, path.basename(absolute));
  try {
    const link = await lstat(candidate);
    if (link.isSymbolicLink() || !link.isFile()) {
      throw new Error("Editor project path must be a regular file, not a link or directory.");
    }
    const [projectIdentity, inputIdentity] = await Promise.all([
      stat(candidate, { bigint: true }),
      stat(inputPath, { bigint: true })
    ]);
    if (projectIdentity.dev === inputIdentity.dev && projectIdentity.ino === inputIdentity.ino) {
      throw new Error("Editor project path must not alias the input image.");
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  return candidate;
}

async function normalizedEditorImage(inputPath: string): Promise<Buffer> {
  return sharp(inputPath, {
    failOn: "error",
    limitInputPixels: DEFAULT_IMAGE_LIMITS.maxPixels
  })
    .autoOrient()
    .toColourspace("srgb")
    .png()
    .toBuffer();
}

async function loadProject(projectPath: string, sourceSha256: string): Promise<RedactionProject> {
  try {
    const source = await readFile(projectPath, "utf8");
    const project = parseRedactionProject(JSON.parse(source));
    if (project.source.sha256 !== sourceSha256) {
      throw new Error("Project source hash does not match the selected input image.");
    }
    return project;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return createRedactionProject(sourceSha256);
    }
    throw error;
  }
}

async function readEditorBundle(): Promise<Buffer> {
  const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(runtimeDirectory, "editor.js"),
    path.join(runtimeDirectory, "..", "..", "dist", "editor.js")
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

export async function startRedactionEditor(
  options: RedactionEditorOptions
): Promise<RedactionEditorSession> {
  const requestedInputPath = path.resolve(options.inputPath);
  const outputPath = path.resolve(options.outputPath);
  const requestedProjectPath = path.resolve(options.projectPath);
  const roots = [
    ...new Set([
      path.dirname(requestedInputPath),
      path.dirname(outputPath),
      path.dirname(requestedProjectPath)
    ])
  ];
  const inspection = await inspectImage(requestedInputPath, { allowedRoots: roots });
  const inputPath = inspection.path;
  const projectPath = await safeProjectPath(requestedProjectPath, inputPath);
  const initialProject = await loadProject(projectPath, inspection.sha256);
  const state: EditorState = { inspection, project: initialProject };
  const token = randomBytes(24).toString("hex");
  const clientBundle = await readEditorBundle();
  const sourceBytes = await normalizedEditorImage(inputPath);

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestToken = tokenFrom(request);
    if (requestToken !== token) {
      sendJson(response, 403, { error: "Invalid editor session token." });
      return;
    }
    const address = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && address.pathname === "/") {
        send(response, 200, html(token), "text/html; charset=utf-8");
      } else if (request.method === "GET" && address.pathname === "/editor.js") {
        send(response, 200, clientBundle, "text/javascript; charset=utf-8");
      } else if (request.method === "GET" && address.pathname === "/api/state") {
        sendJson(response, 200, { inspection: state.inspection, project: state.project });
      } else if (request.method === "GET" && address.pathname === "/api/image") {
        send(response, 200, sourceBytes, "image/png");
      } else if (request.method === "PUT" && address.pathname === "/api/project") {
        const next = parseRedactionProject(await requestJson(request));
        if (next.source.sha256 !== state.inspection.sha256) {
          throw new Error("Project source hash does not match this editor session.");
        }
        state.project = next;
        await writeRedactionProject(projectPath, next);
        sendJson(response, 200, { saved: true });
      } else if (request.method === "POST" && address.pathname === "/api/export") {
        await writeRedactionProject(projectPath, state.project);
        const result: GeneratedImageResult = await annotateImage({
          inputPath,
          outputPath,
          spec: state.project.annotationSpec,
          allowedRoots: roots
        });
        sendJson(response, 200, { result });
      } else {
        sendJson(response, 404, { error: "Unknown editor endpoint." });
      }
    } catch (error) {
      sendJson(response, 400, { error: statusError(error) });
    }
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Could not determine the local editor address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/?token=${token}`,
    close: () => closeServer(server)
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
  });
}
