import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { startMcpServer } from '../src/mcp.js'
import { closeAll } from '../src/drivers.js'
import emitter from '../src/events.js'

// Connects a real MCP Client to startMcpServer over an in-process transport
// (no stdio involved) so tool handlers run exactly as they do in production.
async function withMcpClient(connections, projectRoot, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await startMcpServer(connections, projectRoot, { transport: serverTransport })

  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

function collectToolStart() {
  const seen = []
  const onStart = (data) => seen.push(data)
  emitter.on('tool_start', onStart)
  return { seen, stop: () => emitter.off('tool_start', onStart) }
}

// run_write only permits INSERT/UPDATE/DELETE, so the fixture table has to
// exist before the tool ever runs — use a real file so schema setup done via
// a throwaway DatabaseSync is visible to the driver opened inside mcp.js.
const fixtureFiles = []
function makeSqliteFixture(name, seedRows = []) {
  const file = path.join(os.tmpdir(), `sqlmate-mcp-test-${name}-${process.pid}.sqlite`)
  fixtureFiles.push(file)
  if (fs.existsSync(file)) fs.rmSync(file)
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
  for (const val of seedRows) db.prepare('INSERT INTO t (val) VALUES (?)').run(val)
  db.close()
  return file
}

function makeSqliteFixtureWithPasswordColumn(name) {
  const file = path.join(os.tmpdir(), `sqlmate-mcp-test-${name}-${process.pid}.sqlite`)
  fixtureFiles.push(file)
  if (fs.existsSync(file)) fs.rmSync(file)
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, password TEXT)')
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

describe('run_query / run_write telemetry', () => {
  test('run_write truncates the emitted sql to 300 chars but executes the full statement', async () => {
    const path_ = makeSqliteFixture('write')
    const connections = [{
      id: 'mem-write', name: 'Mem Write', type: 'sqlite', path: path_, source: 'test', projectRoot: '/proj/write'
    }]
    await withMcpClient(connections, '/proj/write', async (client) => {
      const { seen, stop } = collectToolStart()
      try {
        const values = Array.from({ length: 50 }, (_, i) => `('padding-value-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')`)
        const bigInsert = `INSERT INTO t (val) VALUES ${values.join(', ')}`
        assert.ok(bigInsert.length > 300, 'fixture sql must exceed the truncation threshold')

        const result = await client.callTool({
          name: 'run_write',
          arguments: { connectionId: 'mem-write', sql: bigInsert, project_root: '/proj/write' }
        })

        const insertEvent = seen.find(e => e.tool === 'run_write')
        assert.ok(insertEvent, 'expected a tool_start event for the INSERT')
        assert.equal(insertEvent.args.sql.length, 300)
        assert.equal(insertEvent.args.sql, bigInsert.slice(0, 300))

        const payload = JSON.parse(result.content[0].text)
        assert.equal(payload.affectedRows, values.length, 'the full untruncated statement must still execute')
      } finally {
        stop()
      }
    })
  })

  test('run_query truncates the emitted sql to 300 chars but executes the full statement', async () => {
    const path_ = makeSqliteFixture('query', ['hello'])
    const connections = [{
      id: 'mem-query', name: 'Mem Query', type: 'sqlite', path: path_, source: 'test', projectRoot: '/proj/query'
    }]
    await withMcpClient(connections, '/proj/query', async (client) => {
      const { seen, stop } = collectToolStart()
      try {
        const padding = 'x'.repeat(400)
        const longQuery = `SELECT val FROM t WHERE val = 'hello' OR val = '${padding}'`
        assert.ok(longQuery.length > 300, 'fixture sql must exceed the truncation threshold')

        const result = await client.callTool({
          name: 'run_query',
          arguments: { connectionId: 'mem-query', sql: longQuery, project_root: '/proj/query' }
        })

        const queryEvent = seen.find(e => e.tool === 'run_query')
        assert.ok(queryEvent, 'expected a tool_start event for the SELECT')
        assert.equal(queryEvent.args.sql.length, 300)
        assert.equal(queryEvent.args.sql, longQuery.slice(0, 300))

        const payload = JSON.parse(result.content[0].text)
        assert.equal(payload.rows.length, 1, 'the full untruncated query must still run correctly')
        assert.equal(payload.rows[0].val, 'hello')
      } finally {
        stop()
      }
    })
  })
})

describe('secret redaction in the live feed', () => {
  test('redacts password/token-style literals from the emitted sql', async () => {
    const path_ = makeSqliteFixture('redact-write')
    const connections = [{
      id: 'mem-redact-write', name: 'Mem Redact Write', type: 'sqlite', path: path_, source: 'test', projectRoot: '/proj/redact-write'
    }]
    await withMcpClient(connections, '/proj/redact-write', async (client) => {
      const { seen, stop } = collectToolStart()
      try {
        const sql = "UPDATE t SET val = 'ok' WHERE val = 'anything' -- password: 'hunter2'"
        await client.callTool({
          name: 'run_write',
          arguments: { connectionId: 'mem-redact-write', sql, project_root: '/proj/redact-write' }
        })

        const event = seen.find(e => e.tool === 'run_write')
        assert.ok(event, 'expected a tool_start event for the UPDATE')
        assert.ok(!event.args.sql.includes('hunter2'), 'the secret value must not appear in the emitted sql')
        assert.ok(event.args.sql.includes('[REDACTED]'))
      } finally {
        stop()
      }
    })
  })

  test('redacts credentials embedded in connection-URL-style literals', async () => {
    const path_ = makeSqliteFixture('redact-query')
    const connections = [{
      id: 'mem-redact-query', name: 'Mem Redact Query', type: 'sqlite', path: path_, source: 'test', projectRoot: '/proj/redact-query'
    }]
    await withMcpClient(connections, '/proj/redact-query', async (client) => {
      const { seen, stop } = collectToolStart()
      try {
        const sql = "SELECT val FROM t WHERE val = 'mysql://root:hunter2@localhost/app'"
        await client.callTool({
          name: 'run_query',
          arguments: { connectionId: 'mem-redact-query', sql, project_root: '/proj/redact-query' }
        })

        const event = seen.find(e => e.tool === 'run_query')
        assert.ok(event, 'expected a tool_start event for the SELECT')
        assert.ok(!event.args.sql.includes('hunter2'), 'the embedded credential must not appear in the emitted sql')
        assert.ok(event.args.sql.includes('[REDACTED]'))
      } finally {
        stop()
      }
    })
  })

  test('redacts literal values in column-list INSERT syntax, where the keyword and value are not adjacent', async () => {
    const path_ = makeSqliteFixtureWithPasswordColumn('redact-columnlist')
    const connections = [{
      id: 'mem-redact-cl', name: 'Mem Redact ColList', type: 'sqlite', path: path_, source: 'test', projectRoot: '/proj/redact-cl'
    }]
    await withMcpClient(connections, '/proj/redact-cl', async (client) => {
      const { seen, stop } = collectToolStart()
      try {
        const sql = "INSERT INTO users (email, password) VALUES ('a@b.com', 'hunter2')"
        const result = await client.callTool({
          name: 'run_write',
          arguments: { connectionId: 'mem-redact-cl', sql, project_root: '/proj/redact-cl' }
        })

        const event = seen.find(e => e.tool === 'run_write')
        assert.ok(event, 'expected a tool_start event for the INSERT')
        assert.ok(!event.args.sql.includes('hunter2'), 'the password value must not leak even though it is not adjacent to the "password" keyword')
        assert.ok(event.args.sql.includes('[REDACTED]'))

        const payload = JSON.parse(result.content[0].text)
        assert.equal(payload.affectedRows, 1, 'the full untouched statement must still execute against the real driver')
      } finally {
        stop()
      }
    })
  })

  test('redacts credentials embedded in an add_connection url before it is emitted', async () => {
    await withMcpClient([], '/proj/redact-add', async (client) => {
      const { seen, stop } = collectToolStart()
      try {
        await client.callTool({
          name: 'add_connection',
          arguments: { url: 'mysql://root:hunter2@db.internal:3306/app' }
        })

        const event = seen.find(e => e.tool === 'add_connection')
        assert.ok(event, 'expected a tool_start event for add_connection')
        assert.ok(!event.args.url.includes('hunter2'), 'the embedded credential must not appear in the emitted url')
        assert.ok(event.args.url.includes('[REDACTED]'))
      } finally {
        stop()
      }
    })
  })
})
