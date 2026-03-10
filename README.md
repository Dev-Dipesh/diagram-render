# diagram-render

Renders diagram source files to PNG using [Kroki](https://kroki.io). No runtime dependencies — uses only Node.js built-ins.

Two input modes:

- **Individual files** — one diagram per file, format detected from extension
- **Markdown files** — multiple diagrams embedded as fenced code blocks, each rendered to a sub-directory

## Quick start

```bash
# Drop source files into src/ then render all of them
npm run render
```

Output PNGs land in `diagrams/`.

## Usage

```bash
node generate.cjs [file] [options]
```

| Argument / Option    | Description                            | Default      |
|----------------------|----------------------------------------|--------------|
| `file`               | Single file to render (from input dir) | —            |
| `-i, --input <dir>`  | Source directory                       | `./src`      |
| `-o, --output <dir>` | Output directory                       | `./diagrams` |
| `-h, --help`         | Show help and supported formats        | —            |

### Examples

```bash
# Render everything in src/ → diagrams/
npm run render

# Render a single diagram file
npm run render:one -- flow.puml

# Render a single markdown file
npm run render:one -- architecture.md

# Custom input directory
node generate.cjs -i ./architecture

# Custom input and output
node generate.cjs -i ./architecture -o ./docs/images

# Single file with custom output
node generate.cjs flow.puml -o ./docs/images
```

## Individual diagram files

Format is detected from the file extension. Unsupported extensions are skipped.

| Extension(s)                    | Kroki type   |
|---------------------------------|--------------|
| `.puml`, `.plantuml`            | plantuml     |
| `.c4puml`                       | c4plantuml   |
| `.mmd`, `.mermaid`              | mermaid      |
| `.dot`, `.gv`                   | graphviz     |
| `.d2`                           | d2           |
| `.dbml`                         | dbml         |
| `.ditaa`                        | ditaa        |
| `.erd`                          | erd          |
| `.excalidraw`                   | excalidraw   |
| `.blockdiag`                    | blockdiag    |
| `.seqdiag`                      | seqdiag      |
| `.actdiag`                      | actdiag      |
| `.nwdiag`                       | nwdiag       |
| `.packetdiag`                   | packetdiag   |
| `.rackdiag`                     | rackdiag     |
| `.bpmn`                         | bpmn         |
| `.bytefield`                    | bytefield    |
| `.nomnoml`                      | nomnoml      |
| `.pikchr`                       | pikchr       |
| `.dsl`                          | structurizr  |
| `.bob`                          | svgbob       |
| `.symbolator`                   | symbolator   |
| `.tikz`                         | tikz         |
| `.vega`                         | vega         |
| `.vegalite`                     | vegalite     |
| `.wavedrom`                     | wavedrom     |
| `.wireviz`                      | wireviz      |

Output: `diagrams/flow.png` (same base filename as input).

To add a format, edit the `KROKI_TYPE` map in `generate.cjs`. Full list: https://kroki.io/#support

## Markdown files

Embed diagrams as fenced code blocks using the diagram type as the language name.
Each block is rendered individually and saved to a sub-directory named after the `.md` file.

### Title syntax

Add a title after the language name on the opening fence line. The title becomes the PNG filename.

**Quoted** — allows spaces, becomes the filename as-is:

````md
```plantuml "User Registration Flow"
@startuml
Alice -> Bob: hello
@enduml
```
````

→ `diagrams/architecture/User Registration Flow.png`

**Unquoted slug** — single word or kebab-case:

````md
```plantuml user-flow
```
````

→ `diagrams/architecture/user-flow.png`

Without a title, files are named by type and sequence number: `plantuml-01.png`, `mermaid-01.png`, etc.

### Example

````md
# Architecture

```plantuml "Sequence Overview"
@startuml
...
@enduml
```

```mermaid data-flow
graph TD
    A --> B
```

```mermaid
graph LR
    X --> Y
```
````

Output for `src/architecture.md`:

```txt
diagrams/
└── architecture/
    ├── Sequence Overview.png   ← quoted title
    ├── data-flow.png           ← unquoted slug
    └── mermaid-01.png          ← untitled fallback
```

### Supported code block language names

| Language name(s)                        | Kroki type   |
|-----------------------------------------|--------------|
| `plantuml`, `puml`                      | plantuml     |
| `c4plantuml`, `c4`                      | c4plantuml   |
| `mermaid`                               | mermaid      |
| `dot`, `graphviz`                       | graphviz     |
| `d2`                                    | d2           |
| `dbml`                                  | dbml         |
| `ditaa`                                 | ditaa        |
| `erd`                                   | erd          |
| `excalidraw`                            | excalidraw   |
| `blockdiag`                             | blockdiag    |
| `seqdiag`                               | seqdiag      |
| `actdiag`                               | actdiag      |
| `nwdiag`                                | nwdiag       |
| `packetdiag`                            | packetdiag   |
| `rackdiag`                              | rackdiag     |
| `bpmn`                                  | bpmn         |
| `bytefield`                             | bytefield    |
| `nomnoml`                               | nomnoml      |
| `pikchr`                                | pikchr       |
| `structurizr`                           | structurizr  |
| `svgbob`, `bob`                         | svgbob       |
| `symbolator`                            | symbolator   |
| `tikz`, `tex`                           | tikz         |
| `vega`                                  | vega         |
| `vegalite`, `vega-lite`                 | vegalite     |
| `wavedrom`                              | wavedrom     |
| `wireviz`                               | wireviz      |

To add a language alias, edit the `MARKDOWN_LANG` map in `generate.cjs`.

## Project structure

```txt
diagram-render/
├── generate.cjs      # renderer script
├── package.json
├── src/              # source files — individual diagrams and/or .md files
└── diagrams/         # output PNGs (gitignored)
    ├── flow.png              # from src/flow.puml
    └── architecture/         # from src/architecture.md
        ├── sequence-overview.png
        ├── data-flow.png
        └── mermaid-01.png
```

## Notes

- Requires internet access — rendering is done via `https://kroki.io`.
- `diagrams/` is gitignored. Commit only source files in `src/`.
- Non-diagram code blocks in `.md` files are silently skipped.
- Title slugs should be `kebab-case`. Characters outside `[a-zA-Z0-9-_]` are not sanitised — keep slugs simple.
