#!/usr/bin/env node
/**
 * generate.cjs
 * ------------
 * Renders diagram source files to PNG using Kroki (https://kroki.io).
 * Format is detected automatically from the file extension.
 *
 * Usage:
 *   node generate.cjs                          # render all supported files in ./src
 *   node generate.cjs flow.puml                # render one file from the input dir
 *   node generate.cjs -i ./my-diagrams         # custom input directory
 *   node generate.cjs -o ./docs/images         # custom output directory
 *   node generate.cjs -i ./arch -o ./out       # both
 *   node generate.cjs flow.puml -o ./out       # single file, custom output
 *   node generate.cjs --help                   # show this help
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

// Maps file extension -> Kroki diagram type.
// Add or remove entries here to support more formats.
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

const SUPPORTED_EXTENSIONS = new Set(Object.keys(KROKI_TYPE));

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

Supported formats (auto-detected from extension):
${Object.entries(KROKI_TYPE)
  .map(([ext, type]) => `  ${ext.padEnd(12)} -> ${type}`)
  .join("\n")}
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
    const diagramType = KROKI_TYPE[ext];
    const inputPath = path.join(inputDir, file);
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

  console.log(`\nDone. Success: ${ok}, Failed: ${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main();
