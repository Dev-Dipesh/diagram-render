#!/usr/bin/env node
/**
 * generate.cjs
 * ------------
 * Renders diagram source files to PNG using Kroki (https://kroki.io).
 *
 * Supported inputs:
 *   - Individual diagram files: format detected from extension
 *   - Markdown files: fenced code blocks with a diagram language are each
 *     rendered to a sub-directory named after the .md file
 *
 * Titles (markdown mode):
 *   Add a slug after the language name on the opening fence line.
 *   The slug becomes the PNG filename. Use hyphens for multi-word titles.
 *
 *     ```plantuml user-flow
 *     ...
 *     ```
 *     → diagrams/notes/user-flow.png
 *
 *   Without a title, files are named by type and sequence: plantuml-01.png
 *
 * Usage:
 *   node generate.cjs                          # render all supported files in ./src
 *   node generate.cjs flow.puml                # render one file from the input dir
 *   node generate.cjs notes.md                 # render all diagrams inside a markdown file
 *   node generate.cjs -i ./my-diagrams         # custom input directory
 *   node generate.cjs -o ./docs/images         # custom output directory
 *   node generate.cjs -i ./arch -o ./out       # both
 *   node generate.cjs flow.puml -o ./out       # single file, custom output
 *   node generate.cjs --help                   # show this help
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

// Maps file extension -> Kroki diagram type (for individual source files).
// Full list: https://kroki.io/#support
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
// Includes common aliases people write in markdown.
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

function printHelp() {
  console.log(`
Usage:
  node generate.cjs [file] [options]

Arguments:
  file                 Single source file to render (looked up in input dir)

Options:
  -i, --input <dir>    Source directory  (default: ./src)
  -o, --output <dir>   Output directory  (default: ./diagrams)
  -h, --help           Show this help

Supported individual file formats (auto-detected from extension):
${Object.entries(
  // Deduplicate by Kroki type for display
  Object.entries(KROKI_TYPE).reduce((acc, [ext, type]) => {
    acc[type] = acc[type] ? `${acc[type]}, ${ext}` : ext;
    return acc;
  }, {}),
)
  .map(([type, exts]) => `  ${exts.padEnd(28)} -> ${type}`)
  .join("\n")}

Markdown (.md) files:
  Fenced code blocks with a diagram language are rendered individually.
  Output goes to a sub-directory named after the .md file.

  Title syntax — add a title after the language on the opening fence.
  Quoted titles allow spaces; unquoted titles are single slugs:
    \`\`\`plantuml "User Registration Flow"  →  User Registration Flow.png
    \`\`\`plantuml user-flow                 →  user-flow.png
    \`\`\`mermaid                            →  mermaid-01.png  (fallback)

  Supported language names: ${Object.keys(MARKDOWN_LANG).join(", ")}
`);
}

function parseArgs(argv) {
  const args = { input: null, output: null, file: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if ((a === "--input" || a === "-i") && argv[i + 1]) {
      args.input = argv[++i];
    } else if ((a === "--output" || a === "-o") && argv[i + 1]) {
      args.output = argv[++i];
    } else if (!a.startsWith("-")) {
      args.file = a;
    }
  }
  return args;
}

// Extracts fenced code blocks from markdown whose language is a supported diagram type.
// Captures an optional title from the info string — quoted or unquoted:
//   ```plantuml user-flow              → title: "user-flow"
//   ```plantuml "User Registration Flow"  → title: "User Registration Flow"
// Returns [{krokiType, title, source}] in document order.
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

function krokiRender(source, diagramType) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(source, "utf8");
    const req = https.request(
      {
        hostname: "kroki.io",
        path: `/${diagramType}/png`,
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

// Renders all diagram code blocks found in a markdown file.
// Output: outputDir/<mdBasename>/<title>.png  (titled)
//         outputDir/<mdBasename>/<krokiType>-<N>.png  (untitled)
async function renderMarkdownFile(filePath, outputDir) {
  const content = fs.readFileSync(filePath, "utf8");
  const diagrams = parseMarkdownDiagrams(content);
  const mdName = path.basename(filePath, ".md");

  if (diagrams.length === 0) {
    console.log(`  no diagram blocks found`);
    return { ok: 0, failed: 0 };
  }

  const subDir = path.join(outputDir, mdName);
  fs.mkdirSync(subDir, { recursive: true });

  // Per-type counters for untitled fallback names
  const typeCounts = {};
  let ok = 0;
  let failed = 0;

  for (const { krokiType, title, source } of diagrams) {
    typeCounts[krokiType] = (typeCounts[krokiType] ?? 0) + 1;
    const n = String(typeCounts[krokiType]).padStart(2, "0");
    const outName = title ? `${title}.png` : `${krokiType}-${n}.png`;
    const outputPath = path.join(subDir, outName);

    process.stdout.write(`  [${krokiType}] ${outName} ... `);
    try {
      const png = await krokiRender(source, krokiType);
      fs.writeFileSync(outputPath, png);
      ok += 1;
      console.log("ok");
    } catch (err) {
      failed += 1;
      console.log("failed");
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ok, failed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const inputDir = path.resolve(args.input ?? "src");
  const outputDir = path.resolve(args.output ?? "diagrams");

  if (!fs.existsSync(inputDir)) {
    console.error(`Input directory not found: ${inputDir}`);
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  // Resolve files to render
  let files;
  if (args.file) {
    const candidate = path.basename(args.file);
    const ext = path.extname(candidate);
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      console.error(
        `Unsupported extension: ${ext}\nRun --help to see supported formats.`,
      );
      process.exit(1);
    }
    const inputPath = path.join(inputDir, candidate);
    if (!fs.existsSync(inputPath)) {
      console.error(`File not found: ${inputPath}`);
      process.exit(1);
    }
    files = [candidate];
  } else {
    files = fs
      .readdirSync(inputDir)
      .filter((f) => SUPPORTED_EXTENSIONS.has(path.extname(f)))
      .sort((a, b) => a.localeCompare(b));
  }

  if (files.length === 0) {
    console.log(`No supported diagram files found in: ${inputDir}`);
    return;
  }

  let ok = 0;
  let failed = 0;

  for (const file of files) {
    const ext = path.extname(file);
    const inputPath = path.join(inputDir, file);

    if (ext === ".md") {
      console.log(`[markdown] ${file}`);
      const result = await renderMarkdownFile(inputPath, outputDir);
      ok += result.ok;
      failed += result.failed;
    } else {
      const diagramType = KROKI_TYPE[ext];
      const outName = `${path.basename(file, ext)}.png`;
      const outputPath = path.join(outputDir, outName);
      const source = fs.readFileSync(inputPath, "utf8");

      process.stdout.write(`[${diagramType}] ${file} -> ${outName} ... `);
      try {
        const png = await krokiRender(source, diagramType);
        fs.writeFileSync(outputPath, png);
        ok += 1;
        console.log("ok");
      } catch (err) {
        failed += 1;
        console.log("failed");
        console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(`\nDone. Success: ${ok}, Failed: ${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main();
