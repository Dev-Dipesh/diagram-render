/**
 * lib/renderer.cjs
 * ----------------
 * Core rendering logic shared by generate.cjs (CLI) and mcp.cjs (MCP server).
 * No process.exit, no stdin, no CLI-specific concerns.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

const LOCAL_URL = "http://localhost:8000";
const PUBLIC_URL = "https://kroki.io";

// Types that only support SVG output — requesting PNG returns HTTP 400.
const OUTPUT_FORMAT = {
  bpmn: "svg",
  bytefield: "svg",
  d2: "svg",
  excalidraw: "svg",
  nomnoml: "svg",
  pikchr: "svg",
  svgbob: "svg",
  wavedrom: "svg",
};

// Maps file extension -> Kroki diagram type (for individual source files).
const KROKI_TYPE = {
  // PlantUML
  ".puml": "plantuml",
  ".plantuml": "plantuml",
  // C4 with PlantUML
  ".c4puml": "c4plantuml",
  // Mermaid
  ".mmd": "mermaid",
  ".mermaid": "mermaid",
  // GraphViz
  ".dot": "graphviz",
  ".gv": "graphviz",
  // D2
  ".d2": "d2",
  // DBML
  ".dbml": "dbml",
  // DitAA
  ".ditaa": "ditaa",
  // Erd
  ".erd": "erd",
  // Excalidraw
  ".excalidraw": "excalidraw",
  // BlockDiag family
  ".blockdiag": "blockdiag",
  ".seqdiag": "seqdiag",
  ".actdiag": "actdiag",
  ".nwdiag": "nwdiag",
  ".packetdiag": "packetdiag",
  ".rackdiag": "rackdiag",
  // BPMN
  ".bpmn": "bpmn",
  // Bytefield
  ".bytefield": "bytefield",
  // Nomnoml
  ".nomnoml": "nomnoml",
  // Pikchr
  ".pikchr": "pikchr",
  // Structurizr
  ".dsl": "structurizr",
  // Svgbob
  ".bob": "svgbob",
  // Symbolator
  ".symbolator": "symbolator",
  // TikZ
  ".tikz": "tikz",
  // Vega
  ".vega": "vega",
  // Vega-Lite
  ".vegalite": "vegalite",
  // WaveDrom
  ".wavedrom": "wavedrom",
  // WireViz
  ".wireviz": "wireviz",
};

// Maps fenced code block language name -> Kroki diagram type (for .md files).
const MARKDOWN_LANG = {
  // PlantUML
  plantuml: "plantuml",
  puml: "plantuml",
  // C4 with PlantUML
  c4plantuml: "c4plantuml",
  c4: "c4plantuml",
  // Mermaid
  mermaid: "mermaid",
  // GraphViz
  dot: "graphviz",
  graphviz: "graphviz",
  // D2
  d2: "d2",
  // DBML
  dbml: "dbml",
  // DitAA
  ditaa: "ditaa",
  // Erd
  erd: "erd",
  // Excalidraw
  excalidraw: "excalidraw",
  // BlockDiag family
  blockdiag: "blockdiag",
  seqdiag: "seqdiag",
  actdiag: "actdiag",
  nwdiag: "nwdiag",
  packetdiag: "packetdiag",
  rackdiag: "rackdiag",
  // BPMN
  bpmn: "bpmn",
  // Bytefield
  bytefield: "bytefield",
  // Nomnoml
  nomnoml: "nomnoml",
  // Pikchr
  pikchr: "pikchr",
  // Structurizr
  structurizr: "structurizr",
  // Svgbob
  svgbob: "svgbob",
  bob: "svgbob",
  // Symbolator
  symbolator: "symbolator",
  // TikZ
  tikz: "tikz",
  tex: "tikz",
  // Vega
  vega: "vega",
  // Vega-Lite
  vegalite: "vegalite",
  "vega-lite": "vegalite",
  // WaveDrom
  wavedrom: "wavedrom",
  // WireViz
  wireviz: "wireviz",
};

const SUPPORTED_EXTENSIONS = new Set([...Object.keys(KROKI_TYPE), ".md"]);

/**
 * Sends diagram source to the Kroki server and returns the rendered image as a Buffer.
 * Uses raw POST body — do NOT encode the source.
 *
 * @param {string} source - The diagram source text.
 * @param {string} diagramType - Kroki diagram type (e.g. "plantuml", "mermaid").
 * @param {string} krokiUrl - Base URL of the Kroki server.
 * @returns {Promise<Buffer>} Rendered image data.
 */
