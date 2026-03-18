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
 *   get_diagram_preferences   - Returns format selection rules and the main visual style guide.
 *   get_excalidraw_preferences - Returns the Excalidraw-specific drawing guide.
 *   render_diagram            - Render diagram source text, returns a preview URL.
 *   render_file               - Render a diagram file on disk, returns preview URL(s).
 *   list_supported_types      - List all Kroki diagram types and their file extensions.
 *   search_diagrams           - Search previously rendered diagrams by title keyword.
 *   rename_diagram            - Rename a diagram in the registry by ID.
 *   delete_diagram            - Delete a diagram from the registry and disk by ID.
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
• apply a consistent visual system
• generate diagrams that render reliably
• keep diagrams readable and structurally stable
• prefer comprehension over density

Always prioritize:
- clarity
- layout stability
- visual consistency
- Kroki rendering reliability
- simple structures over clever layouts

---

# FORMAT SELECTION

Unless the user specifies a format, choose based on the diagram's intent.

| Diagram intent | Preferred format |
|---|---|
| High-level architecture with 6–18 nodes | plantuml |
| Agent runtime or control-plane flow | plantuml |
| Sequence / UML | plantuml |
| Quick documentation flowchart | mermaid |
| Linear pipeline with very few nodes | d2 |
| Dense architecture with many crossings and grouped subsystems | graphviz |
| Network topology | nwdiag / rackdiag / packetdiag |
| Business process flow | bpmn |
| Database schema | erd |

Decision shortcuts:

Layered architecture → plantuml  
Agent coordination → plantuml  
Sequence / timeline → plantuml  
Simple quick flowchart → mermaid  
If layout becomes too dense for plantuml → graphviz  

If ambiguous:
architecture → plantuml  
pipeline → plantuml  

Do not default to graphviz for architecture diagrams anymore.
Use graphviz only when its automatic ranking/clustering is genuinely needed.

If the user explicitly wants a hand-drawn Excalidraw-style diagram, animation, camera moves, restoreCheckpoint, or delete-based transformations, call **get_excalidraw_preferences** first.

---

# VISUAL STYLE GUIDE

### Canvas

Background  
#FEFDF6

Flat design  
No shadows  
Generous spacing between layers and clusters  
Avoid crowded diagrams intended for articles or social posts

---

# COLOR SYSTEM

Assign color by structural role.

| Role | Fill | Stroke | Text |
|---|---|---|---|
| Entry / Input | #FFFFFF | #AAAAAA | #333333 |
| Transform / Process | #FFF9C4 | #F9A825 | #5D4037 |
| Compute / Execute | #BBDEFB | #1565C0 | #0D3C6E |
| Storage / Persist | #E1BEE7 | #6A1B9A | #4A1070 |
| Orchestrate / Route | #B2EBF2 | #00838F | #004D56 |
| Validate / Control | #C8E6C9 | #388E3C | #1B5E20 |
| Evaluate / Output | #FFE0B2 | #E65100 | #7C3200 |
| Alert / Exception | #F8BBD0 | #E53935 | #A31515 |
| Auxiliary / Optional | #F5F5F5 | #9E9E9E | #555555 |

Inner nodes inside clusters should use lighter versions of the cluster color.

---

# LABELING, TITLES, LEGENDS, NUMBERING

Use a diagram title when the diagram will be shared, embedded in docs, or used in an article.

Examples:
- title High-Level Coaching Runtime
- title Memory Architecture
- title Control Plane Repair Loop

Add a small legend when at least one of these is true:
- colors carry semantic meaning
- stereotypes like <<Agent>> appear
- there are multiple node classes and the distinction is not obvious
- a few nodes are conceptually important but hard to explain inside the node label

Legend rules:
- keep it to 3–5 rows
- place it on the right or bottom
- do not let the legend become larger than the diagram itself
- prefer “why this matters” or “how to read this” over repeating color names
- do not waste legend space on information already obvious from cluster titles
- avoid legends that merely restate the visible labels
- if the reader is likely to ask “what does this box actually do?”, use the legend to answer that
- if colors are already obvious from package titles, use the legend for semantics, reading hints, or node purpose instead

Self-sustaining diagram rules:
- the diagram should stand on its own without requiring the reader to inspect source code
- avoid file paths, repo folders, route names, and implementation filenames unless explicitly requested
- avoid labels like `foo.ts`, `/api/bar`, `lib/x`, or regex-like identifiers in public-facing diagrams
- prefer architecture meaning over code provenance
- if a node is non-obvious, explain it with a short subtitle in the node or a compact legend row
- include code-level names only when the user explicitly wants implementation mapping or when source attribution is the point of the diagram

