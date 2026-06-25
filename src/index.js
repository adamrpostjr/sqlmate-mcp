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

const projectRoot = process.env.SQLMATE_PROJECT_ROOT ?? process.cwd()
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
  startMcpServer(connections),
  startGuiServer(connections, port)
])

if (process.env.SQLMATE_NO_OPEN !== '1') {
  try {
    const { default: open } = await import('open')
    await open(`http://localhost:${port}`)
  } catch {}
}
