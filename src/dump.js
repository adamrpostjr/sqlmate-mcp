import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { once } from 'node:events'
import { esc, escSqlite, escMssql } from './drivers.js'

// ─── Value literals ───────────────────────────────────────────────────────────

const hexOf = (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex')
const isBytes = (v) => v instanceof Uint8Array // Buffer is a Uint8Array
const quoteStd = (s) => "'" + String(s).replace(/'/g, "''") + "'"
const isoNoZ = (d) => d.toISOString().replace(/Z$/, '')

const MYSQL_ESCAPES = { '\\': '\\\\', "'": "''", '\0': '\\0', '\n': '\\n', '\r': '\\r', '\x1a': '\\Z' }

// MySQL's default sql_mode honors backslash escapes (the dump header also
// resets sql_mode so NO_BACKSLASH_ESCAPES on the target can't break restores).
export function mysqlString(s) {
  return "'" + String(s).replace(/[\\'\0\n\r\x1a]/g, (c) => MYSQL_ESCAPES[c]) + "'"
}

export function mysqlLiteral(v) {
  if (v == null) return 'NULL'
  switch (typeof v) {
    case 'number': return Number.isFinite(v) ? String(v) : 'NULL'
    case 'bigint': return String(v)
    case 'boolean': return v ? '1' : '0'
    case 'string': return mysqlString(v)
  }
  if (isBytes(v)) return `X'${hexOf(v)}'`
  // dateStrings normally prevents Dates; this is just a safe fallback.
  if (v instanceof Date) return mysqlString(isoNoZ(v).replace('T', ' '))
  return mysqlString(JSON.stringify(v)) // JSON columns arrive parsed
}

export function sqliteLiteral(v) {
  if (v == null) return 'NULL'
  switch (typeof v) {
    case 'bigint': return String(v)
    case 'boolean': return v ? '1' : '0'
    case 'string': return quoteStd(v)
    case 'number': {
      // SQLite can store +/-Inf (but turns NaN into NULL); 9e999 overflows to Inf on parse.
      if (Number.isNaN(v)) return 'NULL'
      if (!Number.isFinite(v)) return v > 0 ? '9e999' : '-9e999'
      if (Object.is(v, -0)) return '-0.0'
      const s = String(v)
      // With read-bigints on, a JS number can only have come from a REAL value,
      // so keep a decimal point to preserve REAL-ness in typeless columns.
      return Number.isInteger(v) && !/e/i.test(s) ? s + '.0' : s
    }
  }
  if (isBytes(v)) return `X'${hexOf(v)}'`
  return quoteStd(JSON.stringify(v))
}

// Every value is raw text (see the session's identity type parser), so quote
// it and let Postgres coerce on INSERT. Backslashes are literal because the
// dump header sets standard_conforming_strings = on.
export function postgresLiteral(v) {
  return v == null ? 'NULL' : quoteStd(v)
}

export function mssqlLiteral(v) {
  if (v == null) return 'NULL'
  switch (typeof v) {
    case 'number': return Number.isFinite(v) ? String(v) : 'NULL'
    case 'bigint': return String(v)
    case 'boolean': return v ? '1' : '0'
    case 'string': return 'N' + quoteStd(v)
  }
  if (isBytes(v)) return '0x' + hexOf(v)
  // mssql returns UTC-based Dates holding the stored wall-clock value, so the
  // ISO string minus "Z" reproduces it. (Date/time columns are normally
  // CONVERTed to text at SELECT time instead, which also keeps 100ns precision.)
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'NULL' : quoteStd(isoNoZ(v))
  return 'N' + quoteStd(JSON.stringify(v))
}

// ─── Dialects ─────────────────────────────────────────────────────────────────
// Each dialect supplies: quoting, literals, header/footer, table discovery
// (listTables/tableInfo), DDL (createTable -> { pre, post }), and the paged
// SELECT (page). `info` is { name, ref, columns[], pk[], keyset, ...dialect extras }.

const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ')

const mysql = {
  quote: esc,
  literal: mysqlLiteral,
  header: () => [
    'SET NAMES utf8mb4;',
    'SET FOREIGN_KEY_CHECKS=0;',
    "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';"
  ].join('\n') + '\n',
  footer: () => 'SET SQL_MODE=@OLD_SQL_MODE;\nSET FOREIGN_KEY_CHECKS=1;\n',
  // Base tables only: views are skipped (SHOW CREATE TABLE would return a view definition).
  async listTables(s) {
    const rows = await s.query(
      "SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
    )
    return rows.map(r => r.name)
  },
  async tableInfo(s, name) {
    const t = mysqlString(name)
    const cols = await s.query(
      `SELECT COLUMN_NAME AS name, EXTRA AS extra FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t} ORDER BY ORDINAL_POSITION`
    )
    const pk = await s.query(
      `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t} AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`
    )
    return {
      name,
      ref: esc(name),
      // Generated columns can't be INSERTed into. (DEFAULT_GENERATED is an ordinary expression default and is fine.)
      columns: cols.filter(c => !/\b(VIRTUAL|STORED) GENERATED\b/i.test(c.extra ?? '')).map(c => c.name),
      pk: pk.map(r => r.name),
      keyset: true
    }
  },
  async createTable(s, info, { dropExisting }) {
    const [row] = await s.query(`SHOW CREATE TABLE ${info.ref}`)
    const ddl = row['Create Table']
    return { pre: (dropExisting ? `DROP TABLE IF EXISTS ${info.ref};\n` : '') + ddl + ';\n', post: '' }
  },
  insertPrefix: (info) => `INSERT INTO ${info.ref} (${info.columns.map(esc).join(', ')}) VALUES\n`,
  page(info, { last, offset, limit }) {
    const cols = info.columns.map(esc).join(', ')
    if (info.pk.length === 1 && info.keyset) {
      const k = esc(info.pk[0])
      return `SELECT ${cols} FROM ${info.ref}${last ? ` WHERE ${k} > ${mysqlLiteral(last.value)}` : ''} ORDER BY ${k} LIMIT ${limit}`
    }
    const order = info.pk.length ? ` ORDER BY ${info.pk.map(esc).join(', ')}` : ''
    return `SELECT ${cols} FROM ${info.ref}${order} LIMIT ${limit} OFFSET ${offset}`
  }
}

const sqlite = {
  quote: escSqlite,
  literal: sqliteLiteral,
  header: () => 'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n',
  footer: () => 'COMMIT;\nPRAGMA foreign_keys=ON;\n',
  async listTables(s) {
    const rows = await s.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
    )
    return rows.map(r => r.name)
  },
  async tableInfo(s, name) {
    const rows = await s.query(`PRAGMA table_xinfo(${escSqlite(name)})`)
    const pkCols = rows.filter(r => r.pk > 0).sort((a, b) => a.pk - b.pk)
    return {
      name,
      ref: escSqlite(name),
      // hidden != 0 covers generated and virtual-table columns, which can't be INSERTed.
      columns: rows.filter(r => r.hidden === 0).map(r => r.name),
      pk: pkCols.map(r => r.name),
      // A nullable PK (legal in SQLite) would break `pk > last` paging; fall back to OFFSET.
      keyset: pkCols.length === 1 && (pkCols[0].notnull === 1 || /^INTEGER$/i.test(pkCols[0].type))
    }
  },
  async createTable(s, info, { dropExisting }) {
    const [tbl] = await s.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [info.name])
    // Indexes and triggers go AFTER the data: faster loads, and (critically) triggers
    // must not fire against the rows being restored.
    const extras = await s.query(
      "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END, name",
      [info.name]
    )
    return {
      pre: (dropExisting ? `DROP TABLE IF EXISTS ${info.ref};\n` : '') + tbl.sql + ';\n',
      post: extras.map(r => r.sql + ';\n').join('')
    }
  },
  insertPrefix: (info) => `INSERT INTO ${info.ref} (${info.columns.map(escSqlite).join(', ')}) VALUES\n`,
  page(info, { last, offset, limit }) {
    const cols = info.columns.map(escSqlite).join(', ')
    if (info.pk.length === 1 && info.keyset) {
      const k = escSqlite(info.pk[0])
      return `SELECT ${cols} FROM ${info.ref}${last ? ` WHERE ${k} > ${sqliteLiteral(last.value)}` : ''} ORDER BY ${k} LIMIT ${limit}`
    }
    const order = info.pk.length ? info.pk.map(escSqlite).join(', ') : 'rowid'
    return `SELECT ${cols} FROM ${info.ref} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`
  }
}

// Postgres. NOTE: the driver's listTables() spans every non-system schema by bare
// name, while the dump covers current_schema() only (so names stay unambiguous
// and restore lands in the target's default schema). Other-schema tables are
// reported as skipped.
const postgres = {
  quote: escSqlite,
  literal: postgresLiteral,
  header: () => "SET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\nBEGIN;\n",
  footer: () => 'COMMIT;\n',
  async listTables(s) {
    const rows = await s.query(
      "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY c.relname"
    )
    return rows.map(r => r.name)
  },
  async tableInfo(s, name) {
    const ref = escSqlite(name)
    const [rel] = await s.query(
      `SELECT c.oid::int AS oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = ${quoteStd(name)}`
    )
    const oid = rel.oid
    const cols = await s.query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
              pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity AS identity, a.attgenerated AS generated,
              bt.typtype AS basetype, bt.typname AS basename,
              (bt.typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())) AS localtype,
              (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = bt.oid) AS labels
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_type bt ON bt.oid = CASE WHEN t.typcategory = 'A' THEN t.typelem ELSE t.oid END
       WHERE a.attrelid = ${oid} AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`
    )
    const pk = await s.query(
      `SELECT a.attname AS name FROM pg_constraint c
       CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = ${oid} AND c.contype = 'p' ORDER BY k.ord`
    )
    // Columns fed by a sequence (serial via nextval default, or identity) need
    // their sequence re-synced after the data load.
    const seqCols = []
    for (const c of cols) {
      const nextval = c.def?.match(/^nextval\('(.+)'::regclass\)$/)
      if (!nextval && !c.identity) continue
      const [own] = await s.query(`SELECT pg_get_serial_sequence(${quoteStd(ref)}, ${quoteStd(c.name)}) AS seq`)
      seqCols.push({ col: c.name, owned: !!own?.seq, seq: nextval ? nextval[1] : null })
    }
    return {
      name, ref, oid, cols, seqCols,
      columns: cols.filter(c => c.generated !== 's').map(c => c.name),
      pk: pk.map(r => r.name),
      keyset: true,
      identityAlways: cols.some(c => c.identity === 'a')
    }
  },
  async createTable(s, info, ctx) {
    const lines = []
    // DROP goes first: an owned serial sequence dies with its table, so the
    // CREATE SEQUENCE IF NOT EXISTS below must run after it. CASCADE also drops
    // FKs on other tables that point here; FKs from dumped tables come back via
    // their own post section, those from tables outside the dump via tail().
    let pre = ctx.dropExisting ? `DROP TABLE IF EXISTS ${info.ref} CASCADE;\n` : ''
    for (const c of info.cols) {
      // CREATE TYPE has no IF NOT EXISTS; trap duplicate_object instead.
      if (c.basetype === 'e' && c.localtype && !ctx.seen.has(c.basename)) {
        ctx.seen.add(c.basename)
        pre += `DO $$ BEGIN CREATE TYPE ${escSqlite(c.basename)} AS ENUM (${(c.labels ?? []).map(quoteStd).join(', ')}); EXCEPTION WHEN duplicate_object THEN NULL; END $$;\n`
      }
    }
    for (const sc of info.seqCols) {
      if (sc.seq) pre += `CREATE SEQUENCE IF NOT EXISTS ${sc.seq};\n`
    }
    for (const c of info.cols) {
      let line = `${escSqlite(c.name)} ${c.type}`
      if (c.identity) line += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`
      else if (c.generated === 's') line += ` GENERATED ALWAYS AS (${c.def}) STORED`
      else if (c.def != null) line += ` DEFAULT ${c.def}`
      if (c.notnull) line += ' NOT NULL'
      lines.push(line)
    }
    // PK / UNIQUE / CHECK / EXCLUDE live inside CREATE TABLE; FKs are deferred until after the data.
    const cons = await s.query(
      `SELECT c.conname AS name, c.contype AS type, pg_get_constraintdef(c.oid) AS def,
              (SELECT relname FROM pg_class WHERE oid = c.confrelid) AS reftable
       FROM pg_constraint c WHERE c.conrelid = ${info.oid} AND c.contype IN ('p', 'u', 'c', 'x', 'f') ORDER BY c.contype <> 'p', c.conname`
    )
    for (const c of cons) {
      if (c.type !== 'f') lines.push(`CONSTRAINT ${escSqlite(c.name)} ${c.def}`)
    }
    pre += `CREATE TABLE ${info.ref} (\n  ${lines.join(',\n  ')}\n);\n`

    let post = ''
    for (const c of cons) {
      if (c.type !== 'f') continue
      if (!ctx.selected.has(c.reftable)) {
        post += `-- skipped foreign key ${oneLine(c.name)}: references ${oneLine(c.reftable)}, which is not part of this dump\n`
        continue
      }
      post += `ALTER TABLE ${info.ref} ADD CONSTRAINT ${escSqlite(c.name)} ${c.def};\n`
    }
    const idx = await s.query(
      `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
       WHERE i.indrelid = ${info.oid}
         AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid AND c.contype IN ('p', 'u', 'x'))
       ORDER BY 1`
    )
    for (const r of idx) post += r.def + ';\n'
    // Make serial sequences die with their table (like real serial columns).
    for (const sc of info.seqCols) {
      if (sc.owned && sc.seq) post += `ALTER SEQUENCE ${sc.seq} OWNED BY ${info.ref}.${escSqlite(sc.col)};\n`
    }
    return { pre, post }
  },
  // Re-add FKs that DROP ... CASCADE removed from tables outside the dump. If the
  // restored data no longer satisfies one, the restore fails loudly, by design.
  // Guarded so restoring into a DB that lacks the parent table (or still has the
  // FK) doesn't abort the whole single-transaction restore.
  async tail(s, infos, ctx) {
    if (!ctx.dropExisting) return ''
    const rows = await s.query(
      `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def, pn.nspname AS pschema, p.relname AS ptable,
              (pn.nspname = current_schema()) AS plocal
       FROM pg_constraint c
       JOIN pg_class p ON p.oid = c.conrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
       JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = r.relnamespace
       WHERE c.contype = 'f' AND rn.nspname = current_schema() AND r.relname IN (${infos.map(i => quoteStd(i.name)).join(', ')})
       ORDER BY pn.nspname, p.relname, c.conname`
    )
    let out = ''
    for (const r of rows) {
      if (r.plocal && ctx.selected.has(r.ptable)) continue
      const parent = `${escSqlite(r.pschema)}.${escSqlite(r.ptable)}`
      out += `DO $sqlmate$ BEGIN IF to_regclass(${quoteStd(parent)}) IS NOT NULL AND NOT EXISTS ` +
        `(SELECT 1 FROM pg_constraint WHERE conname = ${quoteStd(r.name)} AND conrelid = to_regclass(${quoteStd(parent)})) THEN ` +
        `ALTER TABLE ${parent} ADD CONSTRAINT ${escSqlite(r.name)} ${r.def}; END IF; END $sqlmate$;\n`
    }
    return out
  },
  insertPrefix: (info) =>
    `INSERT INTO ${info.ref} (${info.columns.map(escSqlite).join(', ')}) ${info.identityAlways ? 'OVERRIDING SYSTEM VALUE ' : ''}VALUES\n`,
  dataAfter(info) {
    return info.seqCols.map(sc => {
      const col = escSqlite(sc.col)
      const target = sc.owned || !sc.seq
        ? `pg_get_serial_sequence(${quoteStd(info.ref)}, ${quoteStd(sc.col)})`
        : quoteStd(sc.seq)
      return `SELECT setval(${target}, COALESCE(MAX(${col}), 1), MAX(${col}) IS NOT NULL) FROM ${info.ref};\n`
    }).join('')
  },
  page(info, { last, offset, limit }) {
    const cols = info.columns.map(escSqlite).join(', ')
    if (info.pk.length === 1 && info.keyset) {
      const k = escSqlite(info.pk[0])
      return `SELECT ${cols} FROM ${info.ref}${last ? ` WHERE ${k} > ${postgresLiteral(last.value)}` : ''} ORDER BY ${k} LIMIT ${limit}`
    }
    // ctid is stable inside a snapshot, so heap tables still page deterministically.
    const order = info.pk.length ? info.pk.map(escSqlite).join(', ') : 'ctid'
    return `SELECT ${cols} FROM ${info.ref} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`
  }
}

