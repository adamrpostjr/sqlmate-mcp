import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { startGuiServer } from '../src/gui.js'
import { ProjectRegistry } from '../src/registry.js'
import { PROTOCOL_VERSION } from '../src/protocol.js'
import { closeAll } from '../src/drivers.js'

const fixtureFiles = []
function makeSqliteFixture(name) {
  const file = path.join(os.tmpdir(), `sqlmate-gui-test-${name}-${process.pid}.sqlite`)
  fixtureFiles.push(file)
  if (fs.existsSync(file)) fs.rmSync(file)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)')
  db.exec('CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author_id INTEGER REFERENCES authors(id))')
  db.exec('CREATE INDEX idx_books_title ON books(title)')
  db.close()
  return file
}

after(async () => {
  await closeAll()
  for (const file of fixtureFiles) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(file + suffix) } catch {}
    }
  }
})

// Boots a real server on an ephemeral port so we can exercise the host
// protocol/registry-backed routes end to end with the platform's fetch.
async function withServer(fn) {
  const registry = new ProjectRegistry()
  const server = await startGuiServer(registry, 0)
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  try {
    await fn({ registry, base })
  } finally {
    registry.stopGc()
    await new Promise(resolve => server.close(resolve))
  }
}

async function json(url, opts) {
  const res = await fetch(url, opts)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

function waitFor(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Opens the SSE endpoint, pumps the stream into a string buffer for the given
// window, then aborts. Long enough to catch anything emitted right after connect.
async function collectSse(url, { during = 250 } = {}) {
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
      }
    } catch { /* aborted */ }
  })()
  await waitFor(50) // let the server register its emitter listeners before we fire events
  return {
    buffer: () => buf,
    finish: async () => {
      await waitFor(during)
      controller.abort()
      await pump.catch(() => {})
      return buf
    }
  }
}

describe('GET /api/info', () => {
  test('reports app identity, protocol version, and an empty snapshot', async () => {
    await withServer(async ({ base }) => {
      const { status, body } = await json(`${base}/api/info`)
      assert.equal(status, 200)
      assert.equal(body.app, 'sqlmate-mcp')
      assert.equal(body.protocolVersion, PROTOCOL_VERSION)
      assert.equal(typeof body.pid, 'number')
      assert.deepEqual(body.projects, [])
      assert.equal(body.selfProjectId, null)
    })
  })

  test('reports selfProjectId once the self project is registered', async () => {
    await withServer(async ({ base, registry }) => {
      const { projectId } = registry.register({ projectRoot: '/proj/self', connections: [], self: true })
      registry.register({ projectRoot: '/proj/other', connections: [] })

      const { body } = await json(`${base}/api/info`)
      assert.equal(body.selfProjectId, projectId)
    })
  })
})

describe('GET /api/projects/:projectId/connections', () => {
  test('returns the credential-stripped connection list for a project', async () => {
    await withServer(async ({ base, registry }) => {
      const conn = { name: 'DB', type: 'mysql', host: 'h', database: 'd', username: 'u', password: 'p' }
      const { projectId } = registry.register({ projectRoot: '/proj/a', connections: [conn] })

      const { status, body } = await json(`${base}/api/projects/${projectId}/connections`)
      assert.equal(status, 200)
      assert.equal(body.length, 1)
      assert.equal(body[0].name, 'DB')
      assert.equal(body[0].password, undefined)
    })
  })

  test('404s for an unknown project', async () => {
    await withServer(async ({ base }) => {
      const { status } = await json(`${base}/api/projects/does-not-exist/connections`)
      assert.equal(status, 404)
    })
  })
})

