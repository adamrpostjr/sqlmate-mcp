<div align="center">

# 🗄️ sqlmate-mcp

### Give Claude a database. Give yourself a GUI.

**Zero-config SQL database [MCP](https://modelcontextprotocol.io) server with a live browser GUI — for Claude Code, Zed, and any MCP client.**

Point it at your project, and Claude can explore your **MySQL · MariaDB · SQLite · MSSQL · PostgreSQL** databases while _you_ browse, edit, and query them in a beautiful browser dashboard that updates in real time.

<br>

[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2022.5-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-000000)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-3B82F6.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-sqlmate--mcp-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/sqlmate-mcp)

<br>

```bash
npm install -g sqlmate-mcp
claude mcp add --transport stdio sqlmate-mcp sqlmate-mcp
```

_That's the whole setup. It reads your existing `.env` — no config files to write._

<br>

<img src="docs/screenshots/overview.png" alt="sqlmate-mcp browser GUI — paginated data grid with a live feed of Claude's tool calls" width="100%">

</div>

---

## ✨ Why sqlmate-mcp?

Most database MCP servers give the AI tools and leave **you** in the dark. sqlmate-mcp does both halves:

- 🤖 **For Claude** — 8 focused tools to inspect schemas, run queries, and make guarded writes.
- 👀 **For you** — a browser GUI (run once as a background daemon, not per session) so you can watch what the agent touches, edit data by hand, and run your own SQL side by side.

No API keys. No cloud. No `node-gyp`. It reads the config you already have.

---

## 🚀 Features

|  |  |
|---|---|
| ⚡ **Zero config** | Reads `DB_*` vars or `DATABASE_URL` straight from your project's `.env` |
| 🔌 **5 databases** | MySQL, MariaDB, SQLite, MSSQL, and PostgreSQL from one server |
| 🧠 **Schema intelligence** | `get_schema` returns every table's columns, PKs, foreign keys, and indexes in a single call |
| 📊 **Query plans** | `explain_query` returns the execution plan without running your statement — opt into `analyze` for real timing |
| 🛡️ **Write safety** | DELETE/UPDATE without `WHERE`, `DROP`, and `TRUNCATE` require explicit confirmation |
| 🖥️ **Browser GUI** | Paginated grid, inline cell editing, row delete, schema view, and a SQL editor with EXPLAIN + timing |
| 🕸️ **ERD visualizer** | Interactive entity-relationship diagram per connection, with foreign-key edges and click-to-open tables |
| 🗂️ **Unified dashboard** | Open several projects at once and see them all in one GUI, grouped by project |
| 📡 **Live agent feed** | Watch every MCP tool call stream into the browser in real time |
| 🪶 **No native builds** | SQLite uses Node's built-in `node:sqlite` — nothing to compile |

---

## 📦 Setup

### 1. Install

```bash
npm install -g sqlmate-mcp
```

