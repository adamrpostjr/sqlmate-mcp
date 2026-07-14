import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { getDriver, invalidateDriver } from './drivers.js'
import emitter from './events.js'
import { parseConnectionInput, mergeProjectConnections, resolveConnection } from './connections.js'

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function fail(err) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true }
}

function serializeConn(c) {
  return { id: c.id, name: c.name, type: c.type, source: c.source }
}

const SENSITIVE_KEYWORD = /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth)\b/i
const STRING_LITERAL = /'(?:[^']|'')*'|"(?:[^"]|"")*"/g

// Best-effort scrub of secret-shaped values before SQL text or error messages
// leave this process via the tool_start/tool_end feed (broadcast to every
// browser tab and, once attached, to other machines over the host protocol).
// Not applied to what's returned to the calling agent — it needs the real text.
// A `password = 'x'` literal sits right next to its keyword, but column-list
// syntax (`INSERT INTO t (password) VALUES ('x')`) doesn't — and there's no
// safe way to correlate a value back to its column without a real SQL parser.
// So if the statement touches a sensitive keyword ANYWHERE, every string
// literal in it is wiped rather than risk leaking the wrong one.
function redactSecrets(text) {
  if (!text) return text
  let out = text
  if (SENSITIVE_KEYWORD.test(out)) {
    out = out.replace(STRING_LITERAL, (m) => m[0] + '[REDACTED]' + m[0])
  }
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@/\s]+(@)/gi, '$1[REDACTED]$2')
}

function emitStart(tool, connectionId, args, projectRoot) {
  const id = randomUUID()
  const timestamp = new Date().toISOString()
  emitter.emit('tool_start', { id, tool, connectionId, args, timestamp, projectRoot })
  return { id, startMs: Date.now(), projectRoot }
}

function emitEnd({ id, startMs, projectRoot }, result) {
  emitter.emit('tool_end', {
    id,
    duration: Date.now() - startMs,
    rowCount: Array.isArray(result?.rows) ? result.rows.length
      : Array.isArray(result) ? result.length
      : undefined,
    error: null,
    projectRoot
  })
}

