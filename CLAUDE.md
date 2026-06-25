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
```

No test or lint commands are configured.

## Architecture

**sqlmate-mcp** is a zero-config MCP server that exposes database tools to Claude Code and opens a browser GUI for database inspection.

### Backend (`src/`)

Pure Node.js ES modules, no TypeScript, no build step.

| File | Role |
|------|------|
| `src/index.js` | Entry point. Loads connections, starts MCP + GUI servers in parallel, auto-opens browser |
| `src/mcp.js` | 5 MCP tools (`list_connections`, `list_tables`, `describe_table`, `run_query`, `run_write`). Includes 2-step confirmation for risky write operations via `assessRisk()` |
| `src/drivers.js` | Driver implementations for MySQL/MariaDB (`mysql2`), SQLite (native `node:sqlite`), MSSQL (`mssql`). Each exposes a uniform interface: `listTables`, `describeTable`, `runQuery`, `runWrite`, `getPaginatedRows`, `updateRow`, `deleteRow`, `close` |
| `src/connections.js` | Reads `.env` (Laravel-style `DB_*` vars or `DATABASE_URL`) and `.sqlmaterc` (JSON array) from `SQLMATE_PROJECT_ROOT` (defaults to `cwd`) |
| `src/gui.js` | Express REST API on port 4737. Serves the built Svelte app from `/public`. 9 endpoints for table/row CRUD + SSE stream for live agent feed |
| `src/events.js` | EventEmitter singleton — bridges MCP tool call lifecycle (`tool_start`/`tool_end`) to the GUI via SSE |

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
