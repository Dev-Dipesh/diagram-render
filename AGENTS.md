# diagram-render

Kroki-based PlantUML to PNG renderer. Zero runtime dependencies — uses only Node.js built-ins.

## Project Structure

```txt
diagram-render/
├── generate.cjs      # renderer script (entry point)
├── package.json
├── puml/             # source diagrams (.puml files go here)
└── diagrams/         # output PNGs (gitignored)
```

## Running

```bash
# Render all .puml files
npm run render

# Render a single file
npm run render:one -- my-diagram.puml
```

Requires internet access — rendering is done via `https://kroki.io/plantuml/png`.

## Adding Diagrams

Drop `.puml` files into `puml/` and run `npm run render`. Output PNGs land in `diagrams/` with the same base filename.

## Code Quality

- Use JSDoc comments for any non-obvious functions.
- Prefer descriptive variable names over abbreviations.
- Keep functions focused — break anything >20 lines into smaller pieces where it makes sense.
- No `eval()` or `Function()` constructor on any input.
- Always handle errors explicitly; avoid swallowing them silently.
- Remove unreachable or commented-out code before committing.

## Linting

No linter is configured by default. If one is added, prefer inline `// eslint-disable-next-line rule` over file-level disables for individual exceptions. File-level disables hide all future violations of that rule silently.

## Commit Messages

- No AI branding, attribution lines, or co-author footers.
- Format: `type: short description` (conventional commits style).
- Body is optional; use it only when the why isn't obvious from the subject.

## Collaboration Safety

- Do not remove files unless the user explicitly asks.
- If cleanup is needed, list candidate files first and get confirmation before deleting.
- `diagrams/*.png` is gitignored — never force-add generated output.

## Multi-Agent Safety

When multiple agents may be running concurrently:

- Do not create, apply, or drop `git stash` entries unless explicitly requested.
- Do not switch branches unless explicitly requested.
- Do not create or remove `git worktree` checkouts unless explicitly requested.
- When committing, scope to your own changes only. "Commit all" means commit everything in grouped chunks.
- When you see unrecognized files, keep going — focus on your changes only.

## Agent Behaviour

- Respond with high-confidence answers only: verify in code before answering; do not guess.
- Lint/format-only diffs: auto-resolve without asking. If a commit was already requested, include formatting fixes in the same commit or a small follow-up — no extra confirmation needed. Only ask when changes are semantic.
- When finishing work on a GitHub Issue or PR, print the full URL at the end.
