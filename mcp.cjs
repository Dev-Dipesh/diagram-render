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
 *   render_diagram       - Render diagram source text, returns a preview URL.
 *   render_file          - Render a diagram file on disk, returns preview URL(s).
 *   list_supported_types - List all Kroki diagram types and their file extensions.
 *
 * HTTP file server (same process, loopback only):
 *   GET http://127.0.0.1:<port>/<id>   → serves a rendered image by short ID
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

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
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

const HTTP_PORT_START = parseInt(process.env.DIAGRAM_RENDER_HTTP_PORT ?? "17432", 10);

/** Actual bound port — set by startHttpServer(), used by registerFile(). */
let httpPort = null;

// ---------------------------------------------------------------------------
// Persistent storage paths
// ---------------------------------------------------------------------------

const HOME_DIR = path.join(os.homedir(), ".canopy");
const OUTPUT_DIR = path.join(HOME_DIR, "output");
const REGISTRY_FILE = path.join(HOME_DIR, "registry.json");
const PID_FILE = path.join(HOME_DIR, "server.pid");

// ---------------------------------------------------------------------------
// Singleton enforcement — kill any previous instance before starting
// ---------------------------------------------------------------------------

function killPreviousInstance() {
  if (!fs.existsSync(PID_FILE)) return;
  try {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      process.kill(oldPid, "SIGTERM");
      process.stderr.write(`canopy: killed previous instance (pid ${oldPid})\n`);
    }
  } catch {
    // Process already dead — that's fine
  }
  fs.rmSync(PID_FILE, { force: true });
}

function writePidFile() {
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
  const cleanup = () => fs.rmSync(PID_FILE, { force: true });
  process.once("exit", cleanup);
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
  process.once("SIGINT", () => { cleanup(); process.exit(0); });
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
    process.stderr.write(`canopy: registry loaded (${fileRegistry.size} entries)\n`);
  } catch {
    process.stderr.write("canopy: could not read registry, starting fresh\n");
  }
}

/** Writes the current in-memory registry to disk. */
function persistRegistry() {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(Object.fromEntries(fileRegistry), null, 2), "utf8");
}

/**
 * Registers a user-provided file path and returns its preview URL.
 * Use allocateOutput() instead when no explicit path is given.
 *
 * @param {string} filePath - Absolute path to the rendered file.
 * @param {string} mimeType - MIME type (image/png or image/svg+xml).
 * @returns {string} Preview URL.
 */
function registerFile(filePath, mimeType) {
  const id = crypto.randomBytes(6).toString("hex");
  fileRegistry.set(id, { filePath, mimeType });
  persistRegistry();
  return `http://127.0.0.1:${httpPort}/${id}`;
}

/**
 * Allocates a persistent output path under ~/.canopy/output/,
 * pre-registers it, and returns the file path and preview URL together.
 * The file doesn't exist yet — caller must write it before the URL is useful.
 *
 * @param {string} fmt - File extension without dot (e.g. "png", "svg").
 * @returns {{ filePath: string, previewUrl: string }}
 */
function allocateOutput(fmt) {
  const id = crypto.randomBytes(6).toString("hex");
  const mimeType = fmt === "svg" ? "image/svg+xml" : "image/png";
  const filePath = path.join(OUTPUT_DIR, `${id}.${fmt}`);
  fileRegistry.set(id, { filePath, mimeType });
  persistRegistry();
  return { filePath, previewUrl: `http://127.0.0.1:${httpPort}/${id}` };
}

// ---------------------------------------------------------------------------
// HTTP server — serves registered files + direct render endpoint
// ---------------------------------------------------------------------------

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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /<id> — serve a previously rendered file
    if (req.method === "GET" && req.url && req.url.length > 1) {
      const id = req.url.slice(1);
      const entry = fileRegistry.get(id);
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
          res.writeHead(200, { "Content-Type": mimeType, "Content-Length": data.length });
          res.end(data);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  };

  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryBind = () => {
      const srv = http.createServer(handler);
      srv.once("error", (err) => {
        if (err.code === "EADDRINUSE" && attempts < 10) {
          attempts++;
          process.stderr.write(`canopy: port ${port} still in use, retrying (${attempts}/10)…\n`);
          setTimeout(tryBind, 200);
        } else {
          reject(err);
        }
      });
      srv.listen(port, "127.0.0.1", () => {
        httpPort = port;
        process.stderr.write(`canopy HTTP server listening on http://127.0.0.1:${port}\n`);
        resolve();
      });
    };
    tryBind();
  });
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "canopy", version: "1.0.0" });