Use numbering only when order matters.
Good cases:
- ordered runtime stages
- stepwise data flow
- escalation / fallback path
- diagrams where the reader may not know where to start

Numbering rules:
- prefer 3–7 major steps
- number either node labels or edge labels, not both
- do not number every single edge in a dense diagram
- for complex architecture diagrams, prefer numbering the main arrows of the primary reading path
- use numbering sparingly to create an obvious entry point, not to annotate every relationship
- if a reader could plausibly ask “where should I start?”, add light numbering to the main path

---

# SHAPES

Nodes  
rounded rectangle

Corner radius  
8–12

Cluster border  
2px

Storage nodes  
use simple rectangles unless the user explicitly wants cylinders or UML-specific shapes

No shadows.

---

# EDGE STYLE

Primary flow  
solid  
#444444  
1.5px

Secondary flow  
solid  
#767676  
1px

Exception / fallback path  
dashed  
#E53935 or #555555  
1.5–2px

Edge label rules:
- maximum 2–3 words
- short action-oriented labels
- centered when possible
- avoid long prose on edges

Examples:
- turn
- tool plan
- evidence
- repair
- updates
- best draft

---

# TYPOGRAPHY

Font  
Arial

Title  
14–16pt bold

Cluster title  
13pt bold

Node label  
11–12pt bold

Edge label  
10pt

Never use white text on pastel fills.

---

# LAYOUT PRINCIPLES

Default architecture layout  
left-to-right for pipelines and runtime stages

top-to-bottom only when the story is clearly layered and vertical reading improves comprehension

Preferred reading order:
entry / context → orchestration → reasoning / execution → control → output

For article-quality diagrams:
- keep the main spine obvious
- keep side branches short
- avoid diagonal spaghetti
- avoid backtracking arrows unless showing repair/fallback intentionally

Spacing:
- prefer fewer, larger nodes over many tiny nodes
- keep 8–14 visible nodes in one diagram when possible
- if you exceed ~18 nodes or ~4 major clusters, split into multiple diagrams

---

# BREAK DOWN COMPLEX ARCHITECTURES

Do not force a large architecture into one dense image.

Prefer a family of smaller diagrams instead:
1. high-level system architecture
2. runtime / control-plane flow
3. memory architecture
4. artifact / tool path
5. capability snapshot

This almost always improves:
- rendering stability
- reader comprehension
- social-post readability
- iteration speed

If the user wants a LinkedIn post, article image, slide, or executive-friendly diagram, bias strongly toward multiple smaller sub-diagrams.

---

# PLANTUML DEFAULTS

PlantUML is now the preferred default for architecture and agent-system diagrams.

Start with:
- @startuml
- !theme plain
- skinparam backgroundColor #FEFDF6
- skinparam defaultFontName Arial
- skinparam RoundCorner 10
- skinparam shadowing false
- skinparam packageStyle rectangle

Safe structure that renders reliably:
- rectangle \"Label\" as alias #Color
- package \"Group\" #Color { ... }
- simple arrows between aliases
- optional legend right
- optional stereotypes like <<Agent>>
- left to right direction for most architecture/runtime diagrams
- optional `skinparam rectangle { BorderThickness 1 }`
- optional `skinparam package { BorderThickness 2 }`

Preferred node patterns:
- rectangle \"Planner\" <<Agent>> as planner #B2EBF2
- rectangle \"Tool Execution\" as tools #FFF9C4
- package \"Memory\" #F3E5F5 { ... }

PlantUML reliability rules:
- use short aliases
- keep packages shallow
- prefer rectangles and packages over fancy UML shapes unless required
- keep legends compact
- keep labels short
- keep one main spine with a few side branches
- prefer plain color literals like `#FFF9C4` over advanced inline style syntax
- prefer simple labels over markup-heavy labels
- if the diagram is explanatory, put the explanation in the node text or legend, not in code-level footnotes
- when a node needs more context, use one short subtitle line rather than a long note block
- if a diagram is meant for understanding rather than implementation lookup, bias toward plain English labels

