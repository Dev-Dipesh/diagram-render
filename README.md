# diagram-render

Renders diagram source files to PNG using [Kroki](https://kroki.io). Format is detected automatically from the file extension. No runtime dependencies — uses only Node.js built-ins.

## Quick start

```bash
# Drop your source files into src/
# then render all of them
npm run render
```

Output PNGs land in `diagrams/` with the same base filename.

## Usage

```bash
node generate.cjs [file] [options]
```

| Argument / Option       | Description                              | Default      |
|-------------------------|------------------------------------------|--------------|
| `file`                  | Single file to render (from input dir)   | —            |
| `-i, --input <dir>`     | Source directory                         | `./src`      |
| `-o, --output <dir>`    | Output directory                         | `./diagrams` |
| `-h, --help`            | Show help                                | —            |

### Examples

```bash
# Render everything in src/ → diagrams/
npm run render

# Render a single file
npm run render:one -- flow.puml

# Custom input directory
node generate.cjs -i ./architecture

# Custom input and output
node generate.cjs -i ./architecture -o ./docs/images

# Single file with custom output
node generate.cjs flow.puml -o ./docs/images
```

## Supported formats

Format is detected from the file extension. Unsupported extensions are skipped.

| Extension          | Kroki type   |
|--------------------|--------------|
| `.puml`, `.plantuml` | plantuml   |
| `.mmd`, `.mermaid` | mermaid      |
| `.dot`, `.gv`      | graphviz     |
| `.d2`              | d2           |
| `.ditaa`           | ditaa        |
| `.bob`             | svgbob       |
| `.pikchr`          | pikchr       |

To add a format, edit the `KROKI_TYPE` map at the top of `generate.cjs`:

```js
const KROKI_TYPE = {
  ".puml": "plantuml",
  ".mmd":  "mermaid",
  // add your extension -> kroki type here
};
```

Full list of supported diagram types: https://kroki.io/#support

## Project structure

```txt
diagram-render/
├── generate.cjs      # renderer script
├── package.json
├── src/              # source diagram files (committed)
└── diagrams/         # output PNGs (gitignored)
```

## Notes

- Requires internet access — rendering is done via `https://kroki.io`.
- `diagrams/*.png` is gitignored. Commit only source files in `src/`.
- Output filename always matches the input basename: `flow.puml` → `flow.png`.
