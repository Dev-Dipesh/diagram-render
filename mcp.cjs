#!/usr/bin/env node
/**
 * mcp.cjs
 * -------
 * MCP server exposing Canopy as tools for AI apps (Claude Code, Claude Desktop).
 *
 * Runs over stdio — configure in your MCP client:
 *   { "command": "node", "args": ["/path/to/canopy/mcp.cjs"] }
 *
 * Tools:
 *   get_diagram_preferences - Returns format selection rules and visual style guide.
 *   render_diagram          - Render diagram source text, returns a preview URL.
 *   render_file             - Render a diagram file on disk, returns preview URL(s).
 *   list_supported_types    - List all Kroki diagram types and their file extensions.
 *   search_diagrams         - Search previously rendered diagrams by title keyword.
 *   rename_diagram          - Rename a diagram in the registry by ID.
 *   delete_diagram          - Delete a diagram from the registry and disk by ID.
 *
 * HTTP file server (same process, loopback only):
 *   GET  http://127.0.0.1:<port>/         → gallery page (all rendered diagrams)
 *   GET  http://127.0.0.1:<port>/?id=<id> → gallery opened in lightbox for that diagram
 *   GET  http://127.0.0.1:<port>/<id>     → raw image bytes (for <img> src in gallery)
 *   DELETE http://127.0.0.1:<port>/<id>   → remove from registry + disk
 *   POST http://127.0.0.1:<port>/render { source, type } → raw image bytes (direct render)
 *   Preferred port: 17432 (tries 17432–17440 until one is free).
 *   Override start port: DIAGRAM_RENDER_HTTP_PORT env var.
 *
 * Persistent storage:
 *   Images default to ~/.canopy/output/<id>.<ext> — survives reboots.
 *   Registry persisted to ~/.canopy/registry.json — survives server restarts.
 *   Preview URLs remain valid as long as the image file exists on disk.
 *
 * Kroki server selection (non-interactive):
 *   Tries local Kroki at http://localhost:8000 first.
 *   Falls back to https://kroki.io automatically if local is unavailable.
 *   Override with DIAGRAM_RENDER_KROKI_URL env var or --kroki-url flag.
 */

"use strict";

const { exec } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const {
  LOCAL_URL,
  PUBLIC_URL,
  OUTPUT_FORMAT,
  KROKI_TYPE,
  MARKDOWN_LANG,
  SUPPORTED_EXTENSIONS,
  krokiRender,
  checkLocalServer,
  renderMarkdownFile,
} = require("./lib/renderer.cjs");

const HTTP_PORT_START = parseInt(
  process.env.DIAGRAM_RENDER_HTTP_PORT ?? "17432",
  10,
);
const HTTP_BIND_HOST = process.env.DIAGRAM_RENDER_BIND_HOST ?? "127.0.0.1";
const HTTP_PUBLIC_BASE_URL = process.env.DIAGRAM_RENDER_PUBLIC_BASE_URL ?? null;

/** Actual bound port — set by startHttpServer(), used by registerFile(). */
let httpPort = null;

/** Reference to the HTTP server — used to close it gracefully on SIGTERM. */
let httpServer = null;

/**
 * Version token for this running instance — derived from this file's mtime.
 * Changes on every deploy/save, enabling stale-server detection.
 */
const SERVER_VERSION = String(fs.statSync(__filename).mtimeMs);

// ---------------------------------------------------------------------------
// Persistent storage paths
// ---------------------------------------------------------------------------

const HOME_DIR = process.env.CANOPY_HOME_DIR ?? path.join(os.homedir(), ".canopy");
const OUTPUT_DIR = path.join(HOME_DIR, "output");
const REGISTRY_FILE = path.join(HOME_DIR, "registry.json");
const PID_FILE = path.join(HOME_DIR, "server.pid");
const PREFERENCES_FILE = path.join(HOME_DIR, "preferences.md");

// ---------------------------------------------------------------------------
// HTTP server ownership — tracks which process owns the HTTP listener.
// Only the process that successfully binds writes the PID file.
// New instances check the running version: piggyback if same, replace if stale.
// ---------------------------------------------------------------------------

/**
 * Reads the PID file and returns { pid, version } for the owning process,
 * or null if the file is absent, unreadable, or the process is no longer alive.
 * Handles both the current JSON format and the legacy plain-text (pid-only) format.
 *
 * @returns {{ pid: number, version: string|null }|null}
 */
function readHttpServerOwner() {
  if (!fs.existsSync(PID_FILE)) return null;
  try {
    const content = fs.readFileSync(PID_FILE, "utf8").trim();
    let pid, version;
    try {
      ({ pid, version } = JSON.parse(content)); // current format
    } catch {
      pid = parseInt(content, 10);
      version = null; // legacy plain-text format
    }
    if (!pid || pid === process.pid) return null;
    process.kill(pid, 0); // throws ESRCH if process is dead
    return { pid, version: version ?? null };
  } catch {
    return null;
  }
}

/**
 * Writes this process's PID and version to the PID file and registers cleanup
 * handlers so the file is removed when this process exits.
 *
 * On SIGTERM/SIGINT the HTTP server is closed first so the port is guaranteed
 * free before the PID file disappears — preventing a race where a new instance
 * sees no PID file but still can't bind.
 */