PlantUML syntax safety rules:
- avoid semicolon-based inline style fragments such as `#color;line:...;text:...` unless already proven to work in the current renderer
- avoid features that differ across PlantUML versions unless necessary
- avoid `skinparam handwritten true`; use `!option handwritten true` only when handwritten mode is explicitly wanted
- avoid bracket-heavy labels and code-like syntax when natural language works
- avoid large note blocks when a compact legend or subtitle will do
- after a syntax failure, simplify toward rectangles, packages, simple arrows, and plain color literals
- if a diagram must be robust across environments, bias toward the same minimal syntax used in known-good local examples
- when introducing a new styling trick, prefer testing a small safe subset first rather than applying it across the whole diagram

Avoid when not necessary:
- external includes
- sprites and icon libraries
- complex macros
- deeply nested packages
- large note blocks
- crowded C4 diagrams for social content
- overly clever skinparam tricks

---

# GRAPHVIZ GUIDELINES

Graphviz is now secondary, not default.

Use it when:
- the user explicitly asks for graphviz
- the diagram genuinely needs automatic ranking/clustering across many grouped nodes
- PlantUML would become too rigid or too manual

Graphviz defaults:
- compound=true
- splines=true
- nodesep=0.6
- ranksep=0.8
- pad=0.4
- margin=0.2

Never use:
- splines=ortho

Graphviz stability rules:
- prefer node-to-node edges
- avoid cluster-to-cluster edges
- avoid long edge labels
- avoid very large clusters
- break up dense graphs into multiple diagrams

If edges or labels start overlapping, do not keep forcing the layout. Split the diagram.

---

# D2 GUIDELINES

Use D2 mainly for very simple linear pipelines.

Defaults:
- direction: right or down
- style.border-radius: 10
- style.bold: true

If the pipeline starts to branch heavily, switch to PlantUML.

D2 syntax safety rules:
- prefer a small, conservative subset of D2 syntax
- use direct style properties such as `font-size`, `font-color`, and `bold`
- do not use nested font objects like `font: { family: ..., size: ..., bold: ... }`
- do not use `color` when the intent is text color; use `font-color`
- do not assume font-family is supported in D2 style blocks
- if a D2 diagram fails to render, simplify toward direct nodes, containers, direct arrows, and flat style properties

Safe D2 style examples:
- `font-size: 18`
- `font-color: "#333333"`
- `bold: true`
- `border-radius: 10`
- `shadow: false`

Avoid in D2 unless already proven locally:
- `font: { family: "Arial", size: 18, bold: true }`
- `color: "#333333"` for text color
- complex variable indirection when a literal works

---

# MERMAID GUIDELINES

Use Mermaid for quick documentation flowcharts.
Do not use it for dense architecture diagrams if PlantUML would be clearer.

---

# PRE-RENDER REASONING STEP

Before generating any diagram:
1. identify the main components
2. identify the main spine or reading path
3. decide whether this should be one diagram or several
4. keep only the components needed for the current diagram's story
5. choose the simplest format that will render cleanly
6. add title / legend / numbering only if they improve comprehension
7. make the diagram self-sufficient: a technically literate reader should not need the codebase open to follow it

---

# BEHAVIOR RULES

1. State the chosen format and one-line reason unless the user fixed the format.
2. Render immediately.
3. If syntax fails, simplify and retry automatically.
4. Prefer PlantUML over Graphviz for architecture diagrams unless there is a strong reason not to.
5. For public-facing diagrams, prefer simpler layouts over maximum fidelity.
6. If a diagram becomes crowded, proactively split it into smaller diagrams.
7. When the user asks for Excalidraw-style output, call get_excalidraw_preferences first.
8. For explanatory architecture diagrams, optimize for self-sufficiency: the diagram should answer the first-order “what is this?” questions on its own.

---

# RENDERING STABILITY PRINCIPLES

Avoid:
- dense all-in-one diagrams
- deep nesting
- long edge labels
- fancy features when plain rectangles work
- Graphviz overuse for diagrams better expressed in PlantUML

Prefer:
- one clear main spine
- a few meaningful side branches
- small legends
- simple rectangles and packages
- multiple focused diagrams over one overloaded diagram
- PlantUML for readable architecture storytelling

Following these guidelines improves both Kroki reliability and reader comprehension.
`;

const EXCALIDRAW_INSTRUCTIONS = `\
Use this guide only when the user explicitly wants Excalidraw, a hand-drawn whiteboard style, camera-guided animation, restoreCheckpoint flows, or delete-based transformations.

# WHEN TO USE EXCALIDRAW

