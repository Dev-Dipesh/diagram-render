#!/usr/bin/env node
/**
 * generate.cjs
 * ------------
 * Renders diagram source files to PNG using Kroki (https://kroki.io).
 *
 * Supported inputs:
 *   - Individual diagram files: format detected from extension
 *   - Markdown files: fenced code blocks with diagram language names are each
 *     rendered to a sub-directory in the output dir named after the .md file
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
  ".puml": "plantuml",
  ".plantuml": "plantuml",
  ".mmd": "mermaid",
  ".mermaid": "mermaid",
  ".dot": "graphviz",
  ".gv": "graphviz",
  ".d2": "d2",
  ".ditaa": "ditaa",
  ".bob": "svgbob",
  ".pikchr": "pikchr",
};

// Maps fenced code block language name -> Kroki diagram type (for .md files).
// Covers common aliases people write in markdown.
const MARKDOWN_LANG = {
  plantuml: "plantuml",
  puml: "plantuml",
  mermaid: "mermaid",
  dot: "graphviz",
  graphviz: "graphviz",
  d2: "d2",
  ditaa: "ditaa",
  svgbob: "svgbob",
  bob: "svgbob",
  pikchr: "pikchr",
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
${Object.entries(KROKI_TYPE)
  .map(([ext, type]) => `  ${ext.padEnd(12)} -> ${type}`)
  .join("\n")}

Markdown (.md) support:
  Fenced code blocks with a supported language name are each rendered to a PNG.
  Output goes into a sub-directory named after the .md file.

  Supported code block languages: ${Object.keys(MARKDOWN_LANG).join(", ")}

  Example markdown:
    \`\`\`plantuml
    @startuml
    Alice -> Bob: hello
    @enduml
    \`\`\`

  Output: diagrams/notes/plantuml-01.png
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
// Returns [{krokiType, source}] in document order.
function parseMarkdownDiagrams(content) {
  const results = [];
  const fence = /^```(\w[\w-]*)\s*\n([\s\S]*?)^```/gm;
  let match;
  while ((match = fence.exec(content)) !== null) {
    const krokiType = MARKDOWN_LANG[match[1].toLowerCase()];
    if (krokiType) {
      results.push({ krokiType, source: match[2] });
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
// PNGs are saved to outputDir/<mdBasename>/<krokiType>-<N>.png
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

  // Track per-type counters for output filenames
  const typeCounts = {};
  let ok = 0;
  let failed = 0;

  for (const { krokiType, source } of diagrams) {
    typeCounts[krokiType] = (typeCounts[krokiType] ?? 0) + 1;
    const n = String(typeCounts[krokiType]).padStart(2, "0");
    const outName = `${krokiType}-${n}.png`;
    const outputPath = path.join(subDir, outName);

    process.stdout.write(`  [${krokiType}] block ${n} -> ${mdName}/${outName} ... `);
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
