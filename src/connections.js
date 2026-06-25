import fs from 'fs'
import path from 'path'
import { parse as parseEnv } from 'dotenv'

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function parseConnectionUrl(urlStr) {
  try {
    const url = new URL(urlStr)
    const scheme = url.protocol.replace(':', '').toLowerCase()
    let type
    if (scheme === 'mysql' || scheme === 'mysql2' || scheme === 'mariadb') type = 'mysql'
    else if (scheme === 'sqlite' || scheme === 'sqlite3') type = 'sqlite'
    else if (scheme === 'sqlserver' || scheme === 'mssql') type = 'mssql'
    else return null

    if (type === 'sqlite') {
      const dbPath = decodeURIComponent(url.pathname)
      return { type, path: dbPath, name: 'ENV SQLite', source: '.env' }
    }

    return {
      type,
      name: `ENV ${type.toUpperCase()}`,
      source: '.env',
      host: url.hostname || '127.0.0.1',
      port: url.port ? parseInt(url.port) : (type === 'mssql' ? 1433 : 3306),
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      database: url.pathname.replace(/^\//, '') || undefined,
      options: {}
    }
  } catch {
    return null
  }
}

export function inferTypeFromEnv(parsed) {
  const conn = (parsed.DB_CONNECTION || '').toLowerCase()
  if (conn === 'mysql' || conn === 'mariadb') return 'mysql'
  if (conn === 'sqlite') return 'sqlite'
  if (conn === 'sqlserver' || conn === 'mssql' || conn === 'sqlsrv') return 'mssql'

  const port = parseInt(parsed.DB_PORT)
  if (port === 3306) return 'mysql'
  if (port === 1433) return 'mssql'

  return null
}

export function buildFromEnv(parsed) {
  const urlStr = parsed.DATABASE_URL || parsed.DB_URL
  if (urlStr) {
    const conn = parseConnectionUrl(urlStr)
    if (conn) return conn
  }

  const type = inferTypeFromEnv(parsed)
  if (!type) return null

  if (type === 'sqlite') {
    return {
      type,
      name: 'ENV SQLite',
      source: '.env',
      path: parsed.DB_PATH || parsed.DB_DATABASE || ':memory:'
    }
  }

  return {
    type,
    name: `ENV ${type.toUpperCase()}`,
    source: '.env',
    host: parsed.DB_HOST || '127.0.0.1',
    port: parsed.DB_PORT ? parseInt(parsed.DB_PORT) : (type === 'mssql' ? 1433 : 3306),
    username: parsed.DB_USERNAME || parsed.DB_USER,
    password: parsed.DB_PASSWORD || parsed.DB_PASS || '',
    database: parsed.DB_DATABASE || parsed.DB_NAME,
    options: {}
  }
}

export function normalizeRcEntry(entry) {
  return {
    name: entry.name || 'Unnamed',
    type: (entry.type || '').toLowerCase(),
    source: entry.source ?? '.sqlmaterc',
    host: entry.host,
    port: entry.port,
    username: entry.username,
    password: entry.password,
    database: entry.database,
    path: entry.path,
    options: entry.options || {}
  }
}

export function assignId(conn, existing) {
  const base = slugify(conn.name || 'connection')
  const usedIds = new Set(existing.map(c => c.id))
  if (!usedIds.has(base)) { conn.id = base; return conn }
  let i = 2
  while (usedIds.has(`${base}-${i}`)) i++
  conn.id = `${base}-${i}`
  return conn
}

export function parseConnectionInput(input, existing = []) {
  if (input.file) {
    const raw = fs.readFileSync(input.file, 'utf8')
    const trimmed = raw.trimStart()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      const parsed = JSON.parse(raw)
      const entries = Array.isArray(parsed) ? parsed : [parsed]
      const result = []
      for (const entry of entries) {
        const conn = normalizeRcEntry({ ...entry, source: input.file })
        result.push(assignId(conn, [...existing, ...result]))
      }
      return result
    }
    const parsed = parseEnv(raw)
    const conn = buildFromEnv(parsed)
    if (!conn) throw new Error('No recognizable DB config found in file')
    conn.source = input.file
    return [assignId(conn, existing)]
  }

  if (input.url) {
    const conn = parseConnectionUrl(input.url)
    if (!conn) throw new Error('Unrecognized URL scheme. Supported: mysql://, sqlite://, sqlserver://')
    if (input.name) conn.name = input.name
    conn.source = 'tool'
    return [assignId(conn, existing)]
  }

  if (!input.type) throw new Error('Provide url, file, or type + connection params')
  const type = input.type.toLowerCase()
  if (!['mysql', 'sqlite', 'mssql'].includes(type)) {
    throw new Error(`Unsupported type "${input.type}". Use: mysql, sqlite, mssql`)
  }
  const conn = normalizeRcEntry({ ...input, source: 'tool' })
  return [assignId(conn, existing)]
}

export function loadConnections(projectRoot) {
  const all = []

  const envPath = path.join(projectRoot, '.env')
  if (fs.existsSync(envPath)) {
    try {
      const raw = fs.readFileSync(envPath, 'utf8')
      const parsed = parseEnv(raw)
      const conn = buildFromEnv(parsed)
      if (conn) all.push(conn)
    } catch (err) {
      process.stderr.write(`[sqlmate] Warning: failed to parse .env: ${err.message}\n`)
    }
  }

  const rcPath = path.join(projectRoot, '.sqlmaterc')
  if (fs.existsSync(rcPath)) {
    try {
      const entries = JSON.parse(fs.readFileSync(rcPath, 'utf8'))
      if (Array.isArray(entries)) {
        for (const entry of entries) all.push(normalizeRcEntry(entry))
      }
    } catch (err) {
      process.stderr.write(`[sqlmate] Warning: failed to parse .sqlmaterc: ${err.message}\n`)
    }
  }

  const seen = {}
  for (const conn of all) {
    const base = slugify(conn.name || 'connection')
    seen[base] = (seen[base] || 0) + 1
    conn.id = seen[base] === 1 ? base : `${base}-${seen[base]}`
  }

  return all
}
