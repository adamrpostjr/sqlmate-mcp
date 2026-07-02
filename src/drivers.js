import path from 'path'

const pools = new Map()
const drivers = new Map()

const projectRoot = process.env.SQLMATE_PROJECT_ROOT ?? process.cwd()

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
  pools.set(conn.id, pool)

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
      const [rows, fields] = await pool.query(sql)
      const columns = fields ? fields.map(f => f.name) : (rows[0] ? Object.keys(rows[0]) : [])
      return { rows, columns }
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
    async close() {
      await pool.end()
    }
  }
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
  pools.set(conn.id, db)

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
      const rows = db.prepare(sql).all()
      const columns = rows.length > 0 ? Object.keys(rows[0]) : []
      return { rows, columns }
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
  pools.set(conn.id, pool)

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
      const result = await pool.request().query(sqlStr)
      const rows = result.recordset || []
      const columns = rows.length > 0 ? Object.keys(rows[0]) : Object.keys(result.recordset?.columns || {})
      return { rows, columns }
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
    async close() {
      await pool.close()
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getDriver(conn) {
  if (drivers.has(conn.id)) return drivers.get(conn.id)

  let driver
  if (conn.type === 'mysql' || conn.type === 'mariadb') {
    driver = await buildMysqlDriver(conn)
  } else if (conn.type === 'sqlite') {
    driver = await buildSqliteDriver(conn)
  } else if (conn.type === 'mssql') {
    driver = await buildMssqlDriver(conn)
  } else {
    throw new Error(`Unsupported database type: ${conn.type}`)
  }

  drivers.set(conn.id, driver)
  return driver
}

// Drop a cached driver synchronously (so the next getDriver rebuilds it) and
// close the old one in the background. Use when a connection is removed or its
// DB-defining config changed, so the id-keyed cache never serves a stale driver.
export function invalidateDriver(connectionId) {
  const driver = drivers.get(connectionId)
  drivers.delete(connectionId)
  pools.delete(connectionId)
  if (driver) Promise.resolve().then(() => driver.close()).catch(() => {})
}

export async function reconnect(connectionId) {
  if (drivers.has(connectionId)) {
    try { await drivers.get(connectionId).close() } catch {}
    drivers.delete(connectionId)
  }
  pools.delete(connectionId)
}

export async function closeAll() {
  for (const [id, driver] of drivers) {
    try { await driver.close() } catch {}
  }
  drivers.clear()
  pools.clear()
}
