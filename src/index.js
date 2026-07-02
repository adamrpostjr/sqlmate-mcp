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
import { closeAll } from './drivers.js'

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

async function shutdown() {
  process.stderr.write('[sqlmate] Shutting down...\n')
  await closeAll()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await Promise.all([
  startMcpServer(connections, projectRoot),
  startGuiServer(connections, port, projectRoot)
])

if (process.env.SQLMATE_NO_OPEN !== '1' && connections.length > 0) {
  try {
    const { default: open } = await import('open')
    await open(`http://localhost:${port}`)
  } catch {}
}
