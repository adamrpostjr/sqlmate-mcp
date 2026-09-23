#!/usr/bin/env node
process.removeAllListeners('warning')
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') process.stderr.write(`[warn] ${w.message}\n`) })
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { loadConnections } from './connections.js'
import { startMcpServer } from './mcp.js'
import { startGuiServer } from './gui.js'
import { startAttach, probeHost } from './attach.js'
import { closeAll } from './drivers.js'
import { ProjectRegistry } from './registry.js'
import { PROTOCOL_VERSION } from './protocol.js'

const selfPath = fileURLToPath(import.meta.url)
const mode = process.argv[2]

if (mode === 'gui') {
  await runGuiDaemon(process.argv.slice(3))
} else {
  await runMcpServer()
}

// ── GUI daemon: `node src/index.js gui` ──────────────────────────────────────
// A long-lived process, independent of any single Claude Code session, that
// owns the GUI server. Run it once (e.g. at login) and every MCP process
// started afterwards just attaches to it — no per-session host election, no
// repeated browser tabs. See runMcpServer() below.
async function runGuiDaemon(args) {
  if (args.includes('--install-autostart')) return installAutostart()
  if (args.includes('--uninstall-autostart')) return uninstallAutostart()

  const port = parseInt(process.env.SQLMATE_PORT) || 4737
  const registry = new ProjectRegistry()

  let server
  try {
    server = await startGuiServer(registry, port)
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      const info = await probeHost(port)
      if (info && info.protocolVersion === PROTOCOL_VERSION) {
        process.stderr.write(`[sqlmate] GUI daemon already running at http://localhost:${port} (pid ${info.pid}).\n`)
        await openBrowser(port)
        process.exit(0)
      }
      if (info) {
        process.stderr.write(`[sqlmate] Port ${port} is occupied by an incompatible sqlmate-mcp version (protocol ${info.protocolVersion}, ours ${PROTOCOL_VERSION}).\n`)
      } else {
        process.stderr.write(`[sqlmate] Port ${port} is already in use by something else. Set SQLMATE_PORT to pick a different port.\n`)
      }
      process.exit(1)
    }
    process.stderr.write(`[sqlmate] GUI daemon failed to start: ${err?.message || err}\n`)
    process.exit(1)
  }

  registry.startGc()
  process.stderr.write('[sqlmate] GUI daemon running. MCP processes will attach to it automatically.\n')
  await openBrowser(port)

  async function shutdown() {
    process.stderr.write('[sqlmate] GUI daemon shutting down...\n')
    registry.stopGc()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function openBrowser(port) {
  if (process.env.SQLMATE_NO_OPEN === '1') return
  try {
    const { default: open } = await import('open')
    await open(`http://localhost:${port}`)
  } catch {}
}

function startupDir() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}
const AUTOSTART_NAME = 'sqlmate-gui.vbs'

function installAutostart() {
  if (process.platform !== 'win32') {
    process.stderr.write('[sqlmate] --install-autostart is only implemented for Windows. Wire up your own login item for other platforms.\n')
    process.exit(1)
  }
  const dir = startupDir()
  const target = path.join(dir, AUTOSTART_NAME)
  // WScript.Shell.Run with windowStyle 0 launches `node ... gui` fully hidden
  // (no console flash) and doesn't wait for it to exit.
  const vbs = `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "node ""${selfPath}"" gui", 0, False\r\n`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(target, vbs)
  process.stderr.write(`[sqlmate] Installed autostart: ${target}\n`)
  process.stderr.write('[sqlmate] The GUI daemon will now start automatically at login. Remove it with:\n')
  process.stderr.write(`  node ${selfPath} gui --uninstall-autostart\n`)
}

function uninstallAutostart() {
  const target = path.join(startupDir(), AUTOSTART_NAME)
  if (fs.existsSync(target)) {
    fs.unlinkSync(target)
    process.stderr.write(`[sqlmate] Removed autostart: ${target}\n`)
  } else {
    process.stderr.write('[sqlmate] No autostart entry found.\n')
  }
}

