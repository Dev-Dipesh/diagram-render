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
 *   render_diagram       - Render diagram source text, save to file, return path.
 *   render_file          - Render a diagram file on disk, return output path(s).
 *   list_supported_types - List all Kroki diagram types and their file extensions.
 *
 * Server selection (non-interactive):
 *   Tries local Kroki at http://localhost:8000 first.
 *   Falls back to https://kroki.io automatically if local is unavailable.
 *   Override with DIAGRAM_RENDER_KROKI_URL env var or --kroki-url flag.
 */

"use strict";

const fs = require("node:fs");
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

// ---------------------------------------------------------------------------
// Kroki URL resolution — no stdin, resolved per-call
// ---------------------------------------------------------------------------

/** Returns the Kroki base URL to use. No stdin prompts. */
async function resolveKrokiUrl() {
  if (process.env.DIAGRAM_RENDER_KROKI_URL) {
    return process.env.DIAGRAM_RENDER_KROKI_URL;
  }
  const localUp = await checkLocalServer(LOCAL_URL);
  return localUp ? LOCAL_URL : PUBLIC_URL;
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
    description: "Render a diagram from source text. Saves the output image to a file and returns the file path.",
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

    // Resolve output path — fall back to temp dir if the requested path is
    // unreachable (e.g. Claude's internal /mnt/user-data sandbox paths).
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
      const b64 = data.toString("base64");
      return {
        content: [
          {
            type: "text",
            text: `Rendered ${diagramType} diagram (${fmt}) → ${outputPath}\nKroki server: ${krokiUrl}\nDATA_URI: data:${mimeType};base64,${b64}`,
          },
          {
            type: "image",
            data: b64,
            mimeType,
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
      "Render a diagram source file from disk. Returns the path(s) of the generated image(s). Supports all diagram formats and .md files with embedded diagram blocks.",
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
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-render-"));
      }
    } else {
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-render-"));
    }

    const krokiUrl = await resolveKrokiUrl();

    try {
      if (ext === ".md") {
        const result = await renderMarkdownFile(resolvedInput, outDir, krokiUrl);
        const paths = result.outputs.filter(Boolean);
        const summary =
          `Rendered ${result.ok} diagram(s) from ${path.basename(resolvedInput)}.` +
          (result.failed > 0 ? ` ${result.failed} failed.` : "");
        const fileList = paths.map((p) => `  ${p}`).join("\n");
        return {
          content: [
            {
              type: "text",
              text: `${summary}\nKroki server: ${krokiUrl}\nOutput files:\n${fileList}`,
            },
          ],
        };
      } else {
        const diagramType = KROKI_TYPE[ext];
        const fmt = OUTPUT_FORMAT[diagramType] ?? "png";
        const outName = `${path.basename(resolvedInput, ext)}.${fmt}`;
        const outputPath = path.join(outDir, outName);
        const source = fs.readFileSync(resolvedInput, "utf8");
        const data = await krokiRender(source, diagramType, krokiUrl);
        fs.writeFileSync(outputPath, data);
        const mimeType = fmt === "svg" ? "image/svg+xml" : "image/png";
        const b64 = data.toString("base64");
        return {
          content: [
            {
              type: "text",
              text: `Rendered ${diagramType} (${fmt}) → ${outputPath}\nKroki server: ${krokiUrl}\nDATA_URI: data:${mimeType};base64,${b64}`,
            },
            {
              type: "image",
              data: b64,
              mimeType,
            },
          ],
        };
      }
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  // Allow --kroki-url flag to set the env var before any tool calls
  const idx = process.argv.indexOf("--kroki-url");
  if (idx !== -1 && process.argv[idx + 1]) {
    process.env.DIAGRAM_RENDER_KROKI_URL = process.argv[idx + 1];
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