function writePidFile() {
  fs.writeFileSync(
    PID_FILE,
    JSON.stringify({ pid: process.pid, version: SERVER_VERSION }),
    "utf8",
  );
  const cleanup = () => fs.rmSync(PID_FILE, { force: true });
  process.once("exit", cleanup);

  const gracefulExit = () => {
    if (httpServer) {
      // Close server first; remove PID file only after port is fully released.
      httpServer.close(() => {
        cleanup();
        process.exit(0);
      });
      // Force exit after 2 s in case keep-alive connections linger.
      setTimeout(() => {
        cleanup();
        process.exit(0);
      }, 2000).unref();
    } else {
      cleanup();
      process.exit(0);
    }
  };
  process.once("SIGTERM", gracefulExit);
  process.once("SIGINT", gracefulExit);
}

// ---------------------------------------------------------------------------
// Kroki URL resolution — no stdin, resolved per-call
// ---------------------------------------------------------------------------

async function resolveKrokiUrl() {
  if (process.env.DIAGRAM_RENDER_KROKI_URL) {
    return process.env.DIAGRAM_RENDER_KROKI_URL;
  }
  const localUp = await checkLocalServer(LOCAL_URL);
  return localUp ? LOCAL_URL : PUBLIC_URL;
}

// ---------------------------------------------------------------------------
// File registry — maps short IDs to rendered files for HTTP serving
// Persisted to ~/.canopy/registry.json so URLs survive restarts.
// ---------------------------------------------------------------------------

/** id → { filePath, mimeType } */
const fileRegistry = new Map();

/** Loads persisted registry entries from disk into the in-memory Map. */
function loadRegistry() {
  if (!fs.existsSync(REGISTRY_FILE)) return;
  try {
    const entries = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    for (const [id, entry] of Object.entries(entries)) {
      fileRegistry.set(id, entry);
    }
    process.stderr.write(
      `canopy: registry loaded (${fileRegistry.size} entries)\n`,
    );
  } catch {
    process.stderr.write("canopy: could not read registry, starting fresh\n");
  }
}

/** Writes the current in-memory registry to disk. */
function persistRegistry() {
  fs.writeFileSync(
    REGISTRY_FILE,
    JSON.stringify(Object.fromEntries(fileRegistry), null, 2),
    "utf8",
  );
}

/**
 * Registers a user-provided file path and returns its preview URL.
 * Use allocateOutput() instead when no explicit path is given.
 *
 * @param {string} filePath - Absolute path to the rendered file.
 * @param {string} mimeType - MIME type (image/png or image/svg+xml).
 * @param {string|null} title - Optional human-readable title for gallery/search.
 * @returns {string} Preview URL.
 */
function previewBaseUrl() {
  return HTTP_PUBLIC_BASE_URL ?? `http://127.0.0.1:${httpPort}`;
}

function registerFile(filePath, mimeType, title = null) {
  const id = crypto.randomBytes(6).toString("hex");
  fileRegistry.set(id, {
    filePath,
    mimeType,
    title,
    createdAt: new Date().toISOString(),
  });
  persistRegistry();
  return `${previewBaseUrl()}/?id=${id}`;
}

/**
 * Allocates a persistent output path under ~/.canopy/output/,
 * pre-registers it, and returns the file path and preview URL together.
 * The file doesn't exist yet — caller must write it before the URL is useful.
 *
 * @param {string} fmt - File extension without dot (e.g. "png", "svg").
 * @param {string|null} title - Optional human-readable title for gallery/search.
 * @returns {{ filePath: string, previewUrl: string }}
 */
function allocateOutput(fmt, title = null) {
  const id = crypto.randomBytes(6).toString("hex");
  const mimeType = fmt === "svg" ? "image/svg+xml" : "image/png";
  const filePath = path.join(OUTPUT_DIR, `${id}.${fmt}`);
  fileRegistry.set(id, {
    filePath,
    mimeType,
    title,
    createdAt: new Date().toISOString(),
  });
  persistRegistry();
  return { filePath, previewUrl: `${previewBaseUrl()}/?id=${id}` };
}

// ---------------------------------------------------------------------------
// Gallery HTML — served at GET / for browsing all rendered diagrams
// ---------------------------------------------------------------------------

