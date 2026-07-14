import path from 'path'

const pools = new Map()
const drivers = new Map()

const projectRoot = process.env.SQLMATE_PROJECT_ROOT ?? process.cwd()

// Namespace the driver/pool cache by project so that connections sharing an id
// across two different projects (e.g. same slugified name) never collide.
function keyOf(conn) {
  return `${conn.projectRoot ?? 'global'}::${conn.id}`
}

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
}

function firstKeyword(sql) {
  return stripComments(sql).split(/\s+/)[0].toUpperCase()
}

const SAFE_READ = new Set(['SELECT', 'PRAGMA', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC', 'WITH'])
const SAFE_WRITE = new Set(['INSERT', 'UPDATE', 'DELETE'])

function esc(id) {
  return '`' + id.replace(/`/g, '``') + '`'
}

function escMssql(id) {
  return '[' + id.replace(/]/g, ']]') + ']'
}

function escSqlite(id) {
  return '"' + id.replace(/"/g, '""') + '"'
}

// ─── MySQL ────────────────────────────────────────────────────────────────────

async function buildMysqlDriver(conn) {
  const mysql = (await import('mysql2/promise')).default
  const pool = mysql.createPool({
    host: conn.host || '127.0.0.1',
    port: conn.port || 3306,
    user: conn.username,
    password: conn.password || '',
    database: conn.database,
    waitForConnections: true,
    connectionLimit: 5,
    multipleStatements: false
  })
  pools.set(keyOf(conn), pool)

  return {
    async listTables() {
      const [rows] = await pool.query(
        'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME'
      )
      return rows.map(r => r.TABLE_NAME)
    },
    async describeTable(table) {
      const [rows] = await pool.query(`SHOW COLUMNS FROM ${esc(table)}`)
      return rows.map(r => ({
        column: r.Field,
        type: r.Type,
        nullable: r.Null === 'YES',
        pk: r.Key === 'PRI'
      }))
    },
    async runQuery(sql) {
      const kw = firstKeyword(sql)
      if (!SAFE_READ.has(kw)) throw new Error(`Query not allowed: only SELECT/EXPLAIN/SHOW permitted (got ${kw})`)
      const start = Date.now()
      const [rows, fields] = await pool.query(sql)
      const columns = fields ? fields.map(f => f.name) : (rows[0] ? Object.keys(rows[0]) : [])
      return { rows, columns, durationMs: Date.now() - start }
    },
    async explainQuery(sql, options = {}) {
      const analyze = options.analyze === true
      if (analyze) {
        const kw = firstKeyword(sql)
        if (!SAFE_READ.has(kw)) throw new Error('EXPLAIN ANALYZE is only allowed for read statements (SELECT/WITH/...)')
        const [rows] = await pool.query(`EXPLAIN ANALYZE ${sql}`)
        const plan = rows.map(r => Object.values(r)[0]).join('\n')
        return { plan, format: 'text' }
      }
      const [rows] = await pool.query(`EXPLAIN FORMAT=JSON ${sql}`)
      const plan = JSON.parse(rows[0].EXPLAIN)
      return { plan, format: 'json' }
    },
    async runWrite(sql) {
      const kw = firstKeyword(sql)
      if (!SAFE_WRITE.has(kw)) throw new Error(`Write not allowed: only INSERT/UPDATE/DELETE permitted (got ${kw})`)
      const [result] = await pool.query(sql)
      return { affectedRows: result.affectedRows ?? 0 }
    },
    async getPaginatedRows(table, pk, limit, offset) {
      const orderBy = pk ? ` ORDER BY ${esc(pk)}` : ''
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM ${esc(table)}`)
      const [rows] = await pool.query(`SELECT * FROM ${esc(table)}${orderBy} LIMIT ? OFFSET ?`, [limit, offset])
      return { rows, total: Number(total) }
    },
    async updateRow(table, pk, pkValue, column, value) {
      const [result] = await pool.query(
        `UPDATE ${esc(table)} SET ${esc(column)} = ? WHERE ${esc(pk)} = ?`,
        [value, pkValue]
      )
      return { affectedRows: result.affectedRows ?? 0 }
    },
    async deleteRow(table, pk, pkValue) {
      const [result] = await pool.query(
        `DELETE FROM ${esc(table)} WHERE ${esc(pk)} = ?`,
        [pkValue]
      )
      return { affectedRows: result.affectedRows ?? 0 }
    },
    async getForeignKeys(table) {
      const [rows] = await pool.query(
        `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, CONSTRAINT_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [table]
      )
      return rows.map(r => ({
        column: r.COLUMN_NAME,
        refTable: r.REFERENCED_TABLE_NAME,
        refColumn: r.REFERENCED_COLUMN_NAME,
        constraintName: r.CONSTRAINT_NAME
      }))
    },
    async getIndexes(table) {
      const [rows] = await pool.query(`SHOW INDEX FROM ${esc(table)}`)
      const byName = new Map()
      for (const r of rows) {
        if (!byName.has(r.Key_name)) {
          byName.set(r.Key_name, { name: r.Key_name, columns: [], unique: r.Non_unique === 0 })
        }
        byName.get(r.Key_name).columns[r.Seq_in_index - 1] = r.Column_name
      }
      return Array.from(byName.values())
    },
    async getSchemaGraph() {
      return buildSchemaGraph(this)
    },
    async close() {
      await pool.end()
    }
  }
}

// ─── Shared schema graph assembly (dialect-agnostic; each piece below is
// dialect-specific, this just fans out listTables() to per-table detail) ──────

async function buildSchemaGraph(driver) {
  const tableNames = await driver.listTables()
  const tables = []
  for (const name of tableNames) {
    const [columns, foreignKeys, indexes] = await Promise.all([
      driver.describeTable(name),
      driver.getForeignKeys(name),
      driver.getIndexes(name)
    ])
    tables.push({ name, columns, foreignKeys, indexes })
  }
  return { tables }
}

// ─── SQLite (node:sqlite built-in, requires Node.js >= 22.5) ─────────────────

async function buildSqliteDriver(conn) {
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = conn.path === ':memory:'
    ? ':memory:'
    : path.resolve(conn.projectRoot ?? projectRoot, conn.path)
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  pools.set(keyOf(conn), db)

  return {
    async listTables() {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      return rows.map(r => r.name)
    },
    async describeTable(table) {
      const rows = db.prepare(`PRAGMA table_info(${escSqlite(table)})`).all()
      return rows.map(r => ({
        column: r.name,
        type: r.type,
        nullable: r.notnull === 0 && r.pk === 0,
        pk: r.pk > 0
      }))
    },
    async runQuery(sql) {
      const kw = firstKeyword(sql)
      if (!SAFE_READ.has(kw)) throw new Error(`Query not allowed: only SELECT/PRAGMA/EXPLAIN permitted (got ${kw})`)
      const start = Date.now()
      const rows = db.prepare(sql).all()
      const columns = rows.length > 0 ? Object.keys(rows[0]) : []
      return { rows, columns, durationMs: Date.now() - start }
    },
    async explainQuery(sql, options = {}) {
      const analyze = options.analyze === true
      if (analyze) {
        const kw = firstKeyword(sql)
        if (!SAFE_READ.has(kw)) throw new Error('EXPLAIN ANALYZE is only allowed for read statements (SELECT/WITH/...)')
      }
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
      return { plan: rows, format: 'query_plan' }
    },
    async runWrite(sql) {
      const kw = firstKeyword(sql)
      if (!SAFE_WRITE.has(kw)) throw new Error(`Write not allowed: only INSERT/UPDATE/DELETE permitted (got ${kw})`)
      const result = db.prepare(sql).run()
      return { affectedRows: result.changes ?? 0 }
    },
    async getPaginatedRows(table, pk, limit, offset) {
      const orderBy = pk ? ` ORDER BY ${escSqlite(pk)}` : ''
      const row = db.prepare(`SELECT COUNT(*) as total FROM ${escSqlite(table)}`).get()
      const rows = db.prepare(`SELECT * FROM ${escSqlite(table)}${orderBy} LIMIT ? OFFSET ?`).all(limit, offset)
      return { rows, total: Number(row.total) }
    },
    async updateRow(table, pk, pkValue, column, value) {
      const result = db.prepare(
        `UPDATE ${escSqlite(table)} SET ${escSqlite(column)} = ? WHERE ${escSqlite(pk)} = ?`
      ).run(value, pkValue)
      return { affectedRows: result.changes ?? 0 }
    },
    async deleteRow(table, pk, pkValue) {
      const result = db.prepare(
        `DELETE FROM ${escSqlite(table)} WHERE ${escSqlite(pk)} = ?`
      ).run(pkValue)
      return { affectedRows: result.changes ?? 0 }
    },
    async getForeignKeys(table) {
      const rows = db.prepare(`PRAGMA foreign_key_list(${escSqlite(table)})`).all()
      return rows.map(r => ({
        column: r.from,
        refTable: r.table,
        refColumn: r.to,
        constraintName: null
      }))
    },
    async getIndexes(table) {
      const idxList = db.prepare(`PRAGMA index_list(${escSqlite(table)})`).all()
      return idxList.map(idx => {
        const cols = db.prepare(`PRAGMA index_info(${escSqlite(idx.name)})`).all()
        return {
          name: idx.name,
          columns: cols.map(c => c.name),
          unique: idx.unique === 1
        }
      })
    },
    async getSchemaGraph() {
      return buildSchemaGraph(this)
    },
    async close() {
      db.close()
    }
  }
}

// ─── MSSQL ────────────────────────────────────────────────────────────────────

async function buildMssqlDriver(conn) {
  const sql = (await import('mssql')).default
  const pool = await new sql.ConnectionPool({
    server: conn.host || 'localhost',
    port: conn.port || 1433,
    user: conn.username,
    password: conn.password || '',
    database: conn.database,
    options: {
      trustServerCertificate: conn.options?.trustServerCertificate ?? false,
      encrypt: conn.options?.encrypt ?? false,
      ...conn.options
    }
  }).connect()
  pools.set(keyOf(conn), pool)

  return {
    async listTables() {
      const result = await pool.request().query(
        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
      )
      return result.recordset.map(r => r.TABLE_NAME)
    },
    async describeTable(table) {
      const colResult = await pool.request()
        .input('table', sql.NVarChar, table)
        .query(`SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = @table
                ORDER BY ORDINAL_POSITION`)

      const pkResult = await pool.request()
        .input('table', sql.NVarChar, table)
        .query(`SELECT ku.COLUMN_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                  ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
                WHERE tc.TABLE_NAME = @table AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`)

      const pkCols = new Set(pkResult.recordset.map(r => r.COLUMN_NAME))
      return colResult.recordset.map(r => ({
        column: r.COLUMN_NAME,
        type: r.DATA_TYPE,
        nullable: r.IS_NULLABLE === 'YES',
        pk: pkCols.has(r.COLUMN_NAME)
      }))
    },
    async runQuery(sqlStr) {
      const kw = firstKeyword(sqlStr)
      if (!SAFE_READ.has(kw)) throw new Error(`Query not allowed: only SELECT/EXPLAIN permitted (got ${kw})`)
      const start = Date.now()
      const result = await pool.request().query(sqlStr)
      const rows = result.recordset || []
      const columns = rows.length > 0 ? Object.keys(rows[0]) : Object.keys(result.recordset?.columns || {})
      return { rows, columns, durationMs: Date.now() - start }
    },
    async explainQuery(sqlStr, options = {}) {
      // Best-effort: SHOWPLAN_XML returns the plan without executing the
      // statement, but it must be issued on the same connection/batch as the
      // query for the setting to take effect. mssql's request.batch() reuses
      // a pooled connection for the lifetime of the request object, so we
      // chain SET ON / query / SET OFF on one request. If SHOWPLAN_XML ever
      // fails to apply (pool behavior differs across mssql versions), this
      // throws a clear error rather than silently executing the statement.
      const analyze = options.analyze === true
      if (analyze) {
        const kw = firstKeyword(sqlStr)
        if (!SAFE_READ.has(kw)) throw new Error('EXPLAIN ANALYZE is only allowed for read statements (SELECT/WITH/...)')
        // MSSQL analyze support is limited to the same plan-only SHOWPLAN_XML
        // output as the non-analyze path (real "actual plan" requires
        // STATISTICS XML which returns plan+results interleaved).
      }
      try {
        const req = pool.request()
        await req.batch('SET SHOWPLAN_XML ON')
        const r = await req.batch(sqlStr)
        await req.batch('SET SHOWPLAN_XML OFF')
        const row = r.recordset?.[0]
        const plan = row ? row[Object.keys(row)[0]] : r.recordset
        return { plan, format: 'xml' }
      } catch (err) {
        throw new Error(`EXPLAIN failed (MSSQL SHOWPLAN_XML is best-effort): ${err.message}`)
      }
    },
    async runWrite(sqlStr) {
      const kw = firstKeyword(sqlStr)
      if (!SAFE_WRITE.has(kw)) throw new Error(`Write not allowed: only INSERT/UPDATE/DELETE permitted (got ${kw})`)
      const result = await pool.request().query(sqlStr)
      return { affectedRows: result.rowsAffected?.[0] ?? 0 }
    },
    async getPaginatedRows(table, pk, limit, offset) {
      const orderCol = pk ? escMssql(pk) : '(SELECT NULL)'
      const totalResult = await pool.request().query(`SELECT COUNT(*) as total FROM ${escMssql(table)}`)
      const total = totalResult.recordset[0].total
      const rowsResult = await pool.request().query(
        `SELECT * FROM ${escMssql(table)} ORDER BY ${orderCol} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
      )
      return { rows: rowsResult.recordset, total }
    },
    async updateRow(table, pk, pkValue, column, value) {
      const result = await pool.request()
        .input('val', value)
        .input('pk', pkValue)
        .query(`UPDATE ${escMssql(table)} SET ${escMssql(column)} = @val WHERE ${escMssql(pk)} = @pk`)
      return { affectedRows: result.rowsAffected?.[0] ?? 0 }
    },
    async deleteRow(table, pk, pkValue) {
      const result = await pool.request()
        .input('pk', pkValue)
        .query(`DELETE FROM ${escMssql(table)} WHERE ${escMssql(pk)} = @pk`)
      return { affectedRows: result.rowsAffected?.[0] ?? 0 }
    },
    async getForeignKeys(table) {
      const result = await pool.request()
        .input('table', sql.NVarChar, table)
        .query(`SELECT
                  pc.name AS COLUMN_NAME,
                  rt.name AS REFERENCED_TABLE_NAME,
                  rc.name AS REFERENCED_COLUMN_NAME,
                  fk.name AS CONSTRAINT_NAME
                FROM sys.foreign_keys fk
                JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
                JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
                JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
                JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
                JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
                WHERE pt.name = @table`)
      return result.recordset.map(r => ({
        column: r.COLUMN_NAME,
        refTable: r.REFERENCED_TABLE_NAME,
        refColumn: r.REFERENCED_COLUMN_NAME,
        constraintName: r.CONSTRAINT_NAME
      }))
    },
    async getIndexes(table) {
      const result = await pool.request()
        .input('table', sql.NVarChar, table)
        .query(`SELECT
                  ix.name AS name,
                  ix.is_unique AS is_unique,
                  c.name AS column_name,
                  ic.key_ordinal AS ord
                FROM sys.indexes ix
                JOIN sys.tables t ON t.object_id = ix.object_id
                JOIN sys.index_columns ic ON ic.object_id = ix.object_id AND ic.index_id = ix.index_id
                JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                WHERE t.name = @table AND ix.name IS NOT NULL
                ORDER BY ix.name, ic.key_ordinal`)
      const byName = new Map()
      for (const r of result.recordset) {
        if (!byName.has(r.name)) {
          byName.set(r.name, { name: r.name, columns: [], unique: !!r.is_unique })
        }
        byName.get(r.name).columns.push(r.column_name)
      }
      return Array.from(byName.values())
    },
    async getSchemaGraph() {
      return buildSchemaGraph(this)
    },
    async close() {
      await pool.close()
    }
  }
}

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

async function buildPostgresDriver(conn) {
  const pg = (await import('pg')).default
  const pool = new pg.Pool({
    host: conn.host || '127.0.0.1',
    port: conn.port || 5432,
    user: conn.username,
    password: conn.password || '',
    database: conn.database,
    max: 5
  })
  pools.set(keyOf(conn), pool)

  return {
    async listTables() {
      const result = await pool.query(
        "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY tablename"
      )
      return result.rows.map(r => r.tablename)
    },
    async describeTable(table) {
      const colResult = await pool.query(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_name = $1 AND table_schema NOT IN ('pg_catalog','information_schema')
         ORDER BY ordinal_position`,
        [table]
      )

      const pkResult = await pool.query(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1`,
        [table]
      )

      const pkCols = new Set(pkResult.rows.map(r => r.column_name))
      return colResult.rows.map(r => ({
        column: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
        pk: pkCols.has(r.column_name)
      }))
    },
    async runQuery(sql) {
      const kw = firstKeyword(sql)
      if (!SAFE_READ.has(kw)) throw new Error(`Query not allowed: only SELECT/EXPLAIN/SHOW permitted (got ${kw})`)
      const start = Date.now()
      const result = await pool.query(sql)
      const rows = result.rows
      const columns = result.fields ? result.fields.map(f => f.name) : (rows[0] ? Object.keys(rows[0]) : [])
      return { rows, columns, durationMs: Date.now() - start }
    },
    async explainQuery(sql, options = {}) {
      const analyze = options.analyze === true
      if (analyze) {
        const kw = firstKeyword(sql)
        if (!SAFE_READ.has(kw)) throw new Error('EXPLAIN ANALYZE is only allowed for read statements (SELECT/WITH/...)')
      }
      const result = await pool.query(`EXPLAIN (FORMAT JSON${analyze ? ', ANALYZE, BUFFERS' : ''}) ${sql}`)
      const plan = result.rows[0]['QUERY PLAN']
      return { plan, format: 'json' }
    },
    async runWrite(sql) {
      const kw = firstKeyword(sql)
      if (!SAFE_WRITE.has(kw)) throw new Error(`Write not allowed: only INSERT/UPDATE/DELETE permitted (got ${kw})`)
      const result = await pool.query(sql)
      return { affectedRows: result.rowCount ?? 0 }
    },
    async getPaginatedRows(table, pk, limit, offset) {
      const orderBy = pk ? ` ORDER BY ${escSqlite(pk)}` : ''
      const totalResult = await pool.query(`SELECT COUNT(*) AS total FROM ${escSqlite(table)}`)
      const rows = await pool.query(`SELECT * FROM ${escSqlite(table)}${orderBy} LIMIT $1 OFFSET $2`, [limit, offset])
      return { rows: rows.rows, total: Number(totalResult.rows[0].total) }
    },
    async updateRow(table, pk, pkValue, column, value) {
      const result = await pool.query(
        `UPDATE ${escSqlite(table)} SET ${escSqlite(column)} = $1 WHERE ${escSqlite(pk)} = $2`,
        [value, pkValue]
      )
      return { affectedRows: result.rowCount ?? 0 }
    },
    async deleteRow(table, pk, pkValue) {
      const result = await pool.query(
        `DELETE FROM ${escSqlite(table)} WHERE ${escSqlite(pk)} = $1`,
        [pkValue]
      )
      return { affectedRows: result.rowCount ?? 0 }
    },
    async getForeignKeys(table) {
      const result = await pool.query(
        `SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column, tc.constraint_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1`,
        [table]
      )
      return result.rows.map(r => ({
        column: r.column_name,
        refTable: r.ref_table,
        refColumn: r.ref_column,
        constraintName: r.constraint_name
      }))
    },
    async getIndexes(table) {
      const result = await pool.query(
        `SELECT i.relname AS name, ix.indisunique AS unique, a.attname AS column, array_position(ix.indkey, a.attnum) AS ord
         FROM pg_class t
         JOIN pg_index ix ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
         WHERE t.relname = $1
         ORDER BY i.relname, ord`,
        [table]
      )
      const byName = new Map()
      for (const r of result.rows) {
        if (!byName.has(r.name)) {
          byName.set(r.name, { name: r.name, columns: [], unique: !!r.unique })
        }
        byName.get(r.name).columns.push(r.column)
      }
      return Array.from(byName.values())
    },
    async getSchemaGraph() {
      return buildSchemaGraph(this)
    },
    async close() {
      await pool.end()
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getDriver(conn) {
  const key = keyOf(conn)
  if (drivers.has(key)) return drivers.get(key)

  let driver
  if (conn.type === 'mysql' || conn.type === 'mariadb') {
    driver = await buildMysqlDriver(conn)
  } else if (conn.type === 'sqlite') {
    driver = await buildSqliteDriver(conn)
  } else if (conn.type === 'mssql') {
    driver = await buildMssqlDriver(conn)
  } else if (conn.type === 'postgres' || conn.type === 'postgresql') {
    driver = await buildPostgresDriver(conn)
  } else {
    throw new Error(`Unsupported database type: ${conn.type}`)
  }

  drivers.set(key, driver)
  return driver
}

// Drop a cached driver synchronously (so the next getDriver rebuilds it) and
// close the old one in the background. Use when a connection is removed or its
// DB-defining config changed, so the project-scoped cache never serves a stale
// driver. Takes the connection object (not just its id) since the cache key
// includes the project root.
export function invalidateDriver(conn) {
  const key = keyOf(conn)
  const driver = drivers.get(key)
  drivers.delete(key)
  pools.delete(key)
  if (driver) Promise.resolve().then(() => driver.close()).catch(() => {})
}

export async function reconnect(conn) {
  const key = keyOf(conn)
  if (drivers.has(key)) {
    try { await drivers.get(key).close() } catch {}
    drivers.delete(key)
  }
  pools.delete(key)
}

export async function closeAll() {
  for (const [id, driver] of drivers) {
    try { await driver.close() } catch {}
  }
  drivers.clear()
  pools.clear()
}
