#!/usr/bin/env node
/**
 * mcp.cjs
 * -------
 * MCP server exposing diagram-render as tools for AI apps (Claude Code, Claude Desktop).
 *
 * Runs over stdio — configure in your MCP client:
 *   { "command": "node", "args": ["/path/to/diagram-render/mcp.cjs"] }
 *
 * Tools:
 *   render_diagram       - Render diagram source text, returns a preview URL.
 *   render_file          - Render a diagram file on disk, returns preview URL(s).
 *   list_supported_types - List all Kroki diagram types and their file extensions.
 *
 * HTTP file server (same process, loopback only):
 *   GET http://127.0.0.1:8765/<id>   → serves a rendered image by short ID
 *   POST http://127.0.0.1:8765/render { source, type } → raw image bytes (direct render)
 *   IDs are in-memory only — they reset when the server restarts.
 *   Port override: DIAGRAM_RENDER_HTTP_PORT env var.
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

const HTTP_PORT = parseInt(process.env.DIAGRAM_RENDER_HTTP_PORT ?? "17432", 10);

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
// ---------------------------------------------------------------------------

/** id → { filePath, mimeType } */
const fileRegistry = new Map();

/**
 * Registers a rendered file and returns its preview URL.
 * @param {string} filePath - Absolute path to the rendered file.
 * @param {string} mimeType - MIME type (image/png or image/svg+xml).
 * @returns {string} Preview URL, e.g. http://127.0.0.1:8765/a1b2c3d4e5f6
 */
function registerFile(filePath, mimeType) {
  const id = crypto.randomBytes(6).toString("hex");
  fileRegistry.set(id, { filePath, mimeType });
  return `http://127.0.0.1:${HTTP_PORT}/${id}`;
}

// ---------------------------------------------------------------------------
// HTTP server — serves registered files + direct render endpoint
// ---------------------------------------------------------------------------

function startHttpServer(port) {
  const srv = http.createServer((req, res) => {
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
  });

  srv.on("error", (err) => {
    process.stderr.write(`diagram-render HTTP server error (port ${port}): ${err.message}\n`);
  });

  srv.listen(port, "127.0.0.1", () => {
    process.stderr.write(`diagram-render HTTP server listening on http://127.0.0.1:${port}\n`);
  });

  return srv;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "diagram-render", version: "1.0.0" });

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
        "Where to save the output image. If omitted, saves to a temp file.",
      ),
    }),
  },
  async ({ source, type: diagramType, output_path }) => {
    const fmt = OUTPUT_FORMAT[diagramType] ?? "png";
    const mimeType = fmt === "svg" ? "image/svg+xml" : "image/png";

    let outputPath;
    if (output_path) {
      try {
        const resolved = path.resolve(output_path);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        outputPath = resolved;
      } catch {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-render-"));
        outputPath = path.join(tmpDir, `diagram.${fmt}`);
      }
    } else {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-render-"));
      outputPath = path.join(tmpDir, `diagram.${fmt}`);
    }

    const krokiUrl = await resolveKrokiUrl();

    try {
      const data = await krokiRender(source, diagramType, krokiUrl);
      fs.writeFileSync(outputPath, data);
      const previewUrl = registerFile(outputPath, mimeType);
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
        "Directory to write the output image(s) to. Defaults to a temp directory.",
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
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-render-"));
      }
    } else {
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-render-"));
    }

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

  startHttpServer(HTTP_PORT);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
