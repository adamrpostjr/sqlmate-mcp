# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the MCP server (attach-only; run by Claude Code, not you)
npm start                    # node src/index.js

# Start the standalone GUI daemon (run once, e.g. at login — see Host/Attach below)
node src/index.js gui
node src/index.js gui --install-autostart    # Windows: start it at login
node src/index.js gui --uninstall-autostart

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

**sqlmate-mcp** is a zero-config MCP server that exposes database tools to Claude Code, plus a browser GUI for database inspection that runs as a separate, long-lived **daemon** process — decoupled from any single editor/MCP session. See "Host/Attach Architecture" below.

### Backend (`src/`)

Pure Node.js ES modules, no TypeScript, no build step.

| File | Role |
|------|------|
| `src/index.js` | Dual entry point, dispatched on `argv[2]`. No args → MCP mode: loads connections, starts the stdio MCP server, and *attaches only* to a GUI daemon if one is reachable (never binds the GUI port, never opens a browser). `gui` → GUI daemon mode: binds the GUI port and runs the shared dashboard standalone, independent of any MCP session; also handles `gui --install-autostart` / `--uninstall-autostart` (Windows login item) |
| `src/mcp.js` | 8 MCP tools (`list_connections`, `add_connection`, `list_tables`, `describe_table`, `get_schema`, `run_query`, `explain_query`, `run_write`). Includes 2-step confirmation for risky write operations via `assessRisk()` |
| `src/drivers.js` | Driver implementations for MySQL/MariaDB (`mysql2`), SQLite (native `node:sqlite`), MSSQL (`mssql`), PostgreSQL (`pg`). Each exposes a uniform interface: `listTables`, `describeTable`, `runQuery`, `runWrite`, `getPaginatedRows`, `updateRow`, `deleteRow`, `close` |
| `src/connections.js` | Reads `.env` (Laravel-style `DB_*` vars or `DATABASE_URL`) and `.sqlmaterc` (JSON array) from `SQLMATE_PROJECT_ROOT` (defaults to `cwd`) |
| `src/gui.js` | Express REST API on port 4737 (the daemon process only). Serves the built Svelte app from `/public`, project-scoped connection/table/row CRUD routes, the `/api/host/*` uplink routes used by attached MCP processes, and the SSE stream (`/api/events`) for the live agent feed |
| `src/attach.js` | Client-side uplink used by every MCP process: probes `/api/info`, registers this project with the GUI daemon, sends heartbeats, and forwards local tool events. `onHostGone` fires if the daemon disappears (e.g. restarted); `index.js` retries the probe/attach on an interval rather than racing to become host itself |
| `src/registry.js` | `ProjectRegistry` — in-memory store, kept by the GUI daemon, of every attached project it knows about: registration/reconciliation of connections, heartbeat TTL + GC of stale projects, per-project connection lookup, and the `snapshot()`/`projects_changed` data sent to the GUI. A daemon with no editor sessions attached simply has zero projects — `getSelfProjectId()` returns `null` and the GUI renders an empty sidebar until something attaches |
| `src/protocol.js` | Shared constants between the daemon and attached MCP processes: `APP`, `PROTOCOL_VERSION` (compatibility check), `HEARTBEAT_MS`, `PROJECT_TTL_MS`, `GC_INTERVAL_MS`, and the `projectId()` hash function |
| `src/events.js` | EventEmitter singleton — bridges MCP tool call lifecycle (`tool_start`/`tool_end`) and `connections_changed` from `mcp.js` to `attach.js`'s uplink |

### Host/Attach Architecture

The GUI is a standalone daemon (`node src/index.js gui`), not something an MCP session spins up for itself. Every `sqlmate-mcp` process that Claude Code/Zed launches (no args) is **attach-only**: it never binds the GUI port (`SQLMATE_PORT`, default 4737) and never opens a browser tab, no matter how many editor sessions start and stop throughout the day.

1. On startup, an MCP process calls `probeHost()` (`src/attach.js`) against the GUI port to check for a compatible daemon (`GET /api/info`, matching `PROTOCOL_VERSION`).
2. If found, it calls `startAttach()`, which registers the project's connections with the daemon (`POST /api/host/register`), heartbeats every `HEARTBEAT_MS` (`POST /api/host/heartbeat`), and forwards `tool_start`/`tool_end` events (`POST /api/host/events`) so the shared GUI's live feed covers all attached projects.
3. If no daemon is reachable (or it's an incompatible version), the MCP process logs a one-time hint to stderr and keeps working with no GUI, retrying the probe/attach every 30s in the background — so starting the daemon later (or after it restarts) picks the session back up without restarting the editor.
4. If a previously-attached daemon goes away (heartbeat fails), `onHostGone` fires and the MCP process goes back to step 3 — it never tries to become the host itself.

The daemon itself (`gui` mode) just binds the GUI port, runs `ProjectRegistry` with no self project, and opens the browser once on startup (`SQLMATE_NO_OPEN=1` to suppress). Running `gui` again while one is already up detects the live daemon via `probeHost()` and just opens the browser to it instead of erroring. `gui --install-autostart` (Windows only) drops a hidden `.vbs` launcher in the Startup folder so the daemon starts once at login instead of being tied to any editor session's lifetime.

The GUI's `/api/events` SSE stream and REST routes are project-scoped (`/api/projects/:projectId/...`) and fail closed on a missing/empty `projectId` by default. The unified dashboard opts into `/api/events?all=1`, which streams every project's `projects_changed` snapshot and all projects' tool events so one browser can show all projects at once (grouped by project in the sidebar). `?all=1` is the only way to get cross-project visibility — the scoped/fail-closed default stays for any other consumer.

### Frontend (`frontend/`)

Svelte 5 + Vite + Tailwind. Builds output to `/public` (served by Express).

Key components: `App.svelte` (layout), `store.svelte.js` (reactive state), `api.js` (fetch wrapper), `DataGrid.svelte` (paginated editable grid), `SqlEditor.svelte`, `AgentFeed.svelte` (live SSE tool events).

### Connection Config

Connections are loaded from the project being served (not this repo itself):
- **`.env`** — `DB_CONNECTION` (`mysql`/`mariadb`/`sqlite`/`mssql`/`sqlsrv`/`pgsql`/`postgres`/`postgresql`), `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, or `DATABASE_URL`
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