describe('GET /api/projects/:projectId/connections/:id/schema-graph', () => {
  test('returns the schema graph for a real sqlite connection', async () => {
    await withServer(async ({ base, registry }) => {
      const file = makeSqliteFixture('schema-graph')
      const conn = { name: 'SQ', type: 'sqlite', path: file, source: 'test' }
      const { projectId } = registry.register({ projectRoot: '/proj/schema-graph', connections: [conn], self: true })
      const connId = registry.snapshot().find(p => p.projectId === projectId).connections[0].id

      const { status, body } = await json(`${base}/api/projects/${projectId}/connections/${connId}/schema-graph`)
      assert.equal(status, 200)
      assert.ok(Array.isArray(body.tables))
      const names = body.tables.map(t => t.name).sort()
      assert.deepEqual(names, ['authors', 'books'])

      const books = body.tables.find(t => t.name === 'books')
      assert.equal(books.foreignKeys.length, 1)
      assert.equal(books.foreignKeys[0].refTable, 'authors')
      assert.ok(books.indexes.some(idx => idx.columns.includes('title')))
    })
  })
})

describe('POST /api/host/register', () => {
  test('registers a project and reflects it in /api/info', async () => {
    await withServer(async ({ base }) => {
      const { status, body } = await json(`${base}/api/host/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, projectRoot: '/proj/a', connections: [] })
      })
      assert.equal(status, 200)
      assert.equal(body.ok, true)
      assert.equal(typeof body.projectId, 'string')

      const info = await json(`${base}/api/info`)
      assert.equal(info.body.projects.length, 1)
      assert.equal(info.body.projects[0].projectId, body.projectId)
    })
  })

  test('rejects a protocol mismatch with 409', async () => {
    await withServer(async ({ base }) => {
      const { status, body } = await json(`${base}/api/host/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION + 1, projectRoot: '/proj/a', connections: [] })
      })
      assert.equal(status, 409)
      assert.equal(body.hostProtocolVersion, PROTOCOL_VERSION)
    })
  })

  test('rejects a missing projectRoot with 400', async () => {
    await withServer(async ({ base }) => {
      const { status } = await json(`${base}/api/host/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, connections: [] })
      })
      assert.equal(status, 400)
    })
  })
})

describe('POST /api/host/heartbeat', () => {
  test('returns ok for a known project and 404 for an unknown one', async () => {
    await withServer(async ({ base, registry }) => {
      const { projectId } = registry.register({ projectRoot: '/proj/a', connections: [] })

      const known = await json(`${base}/api/host/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId })
      })
      assert.equal(known.status, 200)
      assert.equal(known.body.ok, true)

      const unknown = await json(`${base}/api/host/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'does-not-exist' })
      })
      assert.equal(unknown.status, 404)
      assert.equal(unknown.body.unknownProject, true)
    })
  })
})

describe('POST /api/host/events', () => {
  test('accepts tool_start/tool_end and rejects other types', async () => {
    await withServer(async ({ base }) => {
      const start = await json(`${base}/api/host/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'tool_start', data: { id: '1', projectRoot: '/proj/a' } })
      })
      assert.equal(start.status, 200)
      assert.equal(start.body.ok, true)

      const bad = await json(`${base}/api/host/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'nonsense', data: {} })
      })
      assert.equal(bad.status, 400)
    })
  })
})

describe('DELETE /api/host/projects/:projectId', () => {
  test('removes a known project and is idempotent for an unknown one', async () => {
    await withServer(async ({ base, registry }) => {
      const { projectId } = registry.register({ projectRoot: '/proj/a', connections: [] })

      const del = await json(`${base}/api/host/projects/${projectId}`, { method: 'DELETE' })
      assert.equal(del.status, 200)
      assert.equal(del.body.ok, true)
      assert.equal(registry.projects.has(projectId), false)

      const delAgain = await json(`${base}/api/host/projects/${projectId}`, { method: 'DELETE' })
      assert.equal(delAgain.status, 200)
      assert.equal(delAgain.body.ok, true)
    })
  })

  test('is a no-op for the self project, which has no heartbeat to resurrect it', async () => {
    await withServer(async ({ base, registry }) => {
      const { projectId } = registry.register({ projectRoot: '/proj/self', connections: [], self: true })

      const del = await json(`${base}/api/host/projects/${projectId}`, { method: 'DELETE' })
      assert.equal(del.status, 200)
      assert.equal(del.body.ok, true)
      assert.equal(registry.projects.has(projectId), true)
    })
  })
})

describe('GET /api/events', () => {
  test('only forwards tool_start/tool_end for the requesting projectId', async () => {
    await withServer(async ({ base, registry }) => {
      const { projectId: idA } = registry.register({ projectRoot: '/proj/a', connections: [] })
      registry.register({ projectRoot: '/proj/b', connections: [] })

      const sse = await collectSse(`${base}/api/events?projectId=${idA}`)
      registry.handleToolEvent('tool_start', { id: 'mine', tool: 'run_query', projectRoot: '/proj/a' })
      registry.handleToolEvent('tool_start', { id: 'theirs', tool: 'run_query', projectRoot: '/proj/b' })
      const buf = await sse.finish()

      assert.ok(buf.includes('"id":"mine"'), 'expected the requesting project\'s own event')
      assert.ok(!buf.includes('"id":"theirs"'), 'must not leak another project\'s event')
    })
  })

  test('fails closed (drops everything) when projectId is present but empty', async () => {
    await withServer(async ({ base, registry }) => {
      registry.register({ projectRoot: '/proj/a', connections: [] })

      const sse = await collectSse(`${base}/api/events?projectId=`)
      registry.handleToolEvent('tool_start', { id: 'x', tool: 'run_query', projectRoot: '/proj/a' })
      const buf = await sse.finish()

      assert.ok(!buf.includes('"id":"x"'))
    })
  })

  test('fails closed (drops everything) when projectId is omitted entirely', async () => {
    await withServer(async ({ base, registry }) => {
      registry.register({ projectRoot: '/proj/a', connections: [] })

      const sse = await collectSse(`${base}/api/events`)
      registry.handleToolEvent('tool_start', { id: 'x', tool: 'run_query', projectRoot: '/proj/a' })
      const buf = await sse.finish()

      assert.ok(!buf.includes('"id":"x"'), 'there is no legitimate consumer of the unfiltered feed, so omission must not bypass scoping')
    })
  })

  test('scopes the projects_changed snapshot to the requesting project only', async () => {
    await withServer(async ({ base, registry }) => {
      const { projectId: idA } = registry.register({ projectRoot: '/proj/a', connections: [] })
      registry.register({ projectRoot: '/proj/secret-client', connections: [] })

      const sse = await collectSse(`${base}/api/events?projectId=${idA}`)
      const buf = await sse.finish()

      assert.ok(buf.includes('/proj/a'), 'own project should still be visible')
      assert.ok(!buf.includes('/proj/secret-client'), 'another project\'s path must not leak into this tab\'s snapshot')
    })
  })

  test('with ?all=1 the unified dashboard sees every project in the snapshot', async () => {
    await withServer(async ({ base, registry }) => {
      const { projectId: idA } = registry.register({ projectRoot: '/proj/a', connections: [], self: true })
      const { projectId: idB } = registry.register({ projectRoot: '/proj/b', connections: [] })

      const sse = await collectSse(`${base}/api/events?all=1`)
      const buf = await sse.finish()

      assert.ok(buf.includes(idA), 'own project should be visible')
      assert.ok(buf.includes(idB), 'other projects should be visible in the unified view')
      assert.ok(buf.includes('/proj/a') && buf.includes('/proj/b'), 'all project roots should be present')
    })
  })

  test('with ?all=1 tool activity from every project is forwarded', async () => {
    await withServer(async ({ base, registry }) => {
      registry.register({ projectRoot: '/proj/a', connections: [], self: true })
      registry.register({ projectRoot: '/proj/b', connections: [] })

      const sse = await collectSse(`${base}/api/events?all=1`)
      registry.handleToolEvent('tool_start', { id: 'from-a', tool: 'run_query', projectRoot: '/proj/a' })
      registry.handleToolEvent('tool_start', { id: 'from-b', tool: 'run_query', projectRoot: '/proj/b' })
      const buf = await sse.finish()

      assert.ok(buf.includes('"id":"from-a"'), 'own project event should appear')
      assert.ok(buf.includes('"id":"from-b"'), 'other project event should appear in the unified feed')
    })
  })
})
