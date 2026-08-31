/// <reference lib="dom" />

import Konva from "konva";

declare global {
  interface Window {
    AGENT_CALLOUT_TOKEN: string;
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Redact {
  id: string;
  type: "redact";
  rect: Rect;
  color: string;
}
interface Project {
  version: "1.0";
  source: { sha256: string };
  annotationSpec: {
    version: "1.0";
    coordinateSpace: "pixel" | "normalized";
    annotations: Redact[];
  };
}
interface State {
  inspection: { dimensions: { width: number; height: number } };
  project: Project;
}

const token = window.AGENT_CALLOUT_TOKEN;
const query = `?token=${encodeURIComponent(token)}`;
function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing editor control ${selector}.`);
  return element;
}

const canvas = requiredElement<HTMLDivElement>("#canvas");
const status = requiredElement<HTMLDivElement>("#status");
const colorInput = requiredElement<HTMLInputElement>("#color");
const addButton = requiredElement<HTMLButtonElement>("#add");
const deleteButton = requiredElement<HTMLButtonElement>("#delete");
const undoButton = requiredElement<HTMLButtonElement>("#undo");
const saveButton = requiredElement<HTMLButtonElement>("#save");
const exportButton = requiredElement<HTMLButtonElement>("#export");

let project: Project;
let scale = 1;
let stage: Konva.Stage;
let redactionLayer: Konva.Layer;
let transformer: Konva.Transformer;
let selectedId: string | undefined;
let history: Project[] = [];
let nextRedactionNumber = 1;

function message(value: string): void {
  status.textContent = value;
}
function clone(value: Project): Project {
  return JSON.parse(JSON.stringify(value)) as Project;
}
function selected(): Redact | undefined {
  return project.annotationSpec.annotations.find((item) => item.id === selectedId);
}
function setButtons(): void {
  deleteButton.disabled = selectedId === undefined;
  undoButton.disabled = history.length === 0;
}
function remember(): void {
  history = [...history.slice(-19), clone(project)];
  setButtons();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${url}${query}`, options);
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}

function clampRect(rect: Rect): Rect {
  const dimensions = stage.getAttr("sourceDimensions") as { width: number; height: number };
  const x = Math.max(0, Math.min(dimensions.width - 1, Math.round(rect.x)));
  const y = Math.max(0, Math.min(dimensions.height - 1, Math.round(rect.y)));
  const width = Math.max(1, Math.min(dimensions.width - x, Math.round(rect.width)));
  const height = Math.max(1, Math.min(dimensions.height - y, Math.round(rect.height)));
  return { x, y, width, height };
}

function select(id: string | undefined): void {
  selectedId = id;
  const node = id === undefined ? undefined : redactionLayer.findOne<Konva.Rect>(`#${id}`);
  transformer.nodes(node ? [node] : []);
  const item = selected();
  if (item) colorInput.value = item.color;
  setButtons();
  redactionLayer.draw();
}

function updateFromNode(node: Konva.Rect): void {
  const item = project.annotationSpec.annotations.find((annotation) => annotation.id === node.id());
  if (!item) return;
  remember();
  item.rect = clampRect({
    x: node.x() / scale,
    y: node.y() / scale,
    width: (node.width() * node.scaleX()) / scale,
    height: (node.height() * node.scaleY()) / scale
  });
  node.scale({ x: 1, y: 1 });
  renderRedactions();
  select(item.id);
}

function createTransformer(): Konva.Transformer {
  return new Konva.Transformer({
    rotateEnabled: false,
    keepRatio: false,
    flipEnabled: false,
    anchorSize: 10,
    borderStroke: "#2563eb",
    anchorStroke: "#2563eb",
    enabledAnchors: [
      "top-left",
      "top-center",
      "top-right",
      "middle-left",
      "middle-right",
      "bottom-left",
      "bottom-center",
      "bottom-right"
    ],
    boundBoxFunc: (oldBox, nextBox) => (nextBox.width < 3 || nextBox.height < 3 ? oldBox : nextBox)
  });
}

