import express from 'express'
import { fileURLToPath } from 'url'
import path from 'path'
import { getDriver, reconnect as reconnectDriver } from './drivers.js'
import emitter from './events.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, '..', 'public')

function apiErr(res, err, status = 500) {
  res.status(status).json({ error: err?.message || String(err) })
}

function findConn(connections, id) {
  const conn = connections.find(c => c.id === id)
  if (!conn) throw new Error(`Connection not found: ${id}`)
  return conn
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

export function startGuiServer(connections, port, projectRoot) {
  const app = express()
  app.use(express.json())

  // ── SSE live events ────────────────────────────────────────────────────────
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const onStart = (data) => res.write(`event: tool_start\ndata: ${JSON.stringify(data)}\n\n`)
    const onEnd = (data) => res.write(`event: tool_end\ndata: ${JSON.stringify(data)}\n\n`)
    const onChanged = (data) => res.write(`event: connections_changed\ndata: ${JSON.stringify(data)}\n\n`)

    emitter.on('tool_start', onStart)
    emitter.on('tool_end', onEnd)
    emitter.on('connections_changed', onChanged)

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000)

    req.on('close', () => {
      emitter.off('tool_start', onStart)
      emitter.off('tool_end', onEnd)
      emitter.off('connections_changed', onChanged)
      clearInterval(keepAlive)
    })
  })

  // ── REST API ───────────────────────────────────────────────────────────────
  app.get('/api/info', (req, res) => {
    res.json({ projectRoot, port })
  })

  app.get('/api/connections', (req, res) => {
    res.json(connections.map(c => ({ id: c.id, name: c.name, type: c.type, source: c.source })))
  })

  app.get('/api/connections/:id/tables', async (req, res) => {
    try {
      const conn = findConn(connections, req.params.id)
      const driver = await getDriver(conn)
      res.json(await driver.listTables())
    } catch (err) { apiErr(res, err) }
  })

  app.get('/api/connections/:id/tables/:table/schema', async (req, res) => {
    try {
      const conn = findConn(connections, req.params.id)
      const driver = await getDriver(conn)
      res.json(await driver.describeTable(req.params.table))
    } catch (err) { apiErr(res, err) }
  })

  app.get('/api/connections/:id/tables/:table/data', async (req, res) => {
    try {
      const conn = findConn(connections, req.params.id)
      const driver = await getDriver(conn)
      const limit = Math.min(parseInt(req.query.limit) || 100, 1000)
      const offset = parseInt(req.query.offset) || 0
      const pk = await getPk(driver, req.params.table)
      res.json(await driver.getPaginatedRows(req.params.table, pk, limit, offset))
    } catch (err) { apiErr(res, err) }
  })

  app.patch('/api/connections/:id/tables/:table/rows', async (req, res) => {
    try {
      const { pk, pkValue, column, value } = req.body
      if (!pk || pkValue === undefined || !column) return apiErr(res, new Error('pk, pkValue, column required'), 400)
      const conn = findConn(connections, req.params.id)
      const driver = await getDriver(conn)
      res.json(await driver.updateRow(req.params.table, pk, pkValue, column, value))
    } catch (err) { apiErr(res, err) }
  })

  app.delete('/api/connections/:id/tables/:table/rows', async (req, res) => {
    try {
      const { pk, pkValue } = req.body
      if (!pk || pkValue === undefined) return apiErr(res, new Error('pk and pkValue required'), 400)
      const conn = findConn(connections, req.params.id)
      const driver = await getDriver(conn)
      res.json(await driver.deleteRow(req.params.table, pk, pkValue))
    } catch (err) { apiErr(res, err) }
  })

  app.post('/api/connections/:id/query', async (req, res) => {
    try {
      const { sql } = req.body
      if (!sql) return res.json({ rows: [], columns: [], error: 'No SQL provided' })
      const conn = findConn(connections, req.params.id)
      const driver = await getDriver(conn)
      try {
        res.json(await driver.runQuery(sql))
      } catch (queryErr) {
        res.json({ rows: [], columns: [], error: queryErr.message })
      }
    } catch (err) { apiErr(res, err) }
  })

  app.post('/api/connections/:id/reconnect', async (req, res) => {
    try {
      findConn(connections, req.params.id)
      await reconnectDriver(req.params.id)
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
      resolve()
    })
    server.on('error', reject)
  })
}
