# DMHC-EM — Dynamic Multi-Head CNC Execution Middleware

A research-level CNC motion-planning compiler that transforms single-head G-code programs into safe, verified multi-head machining plans with guaranteed geometric equivalence.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, served at `/api`)
- `pnpm --filter @workspace/dmhc-ui run dev` — run the web UI (port set by workflow, served at `/`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Python pipeline: `python3 -m dmhc_em.main --input <file.gcode> --output <dir> [options]`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 at `/api`
- Web UI: React + Vite + Tailwind (dark engineering theme)
- Python 3 middleware: the DMHC-EM compiler (no extra pip installs needed)
- DB: PostgreSQL + Drizzle ORM (provisioned, schema not yet populated)
- API codegen: Orval (from OpenAPI spec)

## Where things live

- `dmhc_em/` — Python CNC compiler (all 10 pipeline stages)
  - `core/` — G-code parser, machine state tracker, instruction stream
  - `ir/` — Segment, Toolpath, ToolpathGraph (intermediate representation)
  - `geometry/` — Density model, X-axis projection, contour analysis
  - `partition/` — Dynamic partition engine, gap model, scheduler
  - `generation/` — G-code regeneration engine
  - `collision/` — Collision detector & validation pipeline
  - `verification/` — Geometric equivalence checker (canonical form)
  - `output/` — File writer & report generator
  - `pipeline.py` — Main pipeline orchestrator
  - `main.py` — CLI entry point
- `artifacts/api-server/src/routes/jobs.ts` — REST API for job management
- `artifacts/dmhc-ui/src/pages/` — Web UI pages (home, viz, jobs)
- `lib/api-spec/openapi.yaml` — API contract source of truth

## Architecture decisions

- G-code is submitted as text via JSON (not multipart/form-data) to avoid browser File/Blob type issues in Node.js Zod validation.
- Jobs are stored in-memory (no DB persistence) — appropriate for a research/development tool. Add DB if persistence across restarts is needed.
- The Python pipeline is invoked as a child subprocess from Express; jobs run synchronously and return the result in the HTTP response (up to 30s timeout).
- Partitioning uses a combined density-valley + effort-balance heuristic for gap placement (60% effort balance, 40% density valley).
- Geometric equivalence is proven by canonical segment hashing (direction-invariant, precision-normalized).

## Product

- **Workspace page** (`/`): Upload or paste G-code, configure partition parameters (num heads, gap width, tool radius, safety margin), run the compiler.
- **Visualization page** (`/viz/:jobId`): SVG toolpath viewer (colored by zone), density chart D(x), partition stats, schedule timing, validation steps, download buttons.
- **Job History page** (`/jobs`): Table of all processed jobs with status, segment counts, speedup factor, and download/view links.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The Python DMHC-EM package must be importable from the workspace root. The API server sets `PYTHONPATH=<workspaceRoot>` when spawning the subprocess.
- Run `pnpm --filter @workspace/api-spec run codegen` after any OpenAPI spec change before using updated types.
- The equivalence checker only verifies CUT segments (G1 moves) — rapids (G0) are navigational, not geometric.
- Collision validator's machine boundary check defaults to 300×300mm workspace; override via `validate_plan(..., machine_x_max=..., machine_y_max=...)`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
