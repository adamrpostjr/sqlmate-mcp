import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { getDriver } from './drivers.js'
import emitter from './events.js'
import { parseConnectionInput } from './connections.js'

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function fail(err) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true }
}

function findConn(connections, id) {
  const conn = connections.find(c => c.id === id)
  if (!conn) throw new Error(`Connection not found: ${id}`)
  return conn
}

function emitStart(tool, connectionId, args) {
  const id = randomUUID()
  const timestamp = new Date().toISOString()
  emitter.emit('tool_start', { id, tool, connectionId, args, timestamp })
  return { id, startMs: Date.now() }
}

function emitEnd(id, startMs, result) {
  emitter.emit('tool_end', {
    id,
    duration: Date.now() - startMs,
    rowCount: Array.isArray(result?.rows) ? result.rows.length
      : Array.isArray(result) ? result.length
      : undefined,
    error: null
  })
}

function emitError(id, startMs, err) {
  emitter.emit('tool_end', {
    id,
    duration: Date.now() - startMs,
    error: err.message
  })
}

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
}

function assessRisk(sql) {
  const clean = stripComments(sql)
  const upper = clean.toUpperCase()
  const first = upper.split(/\s+/)[0]

  if (first === 'DELETE') {
    const hasWhere = /\bWHERE\b/i.test(clean)
    return {
      risky: true,
      reason: hasWhere
        ? 'DELETE statement will permanently remove all matching rows.'
        : 'DELETE without a WHERE clause will remove EVERY row in the table.'
    }
  }

  if (first === 'UPDATE') {
    const hasWhere = /\bWHERE\b/i.test(clean)
    if (!hasWhere) {
      return {
        risky: true,
        reason: 'UPDATE without a WHERE clause will overwrite EVERY row in the table.'
      }
    }
    return { risky: false }
  }

  if (first === 'TRUNCATE') {
    return {
      risky: true,
      reason: 'TRUNCATE will permanently delete ALL rows and cannot be rolled back.'
    }
  }

  if (first === 'DROP') {
    const target = upper.match(/DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW)\b/)?.[1] || 'object'
    return {
      risky: true,
      reason: `DROP ${target} will permanently destroy the ${target.toLowerCase()} and all its data.`
    }
  }

  if (first === 'ALTER') {
    const dropsColumn = /\bDROP\s+COLUMN\b/i.test(clean)
    if (dropsColumn) {
      return {
        risky: true,
        reason: 'ALTER TABLE ... DROP COLUMN will permanently delete the column and all its data.'
      }
    }
    return { risky: false }
  }

  return { risky: false }
}

