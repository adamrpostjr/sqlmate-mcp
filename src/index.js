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
import emitter from './events.js'

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
  const selfPath = fileURLToPath(import.meta.url)
  process.stderr.write('\n[sqlmate] First run! Register with Claude Code:\n')
  process.stderr.write(`  claude mcp add --transport stdio sqlmate-mcp node ${selfPath}\n\n`)
  try { fs.writeFileSync(registeredFlag, new Date().toISOString()) } catch {}
}

const registry = new ProjectRegistry()
registry.register({ projectRoot, connections, self: true })
registry.startGc()

// mcp.js mutates `connections` in place (push/splice), so re-registering here
// with the same array reference picks up runtime add_connection/list_connections changes.
emitter.on('connections_changed', () => registry.register({ projectRoot, connections, self: true }))

await startMcpServer(connections, projectRoot)

let guiEstablished = false
let attach = null
let localEventsWired = false

function wireLocalEventsOnce() {
  if (localEventsWired) return
  localEventsWired = true
  emitter.on('tool_start', d => registry.handleToolEvent('tool_start', d))
  emitter.on('tool_end', d => registry.handleToolEvent('tool_end', d))
}

async function openBrowser() {
  if (process.env.SQLMATE_NO_OPEN === '1' || connections.length === 0) return
  try {
    const { default: open } = await import('open')
    await open(`http://localhost:${port}`)
  } catch {}
}

async function becomeHostOrAttach() {
  try {
    await startGuiServer(registry, port)
    wireLocalEventsOnce()
    attach = null
    guiEstablished = true
    process.stderr.write('[sqlmate] Running as GUI host.\n')
    // Only the process that actually stands up the GUI opens a browser tab —
    // an attaching process shares an already-open GUI, so it must not.
    await openBrowser()
    return
  } catch (err) {
    if (err?.code !== 'EADDRINUSE') {
      process.stderr.write(`[sqlmate] GUI server failed to start: ${err?.message || err}\n`)
      return
    }
  }

  // Port taken — see if it's a compatible sqlmate host we can attach to.
  const info = await probeHost(port)
  if (!info) {
    process.stderr.write(`[sqlmate] Port ${port} is in use by something other than sqlmate-mcp. Continuing without GUI.\n`)
    return
  }
  if (info.protocolVersion !== PROTOCOL_VERSION) {
    process.stderr.write(`[sqlmate] Port ${port} is occupied by an incompatible sqlmate-mcp version (host protocol ${info.protocolVersion}, ours ${PROTOCOL_VERSION}). Continuing without GUI.\n`)
    return
  }

  try {
    attach = await startAttach({
      port,
      projectRoot,
      connections,
      onHostGone: () => {
        attach = null
        guiEstablished = false
        becomeHostOrAttach().catch(err => {
          process.stderr.write(`[sqlmate] Failed to take over GUI host: ${err?.message || err}\n`)
        })
      }
    })
    guiEstablished = true
    process.stderr.write('[sqlmate] Attached to existing GUI host.\n')
  } catch (err) {
    process.stderr.write(`[sqlmate] Failed to attach to existing GUI host: ${err?.message || err}\n`)
  }
}

await becomeHostOrAttach()

async function shutdown() {
  process.stderr.write('[sqlmate] Shutting down...\n')
  if (attach) await attach.stop()
  registry.stopGc()
  await closeAll()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