const MSSQL_TEXT_TYPES = new Set(['date', 'time', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'])

function mssqlTypeName(c) {
  const t = c.type
  if (c.user_defined) return `${escMssql(c.type_schema)}.${escMssql(t)}`
  if (['char', 'varchar', 'binary', 'varbinary'].includes(t)) return `${t}(${c.max_length === -1 ? 'max' : c.max_length})`
  if (['nchar', 'nvarchar'].includes(t)) return `${t}(${c.max_length === -1 ? 'max' : c.max_length / 2})`
  if (t === 'decimal' || t === 'numeric') return `${t}(${c.precision}, ${c.scale})`
  if (['datetime2', 'datetimeoffset', 'time'].includes(t)) return `${t}(${c.scale})`
  if (t === 'float') return c.precision === 53 ? 'float' : `float(${c.precision})`
  return t
}

// One entry per FK constraint, columns grouped; `where` filters on parent/ref tables.
async function mssqlForeignKeys(s, where) {
  const rows = await s.query(
    `SELECT fk.name AS name, fk.delete_referential_action_desc AS del, fk.update_referential_action_desc AS upd,
            SCHEMA_NAME(pt.schema_id) AS pschema, pt.name AS ptable,
            SCHEMA_NAME(rt.schema_id) AS rschema, rt.name AS rtable, pc.name AS pcol, rc.name AS rcol
     FROM sys.foreign_keys fk
     JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
     JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
     JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
     JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
     JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
     ${where}
     ORDER BY SCHEMA_NAME(pt.schema_id), pt.name, fk.name, fkc.constraint_column_id`
  )
  const fks = new Map()
  for (const r of rows) {
    const key = `${r.pschema}.${r.ptable}.${r.name}`
    if (!fks.has(key)) fks.set(key, { ...r, pcols: [], rcols: [] })
    fks.get(key).pcols.push(escMssql(r.pcol))
    fks.get(key).rcols.push(escMssql(r.rcol))
  }
  return [...fks.values()]
}

function mssqlAddForeignKey(fk) {
  return `ALTER TABLE ${escMssql(fk.pschema)}.${escMssql(fk.ptable)} ADD CONSTRAINT ${escMssql(fk.name)} FOREIGN KEY (${fk.pcols.join(', ')}) ` +
    `REFERENCES ${escMssql(fk.rschema)}.${escMssql(fk.rtable)} (${fk.rcols.join(', ')})` +
    `${fk.del !== 'NO_ACTION' ? ` ON DELETE ${fk.del.replace(/_/g, ' ')}` : ''}` +
    `${fk.upd !== 'NO_ACTION' ? ` ON UPDATE ${fk.upd.replace(/_/g, ' ')}` : ''};\n`
}

// MSSQL: best-effort reconstruction from sys.* catalogs. No GO separators are
// emitted, so restore it as a single batch (or split on `;` yourself); the
// mssql driver can't parse GO anyway.
const mssql = {
  quote: escMssql,
  literal: mssqlLiteral,
  header: () => '',
  footer: () => '',
  async listTables(s) {
    const rows = await s.query(
      'SELECT t.name AS name FROM sys.tables t WHERE t.schema_id = SCHEMA_ID() AND t.is_ms_shipped = 0 ORDER BY t.name'
    )
    return rows.map(r => r.name)
  },
  async tableInfo(s, name) {
    const [sch] = await s.query('SELECT SCHEMA_NAME() AS name')
    const schema = sch.name
    const ref = `${escMssql(schema)}.${escMssql(name)}`
    const cols = await s.query(
      `SELECT c.name AS name, ty.name AS type, ty.is_user_defined AS user_defined, SCHEMA_NAME(ty.schema_id) AS type_schema,
              c.max_length AS max_length, c.precision AS precision, c.scale AS scale, c.is_nullable AS is_nullable,
              c.is_identity AS is_identity, c.is_computed AS is_computed,
              ic.seed_value AS seed, ic.increment_value AS incr,
              dc.name AS defname, dc.definition AS def, cc.definition AS compdef, cc.is_persisted AS persisted
       FROM sys.columns c
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
       LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
       LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
       WHERE c.object_id = OBJECT_ID(N${quoteStd(ref)})
       ORDER BY c.column_id`
    )
    const pk = await s.query(
      `SELECT c.name AS name FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID(N${quoteStd(ref)}) AND i.is_primary_key = 1 ORDER BY ic.key_ordinal`
    )
    // Computed columns and rowversion/timestamp can't be INSERTed.
    const insertable = cols.filter(c => !c.is_computed && c.type !== 'timestamp')
    return {
      name, ref, schema, cols,
      columns: insertable.map(c => c.name),
      colTypes: new Map(insertable.map(c => [c.name, c.type])),
      pk: pk.map(r => r.name),
      keyset: true,
      hasIdentity: insertable.some(c => c.is_identity)
    }
  },
  // Foreign keys that reference any table being dropped must go first (MSSQL has
  // no DROP ... CASCADE). Guarded with IF EXISTS so restoring into an empty DB works.
  async prelude(s, infos, { dropExisting }) {
    if (!dropExisting) return ''
    const names = new Set(infos.map(i => i.name))
    const fks = await s.query(
      `SELECT fk.name AS name, SCHEMA_NAME(pt.schema_id) AS pschema, pt.name AS ptable, rt.name AS rtable, SCHEMA_NAME(rt.schema_id) AS rschema
       FROM sys.foreign_keys fk
       JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
       JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id`
    )
    const schema = infos[0].schema
    let out = ''
    for (const fk of fks) {
      if (fk.rschema !== schema || !names.has(fk.rtable)) continue
      const parent = `${escMssql(fk.pschema)}.${escMssql(fk.ptable)}`
      out += `IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N${quoteStd(fk.name)} AND parent_object_id = OBJECT_ID(N${quoteStd(parent)})) ALTER TABLE ${parent} DROP CONSTRAINT ${escMssql(fk.name)};\n`
    }
    return out
  },
  async createTable(s, info, ctx) {
    const lines = info.cols.map(c => {
      if (c.is_computed) return `${escMssql(c.name)} AS ${c.compdef}${c.persisted ? ' PERSISTED' : ''}`
      let line = `${escMssql(c.name)} ${mssqlTypeName(c)}`
      if (c.is_identity) line += ` IDENTITY(${c.seed},${c.incr})`
      line += c.is_nullable ? ' NULL' : ' NOT NULL'
      if (c.def != null) line += ` CONSTRAINT ${escMssql(c.defname)} DEFAULT ${c.def}`
      return line
    })
    const idxRows = await s.query(
      `SELECT i.name AS name, i.type_desc AS type_desc, i.is_unique AS is_unique, i.is_primary_key AS is_pk,
              i.is_unique_constraint AS is_uc, i.filter_definition AS filter, c.name AS col,
              ic.is_descending_key AS is_desc, ic.is_included_column AS included
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID(N${quoteStd(info.ref)}) AND i.type > 0 AND i.is_hypothetical = 0
       ORDER BY i.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id`
    )
    const indexes = new Map()
    for (const r of idxRows) {
      if (!indexes.has(r.name)) indexes.set(r.name, { ...r, keys: [], inc: [] })
      const ix = indexes.get(r.name)
      if (r.included) ix.inc.push(escMssql(r.col))
      else ix.keys.push(escMssql(r.col) + (r.is_desc ? ' DESC' : ' ASC'))
    }
    let post = ''
    for (const ix of indexes.values()) {
      if (ix.type_desc !== 'CLUSTERED' && ix.type_desc !== 'NONCLUSTERED') {
        post += `-- skipped ${oneLine(ix.type_desc)} index ${oneLine(ix.name)} (not supported by this dump)\n`
      } else if (ix.is_pk || ix.is_uc) {
        lines.push(`CONSTRAINT ${escMssql(ix.name)} ${ix.is_pk ? 'PRIMARY KEY' : 'UNIQUE'} ${ix.type_desc} (${ix.keys.join(', ')})`)
      } else {
        post += `CREATE ${ix.is_unique ? 'UNIQUE ' : ''}${ix.type_desc} INDEX ${escMssql(ix.name)} ON ${info.ref} (${ix.keys.join(', ')})` +
          `${ix.inc.length ? ` INCLUDE (${ix.inc.join(', ')})` : ''}${ix.filter ? ` WHERE ${ix.filter}` : ''};\n`
      }
    }
    const checks = await s.query(
      `SELECT name AS name, definition AS def FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID(N${quoteStd(info.ref)}) ORDER BY name`
    )
    for (const c of checks) lines.push(`CONSTRAINT ${escMssql(c.name)} CHECK ${c.def}`)

    for (const fk of await mssqlForeignKeys(s, `WHERE fk.parent_object_id = OBJECT_ID(N${quoteStd(info.ref)})`)) {
      if (fk.rschema !== info.schema || !ctx.selected.has(fk.rtable)) {
        post += `-- skipped foreign key ${oneLine(fk.name)}: references ${oneLine(fk.rtable)}, which is not part of this dump\n`
        continue
      }
      post += mssqlAddForeignKey(fk)
    }
    const drop = ctx.dropExisting
      ? `IF OBJECT_ID(N${quoteStd(info.ref)}, N'U') IS NOT NULL DROP TABLE ${info.ref};\n`
      : ''
    return { pre: drop + `CREATE TABLE ${info.ref} (\n  ${lines.join(',\n  ')}\n);\n`, post }
  },
  // Re-add FKs the prelude dropped from tables outside the dump (a failure on
  // restore means the data no longer satisfies it, which is better than silence).
  async tail(s, infos, ctx) {
    if (!ctx.dropExisting) return ''
    const schema = infos[0].schema
    let out = ''
    for (const fk of await mssqlForeignKeys(s, '')) {
      if (fk.rschema !== schema || !ctx.selected.has(fk.rtable)) continue
      if (fk.pschema === schema && ctx.selected.has(fk.ptable)) continue
      // Same guard as the prelude's drop: skip if the parent table is absent or the FK survived.
      const parent = `${escMssql(fk.pschema)}.${escMssql(fk.ptable)}`
      out += `IF OBJECT_ID(N${quoteStd(parent)}, N'U') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N${quoteStd(fk.name)} AND parent_object_id = OBJECT_ID(N${quoteStd(parent)})) ` +
        mssqlAddForeignKey(fk)
    }
    return out
  },
  dataBefore: (info) => info.hasIdentity ? `SET IDENTITY_INSERT ${info.ref} ON;\n` : '',
  dataAfter: (info) => info.hasIdentity ? `SET IDENTITY_INSERT ${info.ref} OFF;\n` : '',
  insertPrefix: (info) => `INSERT INTO ${info.ref} (${info.columns.map(escMssql).join(', ')}) VALUES\n`,
  // Dates and exact numerics are fetched as text: lossless (100ns, 38-digit decimals)
  // and independent of JS Date / double coercion.
  selectExpr(info, col) {
    const t = info.colTypes.get(col)
    const x = `x.${escMssql(col)}`
    if (MSSQL_TEXT_TYPES.has(t)) return `CONVERT(varchar(40), ${x}, 121) AS ${escMssql(col)}`
    if (t === 'decimal' || t === 'numeric') return `CONVERT(varchar(80), ${x}) AS ${escMssql(col)}`
    if (t === 'money' || t === 'smallmoney') return `CONVERT(varchar(40), ${x}, 2) AS ${escMssql(col)}`
    return `${x} AS ${escMssql(col)}`
  },
  page(info, { last, offset, limit }) {
    const cols = info.columns.map(c => this.selectExpr(info, c)).join(', ')
    // Qualify with the table alias so ORDER BY / WHERE bind to the real column,
    // not the CONVERTed output alias of the same name.
    const pk = info.pk.map(c => `x.${escMssql(c)}`)
    if (pk.length === 1 && info.keyset) {
      return `SELECT TOP (${limit}) ${cols} FROM ${info.ref} AS x${last ? ` WHERE ${pk[0]} > ${mssqlLiteral(last.value)}` : ''} ORDER BY ${pk[0]}`
    }
    return `SELECT ${cols} FROM ${info.ref} AS x ORDER BY ${pk.length ? pk.join(', ') : '(SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
  }
}

const DIALECTS = { mysql, sqlite, postgres, mssql }

// ─── Dump generation ──────────────────────────────────────────────────────────

const READ_BATCH = 1000
const INSERT_ROWS = 100

async function* readBatches(session, d, info) {
  let last = null
  let offset = 0
  const keyset = info.pk.length === 1 && info.keyset
  for (;;) {
    const rows = await session.queryRows(d.page(info, { last, offset, limit: READ_BATCH }))
    if (rows.length === 0) return
    yield rows
    if (rows.length < READ_BATCH) return
    if (keyset) {
      const value = rows[rows.length - 1][info.pk[0]]
      if (value == null) throw new Error(`Cannot page ${info.name}: NULL primary key value`)
      last = { value }
    } else {
      offset += rows.length
    }
  }
}

// Streams a dump of `tables` (default: every dumpable table) through write(str).
// Returns { tables: [{ name, rows }], skipped: [names that aren't dumpable] }.
export async function dumpDatabase(session, { tables, mode = 'full', dropExisting = true, write, database = '' }) {
  const d = DIALECTS[session.dialect]
  if (!d) throw new Error(`Dump is not supported for dialect: ${session.dialect}`)
  const withSchema = mode !== 'data'
  const withData = mode !== 'schema'

  const available = await d.listTables(session)
  const wanted = tables ? new Set(tables) : null
  const names = wanted ? available.filter(n => wanted.has(n)) : available
  const skipped = wanted ? tables.filter(n => !available.includes(n)) : []
  if (names.length === 0) throw new Error('No dumpable tables found' + (skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''))

  const infos = []
  for (const name of names) infos.push(await d.tableInfo(session, name))
  const ctx = { selected: new Set(names), seen: new Set(), dropExisting }

  await write([
    '-- sqlmate-mcp dump',
    `-- dialect: ${session.dialect}`,
    `-- database: ${oneLine(database)}`,
    `-- created: ${new Date().toISOString()}`,
    `-- mode: ${mode}`,
    `-- tables: ${oneLine(names.join(', '))}`,
    ''
  ].join('\n') + '\n')
  await write(d.header())

  const posts = []
  if (withSchema) {
    if (d.prelude) await write(await d.prelude(session, infos, ctx))
    for (const info of infos) {
      const { pre, post } = await d.createTable(session, info, ctx)
      await write('\n' + pre)
      posts.push(post)
    }
  }

  const summary = []
  for (const info of infos) {
    let count = 0
    if (withData) {
      if (d.dataBefore) await write(d.dataBefore(info))
      const prefix = d.insertPrefix(info)
      for await (const batch of readBatches(session, d, info)) {
        for (let i = 0; i < batch.length; i += INSERT_ROWS) {
          const values = batch.slice(i, i + INSERT_ROWS)
            .map(row => '(' + info.columns.map(c => d.literal(row[c])).join(', ') + ')')
          await write(prefix + values.join(',\n') + ';\n')
        }
        count += batch.length
      }
      if (d.dataAfter) await write(d.dataAfter(info))
    }
    summary.push({ name: info.name, rows: count })
  }

  // FKs, indexes and triggers last so load order never matters and triggers don't fire on restore.
  let tail = posts.join('')
  if (withSchema && d.tail) tail += await d.tail(session, infos, ctx)
  if (tail) await write('\n' + tail)
  await write(d.footer())
  return { tables: summary, skipped }
}

// ─── Output file handling ─────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0')

// Local time, filesystem-safe (no colons).
export function timestamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

// Returns { file, isDefault }. Relative `output` resolves against the project root.
export function resolveDumpPath({ output, root, connectionId, gzip, now }) {
  if (output) return { file: path.resolve(root, output), isDefault: false }
  const safeId = connectionId.replace(/[^A-Za-z0-9._-]/g, '_')
  const name = `${safeId}-${timestamp(now)}.sql${gzip ? '.gz' : ''}`
  return { file: path.resolve(root, '.sqlmate', 'dumps', name), isDefault: true }
}

// Dumps are full of user data; keep an accidental `git add .` from committing them.
export function ensureSqlmateGitignore(root) {
  const dir = path.resolve(root, '.sqlmate')
  fs.mkdirSync(dir, { recursive: true })
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' })
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
}

// Writes to `<file>.partial` and renames on success, so a failed dump never
// clobbers (or leaves a truncated version of) an existing file. write() honors
// backpressure; finish() returns the final byte size, abort() cleans up.
export function createDumpWriter(file, { gzip = false, overwrite = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const partial = file + '.partial'
  const out = fs.createWriteStream(partial)
  const head = gzip ? zlib.createGzip() : out
  if (gzip) head.pipe(out)

  let failure = null
  let fail
  const failed = new Promise((_, reject) => { fail = reject })
  failed.catch(() => {}) // only observed via race below
  const onError = (err) => { failure ??= err; fail(err) }
  out.on('error', onError)
  head.on('error', onError)
  const closed = new Promise(resolve => out.on('close', resolve))

  return {
    async write(chunk) {
      if (failure) throw failure
      if (!head.write(chunk)) await Promise.race([once(head, 'drain'), failed])
    },
    async finish() {
      head.end()
      await Promise.race([closed, failed])
      if (failure) throw failure
      if (!overwrite && fs.existsSync(file)) {
        fs.rmSync(partial, { force: true })
        throw new Error(`Output file already exists: ${file} (pass overwrite: true to replace it)`)
      }
      fs.renameSync(partial, file)
      return fs.statSync(file).size
    },
    async abort() {
      head.destroy()
      out.destroy()
      await closed
      fs.rmSync(partial, { force: true })
    }
  }
}