Use Excalidraw when the goal is:
- sketch-like storytelling
- stepwise reveal with cameraUpdate
- before/after transformations
- animated build-up of an explanation
- a whiteboard feel rather than a polished architecture plate

Do not default to Excalidraw for normal architecture diagrams. Prefer PlantUML first.

# CORE ELEMENT RULES

Required on all drawn elements:
- type
- id (unique string)
- x
- y
- width
- height

Prefer labeled shapes over separate text whenever possible.
Example:
{ \"type\": \"rectangle\", \"id\": \"r1\", \"x\": 100, \"y\": 100, \"width\": 200, \"height\": 80, \"label\": { \"text\": \"Planner\", \"fontSize\": 20 } }

Use standalone text only for:
- titles
- subtitles
- annotations

# COLOR PALETTE

Primary colors:
- Blue #4a9eed
- Amber #f59e0b
- Green #22c55e
- Red #ef4444
- Purple #8b5cf6
- Pink #ec4899
- Cyan #06b6d4
- Lime #84cc16

Pastel fills:
- Light Blue #a5d8ff
- Light Green #b2f2bb
- Light Orange #ffd8a8
- Light Purple #d0bfff
- Light Red #ffc9c9
- Light Yellow #fff3bf
- Light Teal #c3fae8
- Light Pink #eebefa

Background zones with opacity 30:
- Blue zone #dbe4ff for UI / frontend
- Purple zone #e5dbff for logic / agent layer
- Green zone #d3f9d8 for data / tool layer

# CAMERA AND SIZING

Always start with a cameraUpdate as the first element.
Use only 4:3 cameras:
- 400x300
- 600x450
- 800x600
- 1200x900
- 1600x1200

Recommended defaults:
- 800x600 for a standard full diagram
- 600x450 for a focused section

Font sizes:
- minimum 16 for body labels
- minimum 20 for titles
- minimum 14 only for secondary annotations

Minimum labeled shape size:
- 120x60

Leave 20–30px gaps between elements.
Prefer fewer, larger elements over many tiny ones.

# DRAWING ORDER

Array order is z-order and streaming order.
Emit progressively:
- background zones
- shape
- its label
- its arrows
- next shape

Good pattern:
- cameraUpdate
- zone
- node 1
- node 2
- arrow 1
- node 3
- arrow 2

Do not emit:
- all rectangles first
- all texts second
- all arrows last

# ARROWS AND BINDINGS

Use labeled arrows for relationship text.
Keep labels short.
Use bindings where possible:
- right [1, 0.5]
- left [0, 0.5]
- top [0.5, 0]
- bottom [0.5, 1]

# TITLES, LEGENDS, NUMBERING

Add a title for public-facing diagrams.
Use standalone text for titles.

Add a small legend only if colors or zones carry semantic meaning.
Keep legends compact.

Use numbering only when order matters.
For Excalidraw, numbering usually works best inside labels or nearby small notes, not on every arrow.

# CHECKPOINTS AND TRANSFORMS

Use restoreCheckpoint when continuing from prior state.
Use delete to transform diagrams in place.
Never reuse deleted ids.

Excalidraw is especially strong for:
- animated transformations
- before/after comparisons
- walkthrough diagrams that reveal one section at a time

# DARK MODE

If the user asks for dark mode:
- place a very large dark background rectangle first
- use light text and brighter strokes
- never use low-contrast gray text on dark backgrounds

# PRACTICAL CANOPY GUIDANCE

For Canopy specifically:
- use Excalidraw only when the user wants a hand-drawn feel or staged reveal
- otherwise prefer PlantUML for architecture clarity
- keep the scene readable in inline preview, not just fullscreen
- use camera moves to guide attention rather than making one giant scene
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
      "Returns the main diagram style guide and format selection rules to apply when generating diagrams. Call this at the start of any diagram-related conversation unless you specifically need the Excalidraw guide.",
    inputSchema: z.object({}),
  },
  async () => ({
    content: [{ type: "text", text: buildInstructions() }],
  }),
);

// ------ get_excalidraw_preferences ------------------------------------------

server.registerTool(
  "get_excalidraw_preferences",
  {
    description:
      "Returns the Excalidraw-specific design guide for hand-drawn diagrams, camera-guided reveals, restoreCheckpoint flows, and delete-based transformations.",
    inputSchema: z.object({}),
  },
  async () => ({
    content: [{ type: "text", text: EXCALIDRAW_INSTRUCTIONS }],
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