export async function startMcpServer(connections) {
  const server = new McpServer({ name: 'sqlmate-mcp', version: '1.0.0' })

  server.tool(
    'list_connections',
    'List all configured database connections. If no connections are found, returns setup instructions.',
    {},
    async () => {
      const { id, startMs } = emitStart('list_connections', null, {})
      try {
        if (connections.length === 0) {
          emitEnd(id, startMs, [])
          return ok({
            connections: [],
            setup_required: true,
            message: 'No database connections are configured for this project.',
            instructions: [
              'Use the add_connection tool to configure a connection. Options:',
              '  1. Connection URL:  { url: "mysql://user:pass@host:3306/dbname" }',
              '  2. Config file:     { file: "/path/to/.sqlmaterc" }  or  { file: "/path/to/.env" }',
              '  3. Manual params:   { type: "mysql", host: "localhost", port: 3306, username: "root", password: "secret", database: "myapp", name: "My DB" }',
              '  Supported types: mysql, sqlite, mssql'
            ].join('\n')
          })
        }
        const result = connections.map(c => ({ id: c.id, name: c.name, type: c.type, source: c.source }))
        emitEnd(id, startMs, result)
        return ok(result)
      } catch (err) { emitError(id, startMs, err); return fail(err) }
    }
  )

  server.tool(
    'add_connection',
    [
      'Configure a database connection for this session.',
      'Provide ONE of: (a) url — a connection URL like mysql://user:pass@host:3306/db or sqlite:///path/to/db.sqlite,',
      '(b) file — an absolute path to a .sqlmaterc (JSON) or .env file containing DB credentials,',
      '(c) individual params — type (mysql|sqlite|mssql), host, port, username, password, database, and optionally name.',
      'After adding, call list_connections to verify.'
    ].join(' '),
    {
      url: z.string().optional().describe('Connection URL (mysql://, sqlite://, sqlserver://)'),
      file: z.string().optional().describe('Absolute path to a .sqlmaterc or .env file'),
      type: z.enum(['mysql', 'sqlite', 'mssql']).optional().describe('Database type'),
      host: z.string().optional().describe('Database host'),
      port: z.number().optional().describe('Database port'),
      username: z.string().optional().describe('Database username'),
      password: z.string().optional().describe('Database password'),
      database: z.string().optional().describe('Database name'),
      path: z.string().optional().describe('File path for SQLite databases'),
      name: z.string().optional().describe('Display name for this connection')
    },
    async (input) => {
      const { password: _pw, username: _un, ...safeArgs } = input
      const { id, startMs } = emitStart('add_connection', null, safeArgs)
      try {
        const added = parseConnectionInput(input, connections)
        for (const conn of added) connections.push(conn)
        emitter.emit('connections_changed', connections.map(c => ({ id: c.id, name: c.name, type: c.type, source: c.source })))
        emitEnd(id, startMs, added)
        return ok({
          added: added.map(c => ({ id: c.id, name: c.name, type: c.type, source: c.source })),
          message: `${added.length} connection(s) added. Use list_connections to see all configured connections.`
        })
      } catch (err) { emitError(id, startMs, err); return fail(err) }
    }
  )

  server.tool(
    'list_tables',
    'List all tables in a database connection',
    { connectionId: z.string().describe('Connection ID from list_connections') },
    async ({ connectionId }) => {
      const { id, startMs } = emitStart('list_tables', connectionId, { connectionId })
      try {
        const conn = findConn(connections, connectionId)
        const driver = await getDriver(conn)
        const result = await driver.listTables()
        emitEnd(id, startMs, result)
        return ok(result)
      } catch (err) { emitError(id, startMs, err); return fail(err) }
    }
  )

  server.tool(
    'describe_table',
    'Get column schema for a table',
    {
      connectionId: z.string().describe('Connection ID from list_connections'),
      table: z.string().describe('Table name')
    },
    async ({ connectionId, table }) => {
      const { id, startMs } = emitStart('describe_table', connectionId, { table })
      try {
        const conn = findConn(connections, connectionId)
        const driver = await getDriver(conn)
        const result = await driver.describeTable(table)
        emitEnd(id, startMs, result)
        return ok(result)
      } catch (err) { emitError(id, startMs, err); return fail(err) }
    }
  )

  server.tool(
    'run_query',
    'Run a read-only SQL query (SELECT, EXPLAIN, SHOW, PRAGMA). Write statements are rejected.',
    {
      connectionId: z.string().describe('Connection ID from list_connections'),
      sql: z.string().describe('SQL query to run')
    },
    async ({ connectionId, sql }) => {
      const { id, startMs } = emitStart('run_query', connectionId, { sql: sql.slice(0, 300) })
      try {
        const conn = findConn(connections, connectionId)
        const driver = await getDriver(conn)
        const result = await driver.runQuery(sql)
        emitEnd(id, startMs, result)
        return ok(result)
      } catch (err) { emitError(id, startMs, err); return fail(err) }
    }
  )

  server.tool(
    'run_write',
    [
      'Run a write SQL statement (INSERT, UPDATE, DELETE, TRUNCATE, DROP, ALTER).',
      'IMPORTANT: For destructive operations (DELETE, TRUNCATE, DROP, UPDATE without WHERE,',
      'ALTER TABLE ... DROP COLUMN) you MUST first call this tool WITHOUT confirm to get a',
      'risk summary, show it to the user and ask for explicit approval, then call again with',
      'confirm: true. Never pass confirm: true on the first call without user approval.'
    ].join(' '),
    {
      connectionId: z.string().describe('Connection ID from list_connections'),
      sql: z.string().describe('SQL statement to execute'),
      confirm: z.boolean().optional().describe(
        'Set to true only after the user has explicitly approved the risk shown by a prior call to this tool'
      )
    },
    async ({ connectionId, sql, confirm }) => {
      const { id, startMs } = emitStart('run_write', connectionId, { sql: sql.slice(0, 300) })
      try {
        const { risky, reason } = assessRisk(sql)

        if (risky && !confirm) {
          emitter.emit('tool_end', { id, duration: Date.now() - startMs, error: null, requiresConfirmation: true })
          return ok({
            requiresConfirmation: true,
            risk: reason,
            sql,
            instructions: [
              '⚠️  This operation may permanently remove or destroy data.',
              `Risk: ${reason}`,
              'Show this warning to the user and ask for explicit approval before proceeding.',
              'If approved, call run_write again with the same sql and confirm: true.'
            ].join('\n')
          })
        }

        const conn = findConn(connections, connectionId)
        const driver = await getDriver(conn)
        const result = await driver.runWrite(sql)
        emitEnd(id, startMs, result)
        return ok({
          result,
          affectedRows: result.affectedRows,
          message: `Write operation completed. ${result.affectedRows ?? '?'} row(s) affected.`
        })
      } catch (err) { emitError(id, startMs, err); return fail(err) }
    }
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('[sqlmate] MCP server connected via stdio\n')
}