function emitError({ id, startMs, projectRoot }, err) {
  emitter.emit('tool_end', {
    id,
    duration: Date.now() - startMs,
    error: redactSecrets(err.message),
    projectRoot
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

export async function startMcpServer(connections, projectRoot, { transport } = {}) {
  const server = new McpServer({ name: 'sqlmate-mcp', version: '1.2.0' })

  // Connections visible to a project: its own file-derived connections plus any
  // global (tool-added) ones. A tool call's project_root wins; otherwise the
  // startup project root is used so single-project (legacy) callers still work.
  const scopeFor = (root) => connections.filter(c => c.projectRoot == null || c.projectRoot === (root ?? projectRoot))

  server.tool(
    'list_connections',
    [
      'List all configured database connections.',
      'IMPORTANT: Always pass project_root set to the absolute path of the current project directory.',
      'This ensures the correct database connections are loaded for the active project,',
      'since the server may be shared across multiple projects.',
      'If no connections are found, returns setup instructions.'
    ].join(' '),
    {
      project_root: z.string().optional().describe(
        'Absolute path to the current project directory. Always provide this so connections are loaded for the right project.'
      )
    },
    async ({ project_root } = {}) => {
      const ctx = emitStart('list_connections', null, { project_root }, project_root ?? projectRoot)
      try {
        if (project_root) {
          const { added, removed } = mergeProjectConnections(connections, project_root, invalidateDriver)
          if (added.length > 0 || removed.length > 0) {
            emitter.emit('connections_changed', connections.map(serializeConn))
          }
        }
        const visible = scopeFor(project_root)
        if (visible.length === 0) {
          emitEnd(ctx, [])
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
        const result = visible.map(serializeConn)
        emitEnd(ctx, result)
        return ok(result)
      } catch (err) { emitError(ctx, err); return fail(err) }
    }
  )

  server.tool(
    'add_connection',
    [
      'Configure a database connection for this session.',
      'Provide ONE of: (a) url — a connection URL like mysql://user:pass@host:3306/db, sqlite:///path/to/db.sqlite, or postgres://user:pass@host:5432/db,',
      '(b) file — an absolute path to a .sqlmaterc (JSON) or .env file containing DB credentials,',
      '(c) individual params — type (mysql|sqlite|mssql|postgres), host, port, username, password, database, and optionally name.',
      'After adding, call list_connections to verify.'
    ].join(' '),
    {
      url: z.string().optional().describe('Connection URL (mysql://, sqlite://, sqlserver://, postgres://)'),
      file: z.string().optional().describe('Absolute path to a .sqlmaterc or .env file'),
      type: z.enum(['mysql', 'sqlite', 'mssql', 'postgres']).optional().describe('Database type'),
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
      // A url like mysql://user:pass@host embeds credentials outside the
      // password/username fields already stripped above — redact those too.
      if (safeArgs.url) safeArgs.url = redactSecrets(safeArgs.url)
      const ctx = emitStart('add_connection', null, safeArgs, projectRoot)
      try {
        const added = parseConnectionInput(input, connections)
        for (const conn of added) connections.push(conn)
        emitter.emit('connections_changed', connections.map(serializeConn))
        emitEnd(ctx, added)
        return ok({
          added: added.map(serializeConn),
          message: `${added.length} connection(s) added. Use list_connections to see all configured connections.`
        })
      } catch (err) { emitError(ctx, err); return fail(err) }
    }
  )

  server.tool(
    'list_tables',
    'List all tables in a database connection',
    {
      connectionId: z.string().describe('Connection ID from list_connections'),
      project_root: z.string().optional().describe('Absolute path to the current project directory (same value passed to list_connections)')
    },
    async ({ connectionId, project_root }) => {
      const ctx = emitStart('list_tables', connectionId, { connectionId }, project_root ?? projectRoot)
      try {
        const conn = resolveConnection(connections, connectionId, project_root ?? projectRoot)
        const driver = await getDriver(conn)
        const result = await driver.listTables()
        emitEnd(ctx, result)
        return ok(result)
      } catch (err) { emitError(ctx, err); return fail(err) }
    }
  )

  server.tool(
    'describe_table',
    'Get column schema for a table',
    {
      connectionId: z.string().describe('Connection ID from list_connections'),
      table: z.string().describe('Table name'),
      project_root: z.string().optional().describe('Absolute path to the current project directory (same value passed to list_connections)')
    },
    async ({ connectionId, table, project_root }) => {
      const ctx = emitStart('describe_table', connectionId, { table }, project_root ?? projectRoot)
      try {
        const conn = resolveConnection(connections, connectionId, project_root ?? projectRoot)
        const driver = await getDriver(conn)
        const result = await driver.describeTable(table)
        emitEnd(ctx, result)
        return ok(result)
      } catch (err) { emitError(ctx, err); return fail(err) }
    }
  )

  server.tool(
    'get_schema',
    'Get the full schema graph for a connection — every table with its columns, primary keys, foreign keys, and indexes. Use this to understand a database and the relationships between tables in one call.',
    {
      connectionId: z.string().describe('Connection ID from list_connections'),
      table: z.string().optional().describe('If provided, return only this table\'s schema'),
      project_root: z.string().optional().describe('Absolute path to the current project directory (same value passed to list_connections)')
    },
    async ({ connectionId, table, project_root }) => {
      const ctx = emitStart('get_schema', connectionId, { connectionId, table }, project_root ?? projectRoot)
      try {
        const conn = resolveConnection(connections, connectionId, project_root ?? projectRoot)
        const driver = await getDriver(conn)
        let result
        if (table) {
          const [columns, foreignKeys, indexes] = await Promise.all([
            driver.describeTable(table),
            driver.getForeignKeys(table),
            driver.getIndexes(table)
          ])
          result = { name: table, columns, foreignKeys, indexes }
        } else {
          result = await driver.getSchemaGraph()
        }
        emitEnd(ctx, result)
        return ok(result)
      } catch (err) { emitError(ctx, err); return fail(err) }
    }
  )

  server.tool(
    'run_query',
    'Run a read-only SQL query (SELECT, EXPLAIN, SHOW, PRAGMA). Write statements are rejected.',
    {
      connectionId: z.string().describe('Connection ID from list_connections'),
      sql: z.string().describe('SQL query to run'),
      project_root: z.string().optional().describe('Absolute path to the current project directory (same value passed to list_connections)')
    },
    async ({ connectionId, sql, project_root }) => {
      const ctx = emitStart('run_query', connectionId, { sql: redactSecrets(sql).slice(0, 300) }, project_root ?? projectRoot)
      try {
        const conn = resolveConnection(connections, connectionId, project_root ?? projectRoot)
        const driver = await getDriver(conn)
        const result = await driver.runQuery(sql)
        emitEnd(ctx, result)
        return ok(result)
      } catch (err) { emitError(ctx, err); return fail(err) }
    }
  )

  server.tool(
    'explain_query',
    'Get the query execution plan (EXPLAIN) for a SQL statement without running it. Set analyze=true to actually execute a read-only query and get real timing (rejected for writes). Use to diagnose slow queries and missing indexes.',
    {
      connectionId: z.string().describe('Connection ID from list_connections'),
      sql: z.string().describe('The SQL statement to explain'),
      analyze: z.boolean().optional().describe('Run the query and include real execution timing (read-only statements only)'),
      project_root: z.string().optional().describe('Absolute path to the current project directory (same value passed to list_connections)')
    },
    async ({ connectionId, sql, analyze, project_root }) => {
      const ctx = emitStart('explain_query', connectionId, { sql: redactSecrets(sql).slice(0, 300), analyze }, project_root ?? projectRoot)
      try {
        const conn = resolveConnection(connections, connectionId, project_root ?? projectRoot)
        const driver = await getDriver(conn)
        const result = await driver.explainQuery(sql, { analyze })
        emitEnd(ctx, result)
        return ok(result)
      } catch (err) { emitError(ctx, err); return fail(err) }
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
      ),
      project_root: z.string().optional().describe('Absolute path to the current project directory (same value passed to list_connections)')
    },
    async ({ connectionId, sql, confirm, project_root }) => {
      const ctx = emitStart('run_write', connectionId, { sql: redactSecrets(sql).slice(0, 300) }, project_root ?? projectRoot)
      try {
        const { risky, reason } = assessRisk(sql)

        if (risky && !confirm) {
          emitter.emit('tool_end', { id: ctx.id, duration: Date.now() - ctx.startMs, error: null, requiresConfirmation: true, projectRoot: ctx.projectRoot })
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

        const conn = resolveConnection(connections, connectionId, project_root ?? projectRoot)
        const driver = await getDriver(conn)
        const result = await driver.runWrite(sql)
        emitEnd(ctx, result)
        return ok({
          result,
          affectedRows: result.affectedRows,
          message: `Write operation completed. ${result.affectedRows ?? '?'} row(s) affected.`
        })
      } catch (err) { emitError(ctx, err); return fail(err) }
    }
  )

  await server.connect(transport ?? new StdioServerTransport())
  process.stderr.write('[sqlmate] MCP server connected via stdio\n')
}
