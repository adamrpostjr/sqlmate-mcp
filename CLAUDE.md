# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the MCP server
npm start                    # node src/index.js

# Build the frontend (Svelte → /public)
npm run build                # installs frontend deps + vite build

# Frontend dev server (proxies /api to localhost:4737)
cd frontend && npm run dev

# Register with Claude Code (one-time)
claude mcp add --transport stdio sqlmate-mcp node /path/to/src/index.js

# Run tests
npm test                     # node --test test/**/*.test.js
```

No lint command is configured.

## Architecture

**sqlmate-mcp** is a zero-config MCP server that exposes database tools to Claude Code and opens a browser GUI for database inspection. When multiple projects run sqlmate-mcp at once, they share a single GUI process instead of each opening its own — see "Host/Attach Architecture" below.

### Backend (`src/`)

Pure Node.js ES modules, no TypeScript, no build step.

| File | Role |
|------|------|
| `src/index.js` | Entry point. Loads connections, decides whether this process becomes the GUI host or attaches to an existing one, auto-opens browser |
| `src/mcp.js` | 5 MCP tools (`list_connections`, `list_tables`, `describe_table`, `run_query`, `run_write`). Includes 2-step confirmation for risky write operations via `assessRisk()` |
| `src/drivers.js` | Driver implementations for MySQL/MariaDB (`mysql2`), SQLite (native `node:sqlite`), MSSQL (`mssql`). Each exposes a uniform interface: `listTables`, `describeTable`, `runQuery`, `runWrite`, `getPaginatedRows`, `updateRow`, `deleteRow`, `close` |
| `src/connections.js` | Reads `.env` (Laravel-style `DB_*` vars or `DATABASE_URL`) and `.sqlmaterc` (JSON array) from `SQLMATE_PROJECT_ROOT` (defaults to `cwd`) |
| `src/gui.js` | Express REST API on port 4737 (the host process only). Serves the built Svelte app from `/public`, project-scoped connection/table/row CRUD routes, the `/api/host/*` uplink routes used by attached processes, and the SSE stream (`/api/events`) for the live agent feed |
| `src/attach.js` | Client-side uplink used when another process already owns the GUI port: probes `/api/info`, registers this project with the host, sends heartbeats, forwards local tool events, and triggers host takeover (`becomeHostOrAttach` in `index.js`) if the host disappears |
| `src/registry.js` | `ProjectRegistry` — in-memory store of all projects (self + attached) the host knows about: registration/reconciliation of connections, heartbeat TTL + GC of stale projects, per-project connection lookup, and the `snapshot()`/`projects_changed` data sent to the GUI |
| `src/protocol.js` | Shared constants between host and attached processes: `APP`, `PROTOCOL_VERSION` (host/attach compatibility check), `HEARTBEAT_MS`, `PROJECT_TTL_MS`, `GC_INTERVAL_MS`, and the `projectId()` hash function |
| `src/events.js` | EventEmitter singleton — bridges MCP tool call lifecycle (`tool_start`/`tool_end`) and `connections_changed` to the GUI (directly when hosting, via `attach.js` uplink when attached) |

### Host/Attach Architecture

Only one sqlmate-mcp process per machine binds the GUI port (`SQLMATE_PORT`, default 4737) — that process is the **host**. Every other process (e.g. sqlmate-mcp running for a second, third, ... project) becomes an **attached** client:

1. On startup, `index.js` tries to bind the GUI port. If successful, it becomes the host and registers itself as a project with `self: true` (the self project is exempt from GC/heartbeat expiry).
2. If the port is taken, it calls `probeHost()` (`src/attach.js`) to confirm the occupant is a compatible sqlmate-mcp host (`GET /api/info`, matching `PROTOCOL_VERSION`). If not compatible, it logs and continues without a GUI.
3. If compatible, it calls `startAttach()`, which registers the project's connections with the host (`POST /api/host/register`), heartbeats every `HEARTBEAT_MS` (`POST /api/host/heartbeat`), and forwards `tool_start`/`tool_end` events (`POST /api/host/events`) so the shared GUI's live feed covers all attached projects.
4. If the host goes away (heartbeat fails), the attached process's `onHostGone` callback fires and it re-runs `becomeHostOrAttach()` — racing to become the new host or attach to whichever process wins.

The GUI's `/api/events` SSE stream and REST routes are project-scoped (`/api/projects/:projectId/...`) and fail closed on a missing/empty `projectId` — one browser tab must never see another attached project's SQL, errors, or connection details.

### Frontend (`frontend/`)

Svelte 5 + Vite + Tailwind. Builds output to `/public` (served by Express).

Key components: `App.svelte` (layout), `store.svelte.js` (reactive state), `api.js` (fetch wrapper), `DataGrid.svelte` (paginated editable grid), `SqlEditor.svelte`, `AgentFeed.svelte` (live SSE tool events).

### Connection Config

Connections are loaded from the project being served (not this repo itself):
- **`.env`** — `DB_CONNECTION`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, or `DATABASE_URL`
- **`.sqlmaterc`** — JSON array of connection objects (see `docs/sqlmaterc-example.json`)

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SQLMATE_PROJECT_ROOT` | `cwd` | Where to look for `.env` / `.sqlmaterc` |
| `SQLMATE_PORT` | `4737` | GUI server port |
| `SQLMATE_NO_OPEN` | unset | Set to `1` to skip auto-open browser |

### Key Constraints

- Requires Node.js ≥ 22.5 (native SQLite `node:sqlite` module).
- MCP transport is stdio — the server must not write to stdout (use `stderr` for logging).
- `run_query` enforces read-only: only SELECT, EXPLAIN, SHOW, PRAGMA allowed.
- `run_write` gates risky operations (DELETE/UPDATE without WHERE, DROP, TRUNCATE, ALTER...DROP COLUMN) behind a `confirm: true` parameter.
- Bump `PROTOCOL_VERSION` in `src/protocol.js` on any breaking change to the `/api/host/*` or `/api/info` shapes — an attaching process refuses to use a host whose `protocolVersion` doesn't match, so mismatched versions just fall back to no GUI instead of erroring.
