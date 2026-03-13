import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "canopy", version: "1.0.0" });

// ── DOM refs ──────────────────────────────────────────────────────────
const statusEl = document.getElementById("status");
const viewerEl = document.getElementById("viewer");
const controlsEl = document.getElementById("controls");
const zoomLabelEl = document.getElementById("zoom-label");

// ── Pan/zoom state ────────────────────────────────────────────────────
let scale = 1;
let tx = 0;
let ty = 0;
let imgEl = null;
let dragging = false;
let dragStartX = 0, dragStartY = 0, dragStartTx = 0, dragStartTy = 0;

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;

// ── Status ────────────────────────────────────────────────────────────
function setStatus(text) {
  statusEl.textContent = text;
  statusEl.style.display = "";
  viewerEl.style.display = "none";
  controlsEl.style.display = "none";
}

// ── Transform ─────────────────────────────────────────────────────────
function applyTransform() {
  if (!imgEl) return;
  imgEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  zoomLabelEl.textContent = `${Math.round(scale * 100)}%`;
}

/** Scale the image to fill the viewer, centered. */
function fitToViewer() {
  if (!imgEl) return;
  const vw = viewerEl.clientWidth;
  const vh = viewerEl.clientHeight;
  if (!vw || !vh) return;
  scale = Math.min(vw / imgEl.naturalWidth, vh / imgEl.naturalHeight);
  tx = (vw - imgEl.naturalWidth * scale) / 2;
  ty = (vh - imgEl.naturalHeight * scale) / 2;
  applyTransform();
}

/** Zoom by `factor` keeping the point (cx, cy) in the viewer fixed. */
function zoomBy(factor, cx, cy) {
  const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
  tx = cx - (cx - tx) * (newScale / scale);
  ty = cy - (cy - ty) * (newScale / scale);
  scale = newScale;
  applyTransform();
}

// ── Show image ────────────────────────────────────────────────────────
function showImage(img) {
  imgEl = img;
  viewerEl.innerHTML = "";
  viewerEl.appendChild(img);
  statusEl.style.display = "none";
  viewerEl.style.display = "block";
  controlsEl.style.display = "flex";
  requestAnimationFrame(fitToViewer);
}

// ── Wheel: zoom toward cursor ─────────────────────────────────────────
viewerEl.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = viewerEl.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  // ctrlKey signals a trackpad pinch; deltaY is then a proportional value.
  // For regular scroll, treat any notch as a fixed 12% step.
  const factor = e.ctrlKey
    ? Math.max(0.5, Math.min(2, 1 - e.deltaY * 0.01))
    : e.deltaY < 0 ? 1.12 : 1 / 1.12;
  zoomBy(factor, cx, cy);
}, { passive: false });

// ── Mouse drag: pan ───────────────────────────────────────────────────
viewerEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  dragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragStartTx = tx;
  dragStartTy = ty;
  viewerEl.classList.add("dragging");
  e.preventDefault();
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  tx = dragStartTx + (e.clientX - dragStartX);
  ty = dragStartTy + (e.clientY - dragStartY);
  applyTransform();
});

window.addEventListener("mouseup", () => {
  dragging = false;
  viewerEl.classList.remove("dragging");
});

// ── Double-click: reset to fit ────────────────────────────────────────
viewerEl.addEventListener("dblclick", fitToViewer);

// ── Controls ──────────────────────────────────────────────────────────
document.getElementById("btn-zoom-in").addEventListener("click", () => {
  zoomBy(1.5, viewerEl.clientWidth / 2, viewerEl.clientHeight / 2);
});
document.getElementById("btn-zoom-out").addEventListener("click", () => {
  zoomBy(1 / 1.5, viewerEl.clientWidth / 2, viewerEl.clientHeight / 2);
});
document.getElementById("btn-fit").addEventListener("click", fitToViewer);

// ── MCP lifecycle ─────────────────────────────────────────────────────
app.ontoolinput = () => setStatus("Rendering\u2026");

app.ontoolresult = async ({ structuredContent }) => {
  const { imageId, title } = structuredContent ?? {};
  if (!imageId) { setStatus("No image ID in result."); return; }
  setStatus("Loading\u2026");
  try {
    const result = await app.callServerTool({
      name: "get_diagram_image",
      arguments: { id: imageId },
    });
    const { data, mimeType } = JSON.parse(result.content[0].text);
    const img = new Image();
    img.src = `data:${mimeType};base64,${data}`;
    img.alt = title || "diagram";
    img.draggable = false;
    img.onload = () => showImage(img);
    img.onerror = () => setStatus("\u26a0 Failed to display image.");
  } catch (err) {
    setStatus("Error: " + err.message);
  }
};

await app.connect(new PostMessageTransport());
setStatus("Waiting for diagram\u2026");