function renderRedactions(): void {
  redactionLayer.destroyChildren();
  transformer = createTransformer();
  for (const item of project.annotationSpec.annotations) {
    const rect = new Konva.Rect({
      id: item.id,
      x: item.rect.x * scale,
      y: item.rect.y * scale,
      width: item.rect.width * scale,
      height: item.rect.height * scale,
      fill: item.color,
      stroke: "#ffffff",
      strokeWidth: 1,
      draggable: true
    });
    rect.on("click tap", () => select(item.id));
    rect.on("dragend transformend", () => updateFromNode(rect));
    redactionLayer.add(rect);
  }
  redactionLayer.add(transformer);
  redactionLayer.draw();
}

function addRedaction(): void {
  const dimensions = stage.getAttr("sourceDimensions") as { width: number; height: number };
  remember();
  let id = "";
  do {
    id = `redact-${nextRedactionNumber}`;
    nextRedactionNumber += 1;
  } while (project.annotationSpec.annotations.some((annotation) => annotation.id === id));
  project.annotationSpec.annotations.push({
    id,
    type: "redact",
    rect: {
      x: Math.round(dimensions.width * 0.35),
      y: Math.round(dimensions.height * 0.4),
      width: Math.max(24, Math.round(dimensions.width * 0.2)),
      height: Math.max(24, Math.round(dimensions.height * 0.1))
    },
    color: colorInput.value.toUpperCase()
  });
  renderRedactions();
  select(id);
}

async function save(): Promise<void> {
  await request("/api/project", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project)
  });
  message("项目已保存。导出时将从原图重新渲染。");
}

async function exportPng(): Promise<void> {
  await save();
  const value = await request<{ result: { outputPath: string; markdown: string } }>("/api/export", {
    method: "POST"
  });
  message(`安全 PNG 已导出：\n${value.result.outputPath}\n${value.result.markdown}`);
}

async function initialize(): Promise<void> {
  const state = await request<State>("/api/state");
  project = state.project;
  const image = new Image();
  image.src = `/api/image${query}`;
  await image.decode();
  scale = Math.min(
    1,
    Math.max(
      0.15,
      (window.innerWidth - 330) / image.width,
      (window.innerHeight - 110) / image.height
    )
  );
  stage = new Konva.Stage({
    container: canvas,
    width: Math.round(image.width * scale),
    height: Math.round(image.height * scale),
    sourceDimensions: state.inspection.dimensions
  });
  const imageLayer = new Konva.Layer();
  imageLayer.add(new Konva.Image({ image, width: stage.width(), height: stage.height() }));
  redactionLayer = new Konva.Layer();
  transformer = createTransformer();
  stage.add(imageLayer, redactionLayer);
  stage.on("click tap", (event) => {
    if (event.target === stage) select(undefined);
  });
  renderRedactions();
  setButtons();
  message("从原图编辑；完成后点击“导出安全 PNG”。");
}

addButton.addEventListener("click", addRedaction);
deleteButton.addEventListener("click", () => {
  const item = selected();
  if (!item) return;
  remember();
  project.annotationSpec.annotations = project.annotationSpec.annotations.filter(
    (annotation) => annotation.id !== item.id
  );
  select(undefined);
  renderRedactions();
});
undoButton.addEventListener("click", () => {
  const previous = history.pop();
  if (!previous) return;
  project = previous;
  selectedId = undefined;
  renderRedactions();
  setButtons();
});
colorInput.addEventListener("input", () => {
  const item = selected();
  if (!item) return;
  remember();
  item.color = colorInput.value.toUpperCase();
  renderRedactions();
  select(item.id);
});
saveButton.addEventListener(
  "click",
  () => void save().catch((error: unknown) => message(`保存失败：${String(error)}`))
);
exportButton.addEventListener(
  "click",
  () => void exportPng().catch((error: unknown) => message(`导出失败：${String(error)}`))
);
void initialize().catch((error: unknown) => message(`初始化失败：${String(error)}`));
