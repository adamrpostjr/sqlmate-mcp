import express from 'express'
import { fileURLToPath } from 'url'
import path from 'path'
import { getDriver, reconnect as reconnectDriver } from './drivers.js'
import emitter from './events.js'
import { APP, PROTOCOL_VERSION } from './protocol.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, '..', 'public')

function apiErr(res, err, status = 500) {
  res.status(status).json({ error: err?.message || String(err) })
}

async function getPk(driver, table) {
  try {
    const cols = await driver.describeTable(table)
    const pkCol = cols.find(c => c.pk)
    return pkCol ? pkCol.column : (cols[0]?.column ?? 'id')
  } catch {
    return 'id'
  }
}

export function startGuiServer(registry, port) {
  const app = express()
  app.use(express.json())

  // ── SSE live events ────────────────────────────────────────────────────────
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    // Scope everything to the requesting browser's own project: in the shared
    // multi-project GUI, another attached project's SQL text, error messages,
    // and even its existence/path must never reach a tab that isn't theirs.
    // A missing or empty projectId fails closed (matches nothing) — nothing
    // needs an "unfiltered" fallback since the frontend always sends its own
    // project's id, and this is the one place that decides what a tab can see.
    const projectId = req.query.projectId
    const isMine = (data) => data.projectId === projectId

    const onStart = (data) => { if (isMine(data)) res.write(`event: tool_start\ndata: ${JSON.stringify(data)}\n\n`) }
    const onEnd = (data) => { if (isMine(data)) res.write(`event: tool_end\ndata: ${JSON.stringify(data)}\n\n`) }
    const onChanged = (snapshot) => {
      const mine = snapshot.filter(isMine)
      res.write(`event: projects_changed\ndata: ${JSON.stringify(mine)}\n\n`)
    }

    emitter.on('feed_tool_start', onStart)
    emitter.on('feed_tool_end', onEnd)
    emitter.on('projects_changed', onChanged)

    // Rehydrate a (re)connecting browser with the current state immediately.
    onChanged(registry.snapshot())

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000)

    req.on('close', () => {
      emitter.off('feed_tool_start', onStart)
      emitter.off('feed_tool_end', onEnd)
      emitter.off('projects_changed', onChanged)
      clearInterval(keepAlive)
    })
  })

  // ── REST API ───────────────────────────────────────────────────────────────
  app.get('/api/info', (req, res) => {
    res.json({
      app: APP,
      protocolVersion: PROTOCOL_VERSION,
      port,
      pid: process.pid,
      selfProjectId: registry.getSelfProjectId(),
      projects: registry.snapshot()
    })
  })

  // ── Host protocol (attach.js uplinks talk to these) ─────────────────────────
  app.post('/api/host/register', (req, res) => {
    const { protocolVersion, projectRoot, connections } = req.body || {}
    if (protocolVersion !== PROTOCOL_VERSION) {
      return res.status(409).json({ error: 'protocol mismatch', hostProtocolVersion: PROTOCOL_VERSION })
    }
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
      return apiErr(res, new Error('projectRoot is required'), 400)
    }
    const { projectId } = registry.register({ projectRoot, connections: connections || [] })
    res.json({ ok: true, projectId })
  })

  app.post('/api/host/heartbeat', (req, res) => {
    const { projectId } = req.body || {}
    if (registry.heartbeat(projectId)) {
      res.json({ ok: true })
    } else {
      res.status(404).json({ ok: false, unknownProject: true })
    }
  })

  app.post('/api/host/events', (req, res) => {
    const { type, data } = req.body || {}
    if (type !== 'tool_start' && type !== 'tool_end') {
      return apiErr(res, new Error('type must be tool_start or tool_end'), 400)
    }
    registry.handleToolEvent(type, data)
    res.json({ ok: true })
  })

  // Idempotent: removing an unknown project still returns ok. Note: dismissing
  // a *live* project (one still heartbeating) resurrects it within one
  // heartbeat interval — the ✕ in the UI is "remove stale now", not a ban.
  app.delete('/api/host/projects/:projectId', (req, res) => {
    registry.remove(req.params.projectId)
    res.json({ ok: true })
  })

  // ── Project-scoped connection routes ────────────────────────────────────────
  app.get('/api/projects/:projectId/connections', (req, res) => {
    const project = registry.snapshot().find(p => p.projectId === req.params.projectId)
    if (!project) return apiErr(res, new Error('Project not found'), 404)
    res.json(project.connections)
  })

  app.get('/api/projects/:projectId/connections/:id/tables', async (req, res) => {
    try {
      const conn = registry.findConnection(req.params.projectId, req.params.id)
      const driver = await getDriver(conn)
      res.json(await driver.listTables())
    } catch (err) { apiErr(res, err) }
  })

  app.get('/api/projects/:projectId/connections/:id/tables/:table/schema', async (req, res) => {
    try {
      const conn = registry.findConnection(req.params.projectId, req.params.id)
      const driver = await getDriver(conn)
      res.json(await driver.describeTable(req.params.table))
    } catch (err) { apiErr(res, err) }
  })

  app.get('/api/projects/:projectId/connections/:id/tables/:table/data', async (req, res) => {
    try {
      const conn = registry.findConnection(req.params.projectId, req.params.id)
      const driver = await getDriver(conn)
      const limit = Math.min(parseInt(req.query.limit) || 100, 1000)
      const offset = parseInt(req.query.offset) || 0
      const pk = await getPk(driver, req.params.table)
      res.json(await driver.getPaginatedRows(req.params.table, pk, limit, offset))
    } catch (err) { apiErr(res, err) }
  })

  app.patch('/api/projects/:projectId/connections/:id/tables/:table/rows', async (req, res) => {
    try {
      const { pk, pkValue, column, value } = req.body
      if (!pk || pkValue === undefined || !column) return apiErr(res, new Error('pk, pkValue, column required'), 400)
      const conn = registry.findConnection(req.params.projectId, req.params.id)
      const driver = await getDriver(conn)
      res.json(await driver.updateRow(req.params.table, pk, pkValue, column, value))
    } catch (err) { apiErr(res, err) }
  })

  app.delete('/api/projects/:projectId/connections/:id/tables/:table/rows', async (req, res) => {
    try {
      const { pk, pkValue } = req.body
      if (!pk || pkValue === undefined) return apiErr(res, new Error('pk and pkValue required'), 400)
      const conn = registry.findConnection(req.params.projectId, req.params.id)
      const driver = await getDriver(conn)
      res.json(await driver.deleteRow(req.params.table, pk, pkValue))
    } catch (err) { apiErr(res, err) }
  })

  app.post('/api/projects/:projectId/connections/:id/query', async (req, res) => {
    try {
      const { sql } = req.body
      if (!sql) return res.json({ rows: [], columns: [], error: 'No SQL provided' })
      const conn = registry.findConnection(req.params.projectId, req.params.id)
      const driver = await getDriver(conn)
      try {
        res.json(await driver.runQuery(sql))
      } catch (queryErr) {
        res.json({ rows: [], columns: [], error: queryErr.message })
      }
    } catch (err) { apiErr(res, err) }
  })

  app.post('/api/projects/:projectId/connections/:id/reconnect', async (req, res) => {
    try {
      const conn = registry.findConnection(req.params.projectId, req.params.id)
      await reconnectDriver(conn)
      res.json({ ok: true })
    } catch (err) { apiErr(res, err) }
  })

  // ── Static (built Svelte app) ──────────────────────────────────────────────
  app.use(express.static(PUBLIC_DIR))
  app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'))
  })

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      process.stderr.write(`[sqlmate] GUI available at http://localhost:${port}\n`)
      resolve(server)
    })
    server.on('error', reject)
  })
}