const GALLERY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Canopy Gallery</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#1c1c1e;color:#e0e0e0;min-height:100vh}
header{background:#2c2c2e;padding:14px 20px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:10;box-shadow:0 1px 0 rgba(255,255,255,.08)}
h1{font-size:17px;font-weight:700;color:#fff;white-space:nowrap}
#search{flex:1;max-width:360px;background:#3a3a3c;border:1px solid #4a4a4c;color:#e0e0e0;padding:7px 12px;border-radius:8px;font-size:13px;outline:none}
#search:focus{border-color:#888}
#search::placeholder{color:#888}
#count{font-size:12px;color:#888;white-space:nowrap;margin-left:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;padding:20px}
.card{background:#2c2c2e;border-radius:10px;overflow:hidden;cursor:pointer;transition:transform .15s,box-shadow .15s;border:1px solid transparent}
.card:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.5);border-color:#4a4a4c}
.thumb{width:100%;aspect-ratio:16/9;object-fit:contain;background:#111;display:block}
.info{padding:10px 12px 12px}
.title{font-size:13px;font-weight:600;color:#e0e0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px}
.meta{display:flex;align-items:center;gap:6px;font-size:11px;color:#888}
.badge{background:#3a3a3c;border:1px solid #555;padding:1px 6px;border-radius:4px;text-transform:uppercase;font-size:10px;letter-spacing:.4px}
.card-actions{position:absolute;top:6px;right:6px;display:none;gap:4px}
.card:hover .card-actions{display:flex}
.card-wrap{position:relative}
.del-btn{background:rgba(0,0,0,.7);border:none;color:#ff453a;cursor:pointer;border-radius:5px;padding:4px 7px;font-size:13px;line-height:1}
.del-btn:hover{background:rgba(255,69,58,.2)}
.empty{text-align:center;padding:80px 20px;color:#555;font-size:14px}
.lb{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:100;flex-direction:column;align-items:center;justify-content:center}
.lb.open{display:flex}
.lb img{max-width:88vw;max-height:80vh;border-radius:6px;object-fit:contain}
.lb-bar{position:fixed;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:12px 18px;background:rgba(0,0,0,.6)}
.lb-title{font-size:14px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:50vw}
.lb-meta{font-size:12px;color:#999}
.lb-actions{display:flex;align-items:center;gap:12px;margin-left:auto}
.lb-close{font-size:22px;cursor:pointer;color:#aaa;line-height:1;padding:4px}
.lb-close:hover{color:#fff}
.lb-del{font-size:13px;cursor:pointer;color:#ff453a;padding:4px 8px;border-radius:5px;border:1px solid rgba(255,69,58,.4)}
.lb-del:hover{background:rgba(255,69,58,.15)}
.lb-nav{position:fixed;top:50%;transform:translateY(-50%);font-size:36px;cursor:pointer;color:#aaa;padding:16px;user-select:none;line-height:1}
.lb-nav:hover{color:#fff}
#lb-prev{left:8px}
#lb-next{right:8px}
.lb-open-link{position:fixed;bottom:18px;font-size:12px;color:#888;text-decoration:none}
.lb-open-link:hover{color:#ccc}
</style>
</head>
<body>
<header>
  <h1>Canopy</h1>
  <input id="search" type="search" placeholder="Search diagrams…">
  <span id="count"></span>
</header>
<div class="grid" id="grid"></div>
<div class="empty" id="empty" style="display:none">No diagrams found.</div>
<div class="lb" id="lb">
  <div class="lb-bar">
    <span class="lb-title" id="lb-title"></span>
    <span class="lb-meta" id="lb-meta"></span>
    <div class="lb-actions">
      <span class="lb-del" id="lb-del">Delete</span>
      <span class="lb-close" id="lb-close">✕</span>
    </div>
  </div>
  <span class="lb-nav" id="lb-prev">&#8249;</span>
  <img id="lb-img" src="" alt="">
  <span class="lb-nav" id="lb-next">&#8250;</span>
  <a class="lb-open-link" id="lb-open" href="" target="_blank">Open full size ↗</a>
</div>
<script>
const ALL = DIAGRAMS_JSON;
let filtered = ALL.slice();
let idx = 0;

function fmt(p){ return (p||'').split('.').pop().toUpperCase() }
function fmtDate(s){ return s ? new Date(s).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}) : '' }

function renderGrid(list){
  const g=document.getElementById('grid'), e=document.getElementById('empty'), c=document.getElementById('count');
  c.textContent = list.length + ' diagram'+(list.length!==1?'s':'');
  if(!list.length){ g.innerHTML=''; e.style.display=''; return }
  e.style.display='none';
  g.innerHTML=list.map((d,i)=>\`
    <div class="card-wrap">
      <div class="card" data-i="\${i}">
        <img class="thumb" src="/\${d.id}" loading="lazy" alt="\${d.title||''}">
        <div class="info">
          <div class="title">\${d.title||'(untitled)'}</div>
          <div class="meta"><span class="badge">\${fmt(d.filePath)}</span>\${d.createdAt?\`<span>\${fmtDate(d.createdAt)}</span>\`:''}</div>
        </div>
      </div>
      <div class="card-actions"><button class="del-btn" data-id="\${d.id}" title="Delete">🗑</button></div>
    </div>\`).join('');
  g.querySelectorAll('.card').forEach(el=>el.addEventListener('click',()=>open(+el.dataset.i)));
  g.querySelectorAll('.del-btn').forEach(btn=>btn.addEventListener('click',e=>{ e.stopPropagation(); del(btn.dataset.id); }));
}

function open(i){
  idx=i; const d=filtered[i];
  document.getElementById('lb-img').src='/'+d.id;
  document.getElementById('lb-open').href='/'+d.id;
  document.getElementById('lb-title').textContent=d.title||'(untitled)';
  document.getElementById('lb-meta').textContent=[fmt(d.filePath),fmtDate(d.createdAt)].filter(Boolean).join(' · ');
  document.getElementById('lb-del').dataset.id=d.id;
  document.getElementById('lb').classList.add('open');
}
function close(){ document.getElementById('lb').classList.remove('open') }
function nav(d){ open((idx+d+filtered.length)%filtered.length) }

async function del(id){
  if(!confirm('Delete this diagram?')) return;
  const r=await fetch('/'+id,{method:'DELETE'});
  if(!r.ok){ alert('Delete failed'); return; }
  const ai=ALL.findIndex(d=>d.id===id), fi=filtered.findIndex(d=>d.id===id);
  if(ai!==-1) ALL.splice(ai,1);
  if(fi!==-1) filtered.splice(fi,1);
  if(document.getElementById('lb').classList.contains('open')){
    if(filtered.length===0) close(); else open(Math.min(idx,filtered.length-1));
  }
  renderGrid(filtered);
}

document.getElementById('lb-close').addEventListener('click',close);
document.getElementById('lb-del').addEventListener('click',function(){ del(this.dataset.id); });
document.getElementById('lb-prev').addEventListener('click',()=>nav(-1));
document.getElementById('lb-next').addEventListener('click',()=>nav(1));
document.getElementById('search').addEventListener('input',function(){
  const q=this.value.toLowerCase();
  filtered=ALL.filter(d=>!q||(d.title||'').toLowerCase().includes(q));
  renderGrid(filtered);
});
document.addEventListener('keydown',e=>{
  if(!document.getElementById('lb').classList.contains('open'))return;
  if(e.key==='Escape')close();
  if(e.key==='ArrowLeft')nav(-1);
  if(e.key==='ArrowRight')nav(1);
});

renderGrid(filtered);
const focusId=new URLSearchParams(location.search).get('id');
if(focusId){ const i=filtered.findIndex(d=>d.id===focusId); if(i!==-1) open(i); }
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP server — serves registered files + direct render endpoint
// ---------------------------------------------------------------------------

/**
 * Sends SIGTERM to every process currently listening on the given TCP port,
 * using lsof. Used as a last resort when the PID file is absent or stale.
 * Resolves to true if at least one process was found and signaled.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function killPortOwner(port) {
  return new Promise((resolve) => {
    exec(`lsof -ti tcp:${port}`, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(false);
        return;
      }
      const pids = stdout
        .trim()
        .split("\n")
        .map(Number)
        .filter((p) => p && p !== process.pid);
      if (pids.length === 0) {
        resolve(false);
        return;
      }
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
          process.stderr.write(
            `canopy: sent SIGTERM to stale port ${port} owner (pid ${pid})\n`,
          );
        } catch {
          /* already gone */
        }
      }
      resolve(true);
    });
  });
}

/**
 * Binds the HTTP server to a fixed port, retrying on EADDRINUSE (e.g. while
 * the previous instance is still releasing the port after SIGTERM).
 * Never increments the port — stable port = stable URLs.
 *
 * @param {number} port
 * @returns {Promise<void>}
 */
function startHttpServer(port) {
  const handler = (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET / or /?id=<id> — gallery page (optionally auto-opens a diagram in lightbox)
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
      loadRegistry();
      const diagrams = [...fileRegistry.entries()]
        .filter(([, entry]) => fs.existsSync(entry.filePath))
        .map(([id, entry]) => ({
          id,
          title: entry.title ?? null,
          filePath: entry.filePath,
          createdAt: entry.createdAt ?? null,
        }))
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      const html = GALLERY_HTML.replace(
        "DIAGRAMS_JSON",
        JSON.stringify(diagrams),
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // DELETE /<id> — remove a diagram from registry and disk
    if (req.method === "DELETE" && req.url && req.url.length > 1) {
      const id = req.url.slice(1);
      const entry = fileRegistry.get(id);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      fileRegistry.delete(id);
      persistRegistry();
      try {
        if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath);
      } catch {
        // File already gone — registry is still cleaned up
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /<id> — serve a previously rendered file
    if (req.method === "GET" && req.url && req.url.length > 1) {
      const id = req.url.slice(1);
      let entry = fileRegistry.get(id);
      if (!entry) {
        // Another instance may have registered this ID — reload from disk.
        loadRegistry();
        entry = fileRegistry.get(id);
      }
      if (!entry || !fs.existsSync(entry.filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const data = fs.readFileSync(entry.filePath);
      res.writeHead(200, {
        "Content-Type": entry.mimeType,
        "Content-Length": data.length,
        "Cache-Control": "no-store",
      });
      res.end(data);
      return;
    }

    // POST /render — direct render without saving (for programmatic use)
    if (req.method === "POST" && req.url === "/render") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }

        const { source, type: diagramType } = body;
        if (!source || !diagramType) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "source and type are required" }));
          return;
        }

        try {
          const krokiUrl = await resolveKrokiUrl();
          const fmt = OUTPUT_FORMAT[diagramType] ?? "png";
          const mimeType = fmt === "svg" ? "image/svg+xml" : "image/png";
          const data = await krokiRender(source, diagramType, krokiUrl);
          res.writeHead(200, {
            "Content-Type": mimeType,
            "Content-Length": data.length,
          });
          res.end(data);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  };

  return new Promise((resolve, reject) => {
    let attempts = 0;
    let killedByLsof = false;
    const tryBind = () => {
      const srv = http.createServer(handler);
      srv.once("error", (err) => {
        if (err.code === "EADDRINUSE") {
          const owner = readHttpServerOwner();
          if (owner) {
            if (owner.version === SERVER_VERSION) {
              // Same version — safe to share the existing server's port.
              httpPort = port;
              process.stderr.write(
                `canopy: HTTP server already running on port ${port}, piggybacking\n`,
              );
              resolve();
              return;
            }
            // Stale version — replace the old server so new routes/tools are live.
            process.stderr.write(
              `canopy: replacing outdated HTTP server (pid ${owner.pid}, version ${owner.version ?? "unknown"})\n`,
            );
            try {
              process.kill(owner.pid, "SIGTERM");
            } catch {
              /* already gone */
            }
            // Fall through to retry loop — wait for the port to be released.
          }
          if (attempts < 15) {
            attempts++;
            process.stderr.write(
              `canopy: port ${port} still in use, retrying (${attempts}/15)…\n`,
            );
            setTimeout(tryBind, 300);
            return;
          }
          // All retries exhausted and no PID file owner found —
          // use lsof to force-kill whatever is holding the port (once).
          if (!killedByLsof) {
            killedByLsof = true;
            killPortOwner(port).then((killed) => {
              if (killed) {
                attempts = 0;
                process.stderr.write(
                  `canopy: waiting for port ${port} to clear after force-kill…\n`,
                );
                setTimeout(tryBind, 500);
              } else {
                reject(err);
              }
            });
            return;
          }
        }
        reject(err);
      });
      srv.listen(port, HTTP_BIND_HOST, () => {
        httpPort = port;
        httpServer = srv;
        writePidFile();
        process.stderr.write(
          `canopy HTTP server listening on http://${HTTP_BIND_HOST}:${port} (public: ${previewBaseUrl()})\n`,
        );
        resolve();
      });
    };
    tryBind();
  });
}

// ---------------------------------------------------------------------------
// MCP server instructions — injected into the client's system prompt
// automatically on every session. Users can override via ~/.canopy/preferences.md
// ---------------------------------------------------------------------------

const DEFAULT_INSTRUCTIONS = `\
You are a diagram generation assistant with access to a Kroki-based rendering \
server supporting 27 diagram formats.

Your job is to:
• select the correct diagram format
• apply consistent visual style
• generate diagrams that render reliably
• keep diagrams readable and structurally stable

Always prioritize:
- clarity
- layout stability
- visual consistency
- Kroki rendering reliability

---

# FORMAT SELECTION

Unless the user specifies a format, choose based on the diagram's intent.

| Diagram intent | Format |
|---|---|
Directional pipeline or agent flow | d2
Architecture with grouped systems | graphviz
Sequence or UML | plantuml
Quick documentation flowchart | mermaid
Network topology | nwdiag / rackdiag / packetdiag
Business process flow | bpmn
Database schema | erd

Decision shortcuts:

Clusters with subsystems → graphviz  
Actor timeline → plantuml  
Linear processing pipeline → d2  

If ambiguous:
architecture → graphviz  
pipeline → d2  

Never use **excalidraw** because it requires manual coordinates.

---

# VISUAL STYLE GUIDE

### Canvas

Background  
#FEFDF6

Flat design  
No shadows  
Generous spacing around clusters

---

# COLOR SYSTEM

Assign color by structural role.

| Role | Fill | Stroke | Text |
|---|---|---|---|
Entry / Input | #FFFFFF | #AAAAAA | #333333
Transform / Process | #FFF9C4 | #F9A825 | #5D4037
Compute / Execute | #BBDEFB | #1565C0 | #0D3C6E
Storage / Persist | #E1BEE7 | #6A1B9A | #4A1070
Orchestrate / Route | #B2EBF2 | #00838F | #004D56
Validate / Control | #C8E6C9 | #388E3C | #1B5E20
Evaluate / Output | #FFE0B2 | #E65100 | #7C3200
Alert / Exception | #F8BBD0 | #E53935 | #A31515
Auxiliary / Optional | #F5F5F5 | #9E9E9E | #555555

Inner nodes inside clusters must use lighter versions.

Cluster → Inner node

#FFF9C4 → #FFFDE7  
#BBDEFB → #E3F2FD  
#E1BEE7 → #F3E5F5  
#B2EBF2 → #E0F7FA  
#C8E6C9 → #DCEDC8  
#FFE0B2 → #FFF3E0  
#F8BBD0 → #FFCDD2  

---

# SHAPES

Nodes  
rounded rectangle

Corner radius  
8–12

Cluster border  
2px

Storage nodes  
cylinder when format supports it

No shadows.

---

# EDGE STYLE

Primary flow  
solid  
#444444  
1.5px

Secondary  
solid  
#767676  
1px

Exception path  
dashed  
#E53935  
2px

Feedback loop  
dashed  
#555555  

Edge labels

• maximum 2–3 words  
• 10pt  
• centered  

Always prefix label with a space.

Example

label=" parses body"

This prevents label overlap with the line.

---

# TYPOGRAPHY

Font  
Arial

Cluster title  
13pt bold

Node label  
11–12pt bold

Node sublabel  
9–10pt

Edge label  
10pt

Never use white text on pastel colors.

---

# LAYOUT PRINCIPLES

Architectures  
Top-to-bottom (TB)

Pipelines  
Left-to-right (LR)

Entry nodes  
Top-left

Outputs  
Bottom-right

Alert / monitoring systems  
Top-right cluster

Nodes at the same stage should share the same rank.

Spacing

nodesep ≥ 0.6  
ranksep ≥ 0.8

---

# STRUCTURAL GUIDANCE FOR ARCHITECTURE DIAGRAMS

Architecture diagrams are easier to read and render when they follow a layered flow.

Typical structure:

Entry / Interface  
↓  
Processing / Compute  
↓  
Storage / Persistence  

Optional additional layer:

Observability / Security / Monitoring

Clusters usually represent subsystems inside one of these layers.

Edges typically move forward across layers rather than randomly between components.

Avoid chaotic cross-connections whenever possible.

This structure significantly improves Graphviz layout stability.

---

# NODE NAMING GUIDELINES

Node identifiers must be:

• short  
• snake_case  
• unique  

Examples:

api_gateway  
embedding_service  
vector_db  
workflow_engine  

Avoid spaces in identifiers.

Human-readable labels can still include spaces.

---

# COMPLEXITY GUIDELINES

Preferred diagram size:

8–20 nodes

If architecture becomes large:

• group components into clusters  
• avoid showing every micro-component

When diagrams exceed:

• 25 nodes  
• 8 clusters  

Break the architecture into **multiple smaller diagrams** instead of forcing one large diagram.

Example breakdown:

1️⃣ High-level system architecture  
2️⃣ Internal service architecture  
3️⃣ Data flow architecture  
4️⃣ Deployment architecture

Multiple focused diagrams are preferred over one dense diagram.

---

# FORMAT-SPECIFIC RULES

## GRAPHVIZ

Graphviz is the preferred format for architecture diagrams.

Default configuration:

compound=true  
splines=true  
nodesep=0.6  
ranksep=0.8  
pad=0.4  
margin=0.2  

node [
  style="filled,rounded"
  shape=box
  fontname="Arial"
  fontsize=11
]

edge [
  fontname="Arial"
  fontsize=10
  color="#444444"
  penwidth=1.5
]

IMPORTANT

Never use

splines=ortho

Orthogonal routing combined with clusters causes:

• invisible arrows  
• clipped edges  
• routing failures  

Always use smooth splines.

---

# GRAPHVIZ CLUSTER GUIDELINES

Clusters represent:

• subsystems  
• service boundaries  
• architectural layers  
• protocol stacks

Clusters should ideally contain **3–8 nodes**.

Very large clusters should be split.

Clusters must include padding.

pad=0.4  
margin=0.2

---

# CROSS-CLUSTER EDGES

Prefer node-to-node edges.

Example

api_gateway → user_service

Avoid cluster boundary routing unless necessary.

Use lhead / ltail only when explicitly visualizing boundaries.

---

# RANK ALIGNMENT

Use invisible edges sparingly to maintain layout alignment.

Example

nodeA -> nodeB [style=invis]

Avoid long chains of invisible edges.

---

# PRE-RENDER REASONING STEP

Before generating a diagram:

1. Identify the main system components
2. Group components into clusters
3. Determine flow direction (LR or TB)
4. Decide entry and output nodes
5. Limit cluster size where possible
6. Ensure edges mostly flow forward

Then render the diagram.

This greatly improves diagram stability.

---

# D2 DEFAULTS

direction: down  
style.border-radius: 10  
style.bold: true  

Use for:

• pipelines  
• agent loops  
• linear workflows

---

# PLANTUML DEFAULTS

!theme plain  
skinparam backgroundColor #FEFDF6  
skinparam defaultFontName Arial  
skinparam RoundCorner 10  
skinparam shadowing false  

---

# BEHAVIOR RULES

1. State the format chosen and a one-line reason (unless user specified format).
2. Render the diagram immediately.
3. If syntax fails, fix it and retry automatically.
4. Always provide the preview URL after rendering.
5. When iterating, modify only the requested parts.
6. For large architectures, prefer multiple smaller diagrams rather than one dense diagram.

---

# RENDERING STABILITY PRINCIPLES

Avoid:

• splines=ortho  
• excessive invisible edges  
• cluster-to-cluster edges  
• long edge labels  
• deeply nested clusters  

Prefer:

• node-to-node edges  
• layered architecture layouts  
• balanced cluster sizes  
• forward flow diagrams  
• smooth spline routing  

Following these guidelines ensures diagrams render consistently across Kroki and Graphviz.
`;

/**
 * Builds the instructions string for the MCP initialize response.
 * Appends ~/.canopy/preferences.md if it exists, allowing users to override
 * or extend the defaults without modifying the server.
 *
 * @returns {string}
 */
function buildInstructions() {
  let instructions = DEFAULT_INSTRUCTIONS;
  if (fs.existsSync(PREFERENCES_FILE)) {
    try {
      const prefs = fs.readFileSync(PREFERENCES_FILE, "utf8").trim();
      if (prefs) {
        instructions += `\n\n---\n\n## USER PREFERENCES\n\n${prefs}`;
      }
    } catch {
      // Ignore — default instructions still apply
    }
  }
  return instructions;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "canopy", version: "1.0.0" },
  { instructions: buildInstructions() },
);

// Stable protocol constants for ext-apps inline preview.
// RESOURCE_MIME_TYPE is the wire-level MIME type defined by the MCP Apps spec —
// hardcoding it avoids an ESM dynamic import of @modelcontextprotocol/ext-apps
// from this CJS module. Non-UI MCP clients ignore _meta and structuredContent entirely.
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const PREVIEW_RESOURCE_URI = "ui://canopy/preview";

// ------ get_diagram_preferences ---------------------------------------------

server.registerTool(
  "get_diagram_preferences",
  {
    description:
      "Returns the diagram style guide and format selection rules to apply when generating diagrams. Call this at the start of any diagram-related conversation.",
    inputSchema: z.object({}),
  },
  async () => ({
    content: [{ type: "text", text: buildInstructions() }],
  }),
);

// ------ search_diagrams -----------------------------------------------------

server.registerTool(
  "search_diagrams",
  {
    description:
      "Search previously rendered diagrams by title keyword across all sessions. " +
      "Returns matching diagrams with preview URLs.",
    inputSchema: z.object({
      query: z.string().describe("Keyword to search in diagram titles."),
    }),
  },
  async ({ query }) => {
    loadRegistry();
    const q = query.toLowerCase();
    const results = [...fileRegistry.entries()]
      .filter(([, entry]) => entry.title?.toLowerCase().includes(q))
      .filter(([, entry]) => fs.existsSync(entry.filePath))
      .map(([id, entry]) => ({
        id,
        title: entry.title,
        previewUrl: `${previewBaseUrl()}/?id=${id}`,
        createdAt: entry.createdAt ?? null,
      }))
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

    if (results.length === 0) {
      return {
        content: [
          { type: "text", text: `No diagrams found matching "${query}".` },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  },
);

// ------ list_supported_types ------------------------------------------------

server.registerTool(
  "list_supported_types",
  {
    description:
      "List all supported Kroki diagram types with their file extensions and output formats.",
    inputSchema: z.object({}),
  },
  async () => {
    const byType = Object.entries(KROKI_TYPE).reduce((acc, [ext, type]) => {
      acc[type] = acc[type] ? `${acc[type]}, ${ext}` : ext;
      return acc;
    }, {});

    const mdByType = Object.entries(MARKDOWN_LANG).reduce(
      (acc, [lang, type]) => {
        acc[type] = acc[type] ? `${acc[type]}, ${lang}` : lang;
        return acc;
      },
      {},
    );

    const lines = Object.entries(byType).map(
      ([type, exts]) =>
        `${type.padEnd(14)} ext: ${exts.padEnd(36)} output: ${(OUTPUT_FORMAT[type] ?? "png").padEnd(4)}  md: ${mdByType[type] ?? type}`,
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ------ get_diagram_image (app-only) ----------------------------------------
// Called by the App client (iframe) via app.callServerTool() — not by the LLM.
// Returns the image bytes as base64 so the iframe can display them as a data URL
// without making any HTTP requests (bypasses iframe sandbox restrictions entirely).

server.registerTool(
  "get_diagram_image",
  {
    description:
      "Internal helper: returns a rendered diagram's image data for the preview widget. " +
      "Not intended for direct use — the diagram preview widget calls this automatically.",
    inputSchema: z.object({
      id: z.string().describe("The diagram ID (hex string from the registry)."),
    }),
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ id }) => {
    loadRegistry();
    const entry = fileRegistry.get(id);
    if (!entry || !fs.existsSync(entry.filePath)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "not found" }) }],
        isError: true,
      };
    }
    const data = fs.readFileSync(entry.filePath);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ data: data.toString("base64"), mimeType: entry.mimeType }),
        },
      ],
    };
  },
);

// ------ render_diagram ------------------------------------------------------

/**
 * Reads the pre-built App client HTML from dist/src/mcp-app.html.
 * Built by `npm run build:ui` (Vite + vite-plugin-singlefile).
 * The bundled file is self-contained — no external CDN requests at runtime.
 *
 * @returns {string}
 */
function readPreviewHtml() {
  return fs.readFileSync(
    path.join(__dirname, "dist", "src", "mcp-app.html"),
    "utf-8",
  );
}

server.registerTool(
  "render_diagram",
  {
    description:
      "Render a diagram from source text. Returns a preview URL served from the local HTTP server. " +
      "IMPORTANT: Always share the preview URL directly with the user as a clickable link. " +
      "Do NOT attempt to embed, display, or render the image — it lives on the user's Mac filesystem, not in your container.",
    inputSchema: z.object({
      source: z.string().describe("The diagram source text."),
      type: z
        .string()
        .describe(
          "Kroki diagram type (e.g. plantuml, mermaid, graphviz, d2). Run list_supported_types for the full list.",
        ),
      title: z
        .string()
        .optional()
        .describe(
          "Short descriptive title for this diagram (stored for gallery and search).",
        ),
      output_path: z
        .string()
        .optional()
        .describe(
          "Where to save the output image. If omitted, saves to ~/.canopy/output/ (persistent).",
        ),
    }),
    _meta: { ui: { resourceUri: PREVIEW_RESOURCE_URI } },
  },
  async ({ source, type: diagramType, title, output_path }) => {
    const fmt = OUTPUT_FORMAT[diagramType] ?? "png";
    const mimeType = fmt === "svg" ? "image/svg+xml" : "image/png";

    // Allocate output path. User-provided paths are saved as-is (and registered);
    // if the path is unreachable (e.g. Claude sandbox paths) fall back to persistent store.
    let outputPath;
    let previewUrl;
    if (output_path) {
      try {
        outputPath = path.resolve(output_path);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        // Will register after render succeeds
      } catch {
        ({ filePath: outputPath, previewUrl } = allocateOutput(
          fmt,
          title ?? null,
        ));
      }
    } else {
      ({ filePath: outputPath, previewUrl } = allocateOutput(
        fmt,
        title ?? null,
      ));
    }

    const krokiUrl = await resolveKrokiUrl();

    try {
      const data = await krokiRender(source, diagramType, krokiUrl);
      fs.writeFileSync(outputPath, data);
      // Register user-provided path now that the file exists
      if (!previewUrl)
        previewUrl = registerFile(outputPath, mimeType, title ?? null);
      // Extract the hex ID from the gallery URL (?id=<id>) for the App client.
      const imageId = new URL(previewUrl).searchParams.get("id");
      return {
        content: [
          {
            type: "text",
            text:
              `Rendered ${diagramType} diagram (${fmt}).\n\n` +
              `Share this URL with the user so they can open it in their browser:\n` +
              `${previewUrl}\n\n` +
              `Gallery (all diagrams): ${previewBaseUrl()}/\n` +
              `(File saved at: ${outputPath})`,
          },
        ],
        // structuredContent is consumed by UI-capable clients (e.g. Claude Desktop).
        // imageId is fetched by the App client via app.callServerTool("get_diagram_image")
        // — no HTTP request from the iframe, no LLM token cost.
        structuredContent: { imageId, title: title ?? null },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Preview resource — consumed by UI-capable clients to render the inline iframe.
// The HTML is pre-built by `npm run build:ui` (Vite + vite-plugin-singlefile):
// all JS including the ext-apps App client is inlined. No external CDN needed,
// so no CSP configuration is required.
server.registerResource(
  "Canopy Diagram Preview",
  PREVIEW_RESOURCE_URI,
  { mimeType: RESOURCE_MIME_TYPE },
  async () => ({
    contents: [
      {
        uri: PREVIEW_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: readPreviewHtml(),
      },
    ],
  }),
);

// ------ render_file ---------------------------------------------------------

server.registerTool(
  "render_file",
  {
    description:
      "Render a diagram source file from disk. Returns preview URL(s) for each rendered image. " +
      "IMPORTANT: Always share the preview URL(s) directly with the user as clickable links. " +
      "Do NOT attempt to embed or render the image. Supports all diagram formats and .md files with embedded diagram blocks.",
    inputSchema: z.object({
      file_path: z
        .string()
        .describe(
          "Absolute path to the diagram source file (.puml, .mmd, .md, etc.).",
        ),
      title: z
        .string()
        .optional()
        .describe(
          "Short descriptive title for this diagram (stored for gallery and search). Defaults to the source filename.",
        ),
      output_dir: z
        .string()
        .optional()
        .describe(
          "Directory to write the output image(s) to. Defaults to ~/.canopy/output/ (persistent).",
        ),
    }),
  },
  async ({ file_path, title, output_dir }) => {
    const resolvedInput = path.resolve(file_path);

    if (!fs.existsSync(resolvedInput)) {
      return {
        content: [
          { type: "text", text: `Error: File not found: ${resolvedInput}` },
        ],
        isError: true,
      };
    }

    const ext = path.extname(resolvedInput);
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Unsupported extension: ${ext}. Run list_supported_types for supported formats.`,
          },
        ],
        isError: true,
      };
    }

    let outDir;
    if (output_dir) {
      try {
        outDir = path.resolve(output_dir);
        fs.mkdirSync(outDir, { recursive: true });
      } catch {
        outDir = OUTPUT_DIR;
      }
    } else {
      outDir = OUTPUT_DIR;
    }
    fs.mkdirSync(outDir, { recursive: true });

    const krokiUrl = await resolveKrokiUrl();

    try {
      if (ext === ".md") {
        const result = await renderMarkdownFile(
          resolvedInput,
          outDir,
          krokiUrl,
        );
        const validPaths = result.outputs.filter(Boolean);
        const mdBase = path.basename(resolvedInput, ".md");
        const lines = validPaths.map((p) => {
          const fmt = path.extname(p).slice(1);
          const mime = fmt === "svg" ? "image/svg+xml" : "image/png";
          const blockName = path.basename(p, `.${fmt}`);
          const entryTitle = title
            ? `${title} — ${blockName}`
            : `${mdBase} — ${blockName}`;
          const url = registerFile(p, mime, entryTitle);
          return `  ${path.basename(p)}  →  ${url}`;
        });
        const summary =
          `Rendered ${result.ok} diagram(s) from ${path.basename(resolvedInput)}` +
          (result.failed > 0 ? ` (${result.failed} failed)` : "") +
          ":";
        return {
          content: [{ type: "text", text: `${summary}\n${lines.join("\n")}` }],
        };
      } else {
        const diagramType = KROKI_TYPE[ext];
        const fmt = OUTPUT_FORMAT[diagramType] ?? "png";
        const mimeType = fmt === "svg" ? "image/svg+xml" : "image/png";
        const outName = `${path.basename(resolvedInput, ext)}.${fmt}`;
        const outputPath = path.join(outDir, outName);
        const source = fs.readFileSync(resolvedInput, "utf8");
        const data = await krokiRender(source, diagramType, krokiUrl);
        fs.writeFileSync(outputPath, data);
        const fileTitle = title ?? path.basename(resolvedInput, ext);
        const previewUrl = registerFile(outputPath, mimeType, fileTitle);
        return {
          content: [
            {
              type: "text",
              text:
                `Rendered ${diagramType} (${fmt}).\n\n` +
                `Share this URL with the user so they can open it in their browser:\n` +
                `${previewUrl}\n\n` +
                `Gallery (all diagrams): ${previewBaseUrl()}/\n` +
                `(File saved at: ${outputPath})`,
            },
          ],
        };
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ------ rename_diagram ------------------------------------------------------

server.registerTool(
  "rename_diagram",
  {
    description:
      "Rename a previously rendered diagram by its ID. Use search_diagrams to find the ID. " +
      "Useful for giving titles to diagrams that were rendered without one.",
    inputSchema: z.object({
      id: z
        .string()
        .describe("The diagram ID (short hex string from a preview URL)."),
      title: z.string().describe("New title for the diagram."),
    }),
  },
  async ({ id, title }) => {
    loadRegistry();
    const entry = fileRegistry.get(id);
    if (!entry) {
      return {
        content: [
          { type: "text", text: `Error: No diagram found with ID "${id}".` },
        ],
        isError: true,
      };
    }
    fileRegistry.set(id, { ...entry, title });
    persistRegistry();
    return {
      content: [{ type: "text", text: `Renamed diagram ${id} to "${title}".` }],
    };
  },
);

// ------ delete_diagram ------------------------------------------------------

server.registerTool(
  "delete_diagram",
  {
    description:
      "Delete a previously rendered diagram by its ID, removing it from the registry and from disk. " +
      "Use search_diagrams to find the ID.",
    inputSchema: z.object({
      id: z
        .string()
        .describe("The diagram ID (short hex string from a preview URL)."),
    }),
  },
  async ({ id }) => {
    loadRegistry();
    const entry = fileRegistry.get(id);
    if (!entry) {
      return {
        content: [
          { type: "text", text: `Error: No diagram found with ID "${id}".` },
        ],
        isError: true,
      };
    }
    const label = entry.title ?? id;
    fileRegistry.delete(id);
    persistRegistry();
    try {
      if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath);
    } catch {
      // File already gone — registry is still cleaned up
    }
    return {
      content: [{ type: "text", text: `Deleted diagram "${label}" (${id}).` }],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const idx = process.argv.indexOf("--kroki-url");
  if (idx !== -1 && process.argv[idx + 1]) {
    process.env.DIAGRAM_RENDER_KROKI_URL = process.argv[idx + 1];
  }

  // Ensure persistent storage dirs exist and restore registry from last run
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  loadRegistry();

  await startHttpServer(HTTP_PORT_START);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