// ------ list_supported_types ------------------------------------------------

server.registerTool(
  "list_supported_types",
  {
    description: "List all supported Kroki diagram types with their file extensions and output formats.",
    inputSchema: z.object({}),
  },
  async () => {
    const byType = Object.entries(KROKI_TYPE).reduce((acc, [ext, type]) => {
      acc[type] = acc[type] ? `${acc[type]}, ${ext}` : ext;
      return acc;
    }, {});

    const mdByType = Object.entries(MARKDOWN_LANG).reduce((acc, [lang, type]) => {
      acc[type] = acc[type] ? `${acc[type]}, ${lang}` : lang;
      return acc;
    }, {});

    const lines = Object.entries(byType).map(([type, exts]) =>
      `${type.padEnd(14)} ext: ${exts.padEnd(36)} output: ${(OUTPUT_FORMAT[type] ?? "png").padEnd(4)}  md: ${mdByType[type] ?? type}`,
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ------ render_diagram ------------------------------------------------------

server.registerTool(
  "render_diagram",
  {
    description:
      "Render a diagram from source text. Returns a preview URL served from the local HTTP server. " +
      "IMPORTANT: Always share the preview URL directly with the user as a clickable link. " +
      "Do NOT attempt to embed, display, or render the image — it lives on the user's Mac filesystem, not in your container.",
    inputSchema: z.object({
      source: z.string().describe("The diagram source text."),
      type: z.string().describe(
        "Kroki diagram type (e.g. plantuml, mermaid, graphviz, d2). Run list_supported_types for the full list.",
      ),
      output_path: z.string().optional().describe(
        "Where to save the output image. If omitted, saves to ~/.canopy/output/ (persistent).",
      ),
    }),
  },
  async ({ source, type: diagramType, output_path }) => {
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
        ({ filePath: outputPath, previewUrl } = allocateOutput(fmt));
      }
    } else {
      ({ filePath: outputPath, previewUrl } = allocateOutput(fmt));
    }

    const krokiUrl = await resolveKrokiUrl();

    try {
      const data = await krokiRender(source, diagramType, krokiUrl);
      fs.writeFileSync(outputPath, data);
      // Register user-provided path now that the file exists
      if (!previewUrl) previewUrl = registerFile(outputPath, mimeType);
      return {
        content: [
          {
            type: "text",
            text:
              `Rendered ${diagramType} diagram (${fmt}).\n\n` +
              `Share this URL with the user so they can open it in their browser:\n` +
              `${previewUrl}\n\n` +
              `(File saved at: ${outputPath})`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
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
      file_path: z.string().describe(
        "Absolute path to the diagram source file (.puml, .mmd, .md, etc.).",
      ),
      output_dir: z.string().optional().describe(
        "Directory to write the output image(s) to. Defaults to ~/.canopy/output/ (persistent).",
      ),
    }),
  },
  async ({ file_path, output_dir }) => {
    const resolvedInput = path.resolve(file_path);

    if (!fs.existsSync(resolvedInput)) {
      return {
        content: [{ type: "text", text: `Error: File not found: ${resolvedInput}` }],
        isError: true,
      };
    }

    const ext = path.extname(resolvedInput);
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return {
        content: [{
          type: "text",
          text: `Error: Unsupported extension: ${ext}. Run list_supported_types for supported formats.`,
        }],
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
        const result = await renderMarkdownFile(resolvedInput, outDir, krokiUrl);
        const validPaths = result.outputs.filter(Boolean);
        const lines = validPaths.map((p) => {
          const fmt = path.extname(p).slice(1);
          const mime = fmt === "svg" ? "image/svg+xml" : "image/png";
          const url = registerFile(p, mime);
          return `  ${path.basename(p)}  →  ${url}`;
        });
        const summary =
          `Rendered ${result.ok} diagram(s) from ${path.basename(resolvedInput)}` +
          (result.failed > 0 ? ` (${result.failed} failed)` : "") + ":";
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
        const previewUrl = registerFile(outputPath, mimeType);
        return {
          content: [
            {
              type: "text",
              text:
                `Rendered ${diagramType} (${fmt}).\n\n` +
                `Share this URL with the user so they can open it in their browser:\n` +
                `${previewUrl}\n\n` +
                `(File saved at: ${outputPath})`,
            },
          ],
        };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
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
  killPreviousInstance();
  writePidFile();
  loadRegistry();

  await startHttpServer(HTTP_PORT_START);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