// ── MCP server: `node src/index.js` (what Claude Code launches) ─────────────
// Always attach-only — this process never binds the GUI port or opens a
// browser itself. If no GUI daemon is reachable it just runs without a GUI
// and keeps retrying in the background, so starting the daemon later (or it
// restarting) picks the session back up without a restart.
async function runMcpServer() {
  function hasSqlmateConfig(dir) {
    if (fs.existsSync(path.join(dir, '.sqlmaterc'))) return true
    const envPath = path.join(dir, '.env')
    if (!fs.existsSync(envPath)) return false
    try {
      const raw = fs.readFileSync(envPath, 'utf8')
      return /DB_CONNECTION|DB_HOST|DB_DATABASE|DATABASE_URL|DB_URL|DB_PATH|DB_USER|DB_PASS|DB_NAME|DB_PORT/i.test(raw)
    } catch { return false }
  }

  function findProjectRoot(start) {
    let dir = start
    while (true) {
      if (hasSqlmateConfig(dir)) return dir
      const parent = path.dirname(dir)
      if (parent === dir) return start
      dir = parent
    }
  }

  const projectRoot = process.env.SQLMATE_PROJECT_ROOT ?? findProjectRoot(process.cwd())
  const port = parseInt(process.env.SQLMATE_PORT) || 4737

  const connections = loadConnections(projectRoot)
  process.stderr.write(`[sqlmate] Loaded ${connections.length} connection(s):\n`)
  for (const c of connections) {
    process.stderr.write(`  - ${c.name} (${c.type}) from ${c.source}\n`)
  }
  if (connections.length === 0) {
    process.stderr.write('[sqlmate] No connections found. Add a .env or .sqlmaterc to your project root.\n')
  }

  const registeredFlag = path.join(os.homedir(), '.sqlmate-registered')
  if (!fs.existsSync(registeredFlag)) {
    process.stderr.write('\n[sqlmate] First run! Register with Claude Code:\n')
    process.stderr.write(`  claude mcp add --transport stdio sqlmate-mcp node ${selfPath}\n\n`)
    try { fs.writeFileSync(registeredFlag, new Date().toISOString()) } catch {}
  }

  await startMcpServer(connections, projectRoot)

  let attach = null
  let hintedNoDaemon = false
  let retryTimer = null

  async function tryAttach() {
    const info = await probeHost(port)
    if (!info) return null
    if (info.protocolVersion !== PROTOCOL_VERSION) {
      process.stderr.write(`[sqlmate] GUI daemon at port ${port} is running an incompatible protocol version (${info.protocolVersion}, ours ${PROTOCOL_VERSION}). Skipping GUI.\n`)
      return null
    }
    try {
      return await startAttach({ port, projectRoot, connections, onHostGone: handleHostGone })
    } catch (err) {
      process.stderr.write(`[sqlmate] Failed to attach to GUI daemon: ${err?.message || err}\n`)
      return null
    }
  }

  async function connectToGui() {
    attach = await tryAttach()
    if (attach) {
      process.stderr.write('[sqlmate] Attached to GUI daemon.\n')
      if (retryTimer) { clearInterval(retryTimer); retryTimer = null }
      return
    }
    if (!hintedNoDaemon) {
      hintedNoDaemon = true
      process.stderr.write(`[sqlmate] No GUI daemon running. Start one with: node ${selfPath} gui\n`)
      process.stderr.write(`[sqlmate] (or install it to start automatically at login: node ${selfPath} gui --install-autostart)\n`)
    }
    if (!retryTimer) {
      retryTimer = setInterval(() => { connectToGui().catch(() => {}) }, 30_000)
      retryTimer.unref()
    }
  }

  function handleHostGone() {
    attach = null
    connectToGui().catch(() => {})
  }

  await connectToGui()

  async function shutdown() {
    process.stderr.write('[sqlmate] Shutting down...\n')
    if (retryTimer) clearInterval(retryTimer)
    if (attach) await attach.stop()
    await closeAll()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