### 2. Register with your editor

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add --transport stdio sqlmate-mcp sqlmate-mcp
```
</details>

<details>
<summary><b>Zed</b></summary>

Open your Zed `settings.json` (<kbd>Cmd/Ctrl</kbd> + <kbd>,</kbd>) and add:

```json
{
  "context_servers": {
    "sqlmate-mcp": {
      "command": "sqlmate-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

To pin a specific project's database, set `SQLMATE_PROJECT_ROOT` in the `env` block:

```json
{
  "context_servers": {
    "sqlmate-mcp": {
      "command": "sqlmate-mcp",
      "args": [],
      "env": { "SQLMATE_PROJECT_ROOT": "/absolute/path/to/your/project" }
    }
  }
}
```

The sqlmate-mcp tools then appear in the Zed Agent Panel.
</details>

### 3. That's it

sqlmate-mcp reads connections from the **root of whichever project you open** (the directory you launch your editor from). Each project uses its own `.env` or `.sqlmaterc` — no global config. See [Connection Setup](#-connection-setup).

---

## 🔧 Connection Setup

sqlmate-mcp reads connections from your **project root** at startup (defaults to `cwd`, override with `SQLMATE_PROJECT_ROOT`).

### Option 1 — `.env`

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
DATABASE_URL=postgres://postgres:secret@127.0.0.1:5432/myapp
```

Supported schemes: `mysql`, `mariadb`, `sqlite`, `sqlserver` / `mssql`, `pgsql` / `postgres` / `postgresql`.

### Option 2 — `.sqlmaterc`

A JSON array of connection objects in your project root:

```json
[
  { "name": "Local MySQL", "type": "mysql", "host": "127.0.0.1", "port": 3306, "username": "root", "password": "", "database": "myapp" },
  { "name": "App SQLite", "type": "sqlite", "path": "./database/app.db" },
  { "name": "Local Postgres", "type": "postgres", "host": "127.0.0.1", "port": 5432, "username": "postgres", "password": "", "database": "myapp" }
]
```

A copy-paste starting point lives in [`docs/sqlmaterc-example.json`](docs/sqlmaterc-example.json).

---

## 🛠️ MCP Tools

| Tool | Description |
|------|-------------|
| `list_connections` | List all detected connections (id, name, type, source) |
| `add_connection` | Add a connection for the session via URL, config file, or params |
| `list_tables(connectionId)` | List table names for a connection |
| `describe_table(connectionId, table)` | Column names, types, nullability, and primary key info |
| `get_schema(connectionId, [table])` | Full schema graph — columns, PKs, foreign keys, and indexes |
| `run_query(connectionId, sql)` | Run a read-only query (SELECT, EXPLAIN, SHOW, PRAGMA) |
| `explain_query(connectionId, sql, [analyze])` | Return the execution plan; `analyze` runs read-only statements for real timing |
| `run_write(connectionId, sql)` | Run an INSERT, UPDATE, DELETE, or DDL statement |

> `run_write` runs a risk assessment first. Operations affecting all rows (no `WHERE`), `DROP`, `TRUNCATE`, or `ALTER…DROP COLUMN` pause and ask Claude to confirm with `confirm: true` before proceeding.

---

## 🖥️ Browser GUI

Available at **`http://localhost:4737`** once the [GUI daemon](#run-the-gui-as-a-standalone-daemon) is running.

- 📄 Browse any table with a paginated data grid
- ✏️ Click a cell to edit it inline; delete rows with the trash icon
- 🔀 Toggle between data view and column schema view
- 💬 Run arbitrary SQL in the built-in editor, with **Explain** for the plan and per-query timing
- 🕸️ Visualize a database as an interactive **ERD** — PK/FK badges, relationship edges, click-to-open
- 🔄 Reconnect a database without restarting the server
- 📡 Watch a live feed of every MCP tool call Claude makes

<table>
<tr>
<td width="50%"><img src="docs/screenshots/sql-editor.png" alt="Built-in SQL editor with query results, timing, and an Explain button"><br><sub><b>SQL editor</b> — run queries with EXPLAIN and per-query timing</sub></td>
<td width="50%"><img src="docs/screenshots/schema.png" alt="Column schema view showing types, nullability, and primary keys"><br><sub><b>Schema view</b> — columns, types, nullability, and keys</sub></td>
</tr>
</table>

<img src="docs/screenshots/erd.png" alt="Interactive entity-relationship diagram with foreign-key edges and a minimap" width="100%">
<sub><b>ERD visualizer</b> — an interactive diagram of every table and its relationships</sub>

---

## 🗂️ Multiple Projects, One Dashboard

Open your editor in more than one project at a time and each runs its own sqlmate-mcp process — but you only ever see **one** browser GUI, showing **all** projects at once.

- The sidebar groups connections by project (each labeled with its host/database); open tables, run SQL, and view ERDs across projects side by side. The live feed spans every project, labeled by project.
- Every MCP process is **attach-only**: it never binds the GUI port itself and never opens a browser tab. It just registers its connections with whatever GUI is already running and streams its tool activity into the live feed.

This means the GUI's lifetime is decoupled from any single editor session — see below.

### Run the GUI as a standalone daemon

Instead of a browser tab popping up (and a new host getting elected) every time an editor session starts, run the GUI once as its own long-lived process and let every sqlmate-mcp process just attach to it:

```bash
sqlmate-mcp gui                       # start the GUI daemon, opens the browser once
sqlmate-mcp gui --install-autostart   # (Windows) start it automatically at login
sqlmate-mcp gui --uninstall-autostart # remove the login item
```

- If no daemon is running, an MCP process just logs a hint to stderr and keeps working without a GUI — it retries attaching in the background every 30s, so starting the daemon later (or after it restarts) picks the session back up without restarting your editor.
- Running `sqlmate-mcp gui` again while one is already running just opens the browser to the existing instance instead of erroring.
- `--install-autostart` drops a hidden startup shortcut (`%APPDATA%\...\Startup\sqlmate-gui.vbs`) that launches `sqlmate-mcp gui` at login with no visible console window. If the project lives on a drive that isn't attached yet at login (a mapped or slow-to-mount drive), it waits — checking every 3s, up to 5 minutes by default — instead of failing silently. Override with `--max-wait=<seconds>`, e.g. `sqlmate-mcp gui --install-autostart --max-wait=60`.

Fully optional — without it, sqlmate-mcp behaves as a normal attach-only client and simply runs with no GUI until you start one.

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SQLMATE_PROJECT_ROOT` | `cwd` | Directory to search for `.env` and `.sqlmaterc` |
| `SQLMATE_PORT` | `4737` | Port for the browser GUI |
| `SQLMATE_NO_OPEN` | — | Set to `1` to skip auto-opening the browser |

---

## 🧑‍💻 Development

```bash
git clone https://github.com/adamrpostjr/sqlmate-mcp.git
cd sqlmate-mcp
npm install
npm run build      # builds the Svelte GUI into /public

node src/index.js  # start the backend (serves the GUI at :4737)

cd frontend && npm run dev   # frontend hot-reload (proxies /api to :4737)
```

The frontend is **Svelte 5 + Vite + Tailwind**. Production build output goes to `/public`, served statically by Express. Backend is pure Node.js ES modules — no TypeScript, no build step.

---

## 📋 Requirements

- **Node.js ≥ 22.5** (for the native `node:sqlite` module)

---

<div align="center">

## 📄 License

[MIT](LICENSE) &nbsp;·&nbsp; Built by [Adam Post](https://github.com/adamrpostjr)

**If sqlmate-mcp saves you a trip to a database client, consider giving it a ⭐**

</div>
