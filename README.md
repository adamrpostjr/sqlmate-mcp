# sqlmate-mcp

**Zero-config SQL database MCP server with a browser GUI for Claude Code.**

Connect Claude to your MySQL, MariaDB, SQLite, or MSSQL databases. sqlmate-mcp reads your existing `.env` or a `.sqlmaterc` config, exposes your databases as MCP tools, and opens a live browser GUI so you can browse, edit, and run SQL alongside your AI assistant.

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)](https://nodejs.org) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Features

- **Zero config** — reads `DB_*` vars or `DATABASE_URL` straight from your project's `.env`
- **Multi-connection** — manage MySQL, MariaDB, SQLite, and MSSQL from a single server
- **5 MCP tools** — list connections, list tables, describe schema, run read queries, run writes
- **Write safety** — risky operations (DELETE/UPDATE without WHERE, DROP, TRUNCATE) require explicit confirmation
- **Browser GUI** — paginated data grid, inline cell editing, row delete, schema view, SQL editor
- **Live agent feed** — watch every MCP tool call stream in real time in the browser
- **No native builds** — SQLite uses Node.js's built-in `node:sqlite` (no `node-gyp`)

---

## Requirements

- Node.js ≥ 22.5

---

## Setup

### 1. Install

```bash
npm install -g sqlmate-mcp
```

### 2. Register with Claude Code

```bash
claude mcp add --transport stdio sqlmate-mcp sqlmate-mcp
```

That's it. Claude Code now has access to your databases.

> **First time?** Run `sqlmate-mcp` once manually to verify it starts and prints the detected connections.

### 3. Configure your connections

sqlmate-mcp reads connections from the **root of whichever project you open in Claude Code** (the directory you run `claude` from). No global config needed — each project uses its own `.env` or `.sqlmaterc`. See [Connection Setup](#connection-setup) below.

---

## Manual Installation (from source)

```bash
git clone https://github.com/adamrpostjr/sqlmate-mcp.git
cd sqlmate-mcp
npm install
npm run build
```

Then register using the full path:

```bash
claude mcp add --transport stdio sqlmate-mcp node /absolute/path/to/src/index.js
```

---

## Connection Setup

sqlmate-mcp reads connections from your **project root** at startup (defaults to `cwd`, override with `SQLMATE_PROJECT_ROOT`).

### Option 1 — `.env` file

Laravel-style variables:

```env
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=myapp
DB_USERNAME=root
DB_PASSWORD=secret
```

Or a connection URL:

```env
DATABASE_URL=mysql://root:secret@127.0.0.1:3306/myapp
DATABASE_URL=sqlite:///relative/path/app.db
DATABASE_URL=sqlserver://sa:pass@localhost:1433/master
```

Supported `DB_CONNECTION` / URL schemes: `mysql`, `mariadb`, `sqlite`, `sqlserver` / `mssql`

### Option 2 — `.sqlmaterc` file

Place a JSON array of connection objects in your project root:

```json
[
  {
    "name": "Local MySQL",
    "type": "mysql",
    "host": "127.0.0.1",
    "port": 3306,
    "username": "root",
    "password": "",
    "database": "myapp"
  },
  {
    "name": "App SQLite",
    "type": "sqlite",
    "path": "./database/app.db"
  },
  {
    "name": "MSSQL Dev",
    "type": "mssql",
    "host": "localhost",
    "port": 1433,
    "username": "sa",
    "password": "YourPassword123",
    "database": "master",
    "options": { "trustServerCertificate": true }
  }
]
```

A copy-paste starting point is in [`docs/sqlmaterc-example.json`](docs/sqlmaterc-example.json).

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_connections` | List all detected connections (id, name, type, source) |
| `list_tables(connectionId)` | List table names for a connection |
| `describe_table(connectionId, table)` | Column names, types, nullability, and primary key info |
| `run_query(connectionId, sql)` | Run a read-only query (SELECT, EXPLAIN, SHOW, PRAGMA) |
| `run_write(connectionId, sql)` | Run an INSERT, UPDATE, DELETE, or DDL statement |

`run_write` performs risk assessment before executing. Operations that affect all rows (no WHERE clause), DROP, TRUNCATE, or ALTER...DROP COLUMN will pause and ask Claude to confirm with `confirm: true` before proceeding.

---

## Browser GUI

Opens automatically at `http://localhost:4737` on startup.

- Browse any table with a paginated data grid
- Click a cell to edit it inline
- Delete rows with the trash icon
- Toggle between data view and column schema view
- Run arbitrary SQL in the built-in SQL editor
- Reconnect a database without restarting the server
- Watch a live feed of every MCP tool call Claude makes

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SQLMATE_PROJECT_ROOT` | `cwd` | Directory to search for `.env` and `.sqlmaterc` |
| `SQLMATE_PORT` | `4737` | Port for the browser GUI |
| `SQLMATE_NO_OPEN` | — | Set to `1` to skip auto-opening the browser |

---

## Development

```bash
# Start the backend (serves the built GUI at :4737)
node src/index.js

# Frontend hot-reload dev server (proxies /api to :4737)
cd frontend && npm run dev
```

The frontend is Svelte 5 + Vite + Tailwind. Production build output goes to `/public`, which Express serves statically.

---

## License

[MIT](LICENSE)