function krokiRender(source, diagramType, krokiUrl) {
  const format = OUTPUT_FORMAT[diagramType] ?? "png";
  return new Promise((resolve, reject) => {
    const url = new URL(`/${diagramType}/${format}`, krokiUrl);
    const transport = url.protocol === "https:" ? https : http;
    const body = Buffer.from(source, "utf8");
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": body.length,
          Accept: "image/png",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const data = Buffer.concat(chunks);
          if (res.statusCode === 200) {
            resolve(data);
            return;
          }
          reject(
            new Error(
              `Kroki HTTP ${res.statusCode}: ${data.toString("utf8").slice(0, 300)}`,
            ),
          );
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Extracts fenced code blocks from markdown whose language is a supported diagram type.
 *
 * Title syntax on the opening fence line:
 *   ```plantuml user-flow              → title: "user-flow"
 *   ```plantuml "User Registration"    → title: "User Registration"
 *
 * @param {string} content - Raw markdown text.
 * @returns {{ krokiType: string, title: string|null, source: string }[]}
 */
function parseMarkdownDiagrams(content) {
  const results = [];
  const fence = /^```([\w-]+)(?:[ \t]+(?:"([^"]+)"|([\w-]+)))?\s*\n([\s\S]*?)^```/gm;
  let match;
  while ((match = fence.exec(content)) !== null) {
    const krokiType = MARKDOWN_LANG[match[1].toLowerCase()];
    if (krokiType) {
      results.push({
        krokiType,
        title: match[2] ?? match[3] ?? null,
        source: match[4],
      });
    }
  }
  return results;
}

/**
 * Checks whether a Kroki server is reachable by hitting its /health endpoint.
 * Resolves to true/false — never throws.
 *
 * @param {string} url - Base URL to check.
 * @returns {Promise<boolean>}
 */
function checkLocalServer(url) {
  return new Promise((resolve) => {
    const { hostname, port, protocol } = new URL(url);
    const transport = protocol === "https:" ? https : http;
    const req = transport.request(
      { hostname, port: port || undefined, path: "/health", method: "GET" },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * Recursively collects all supported files under dir.
 * Returns paths relative to baseDir, sorted alphabetically.
 *
 * @param {string} dir - Directory to scan.
 * @param {string} baseDir - Root used for computing relative paths.
 * @returns {string[]}
 */
function collectFiles(dir, baseDir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, baseDir));
    } else if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(path.relative(baseDir, fullPath));
    }
  }
  return results.sort();
}

/**
 * Renders all diagram code blocks found in a markdown file.
 * Saves each output image to outDir/<mdBasename>/<title>.<fmt>.
 * Untitled blocks fall back to <krokiType>-<N>.<fmt>.
 *
 * @param {string} filePath - Absolute path to the .md file.
 * @param {string} outDir - Output directory (already resolved).
 * @param {string} krokiUrl - Kroki server base URL.
 * @returns {Promise<{ ok: number, failed: number, outputs: string[] }>}
 */
async function renderMarkdownFile(filePath, outDir, krokiUrl) {
  const content = fs.readFileSync(filePath, "utf8");
  const diagrams = parseMarkdownDiagrams(content);
  const mdName = path.basename(filePath, ".md");

  if (diagrams.length === 0) {
    return { ok: 0, failed: 0, outputs: [] };
  }

  const subDir = path.join(outDir, mdName);
  fs.mkdirSync(subDir, { recursive: true });

  const typeCounts = {};
  let ok = 0;
  let failed = 0;
  const outputs = [];

  for (const { krokiType, title, source } of diagrams) {
    typeCounts[krokiType] = (typeCounts[krokiType] ?? 0) + 1;
    const n = String(typeCounts[krokiType]).padStart(2, "0");
    const fmt = OUTPUT_FORMAT[krokiType] ?? "png";
    const outName = title ? `${title}.${fmt}` : `${krokiType}-${n}.${fmt}`;
    const outputPath = path.join(subDir, outName);

    try {
      const data = await krokiRender(source, krokiType, krokiUrl);
      fs.writeFileSync(outputPath, data);
      ok += 1;
      outputs.push(outputPath);
    } catch (err) {
      failed += 1;
      outputs.push(null);
      throw err; // let callers decide how to handle/log
    }
  }

  return { ok, failed, outputs };
}

module.exports = {
  LOCAL_URL,
  PUBLIC_URL,
  OUTPUT_FORMAT,
  KROKI_TYPE,
  MARKDOWN_LANG,
  SUPPORTED_EXTENSIONS,
  krokiRender,
  parseMarkdownDiagrams,
  checkLocalServer,
  collectFiles,
  renderMarkdownFile,
};
