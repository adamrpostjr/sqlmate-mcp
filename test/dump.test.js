import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { startMcpServer } from '../src/mcp.js'
import { closeAll } from '../src/drivers.js'
import emitter from '../src/events.js'
import { dumpDatabase, mysqlLiteral, sqliteLiteral, postgresLiteral, mssqlLiteral } from '../src/dump.js'

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

const cleanup = []
after(async () => {
  await closeAll()
  for (const p of cleanup) {
    try { fs.rmSync(p, { recursive: true, force: true }) } catch {}
  }
})

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sqlmate-dump-${name}-`))
  cleanup.push(dir)
  return dir
}

const BIG = 4611686018427387905n // 2^62 + 1: not representable as a JS number

// authors <- books (FK, index, trigger that writes to audit), plus a standalone audit table.
function makeFixture(root) {
  const file = path.join(root, 'fixture.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, bio TEXT, avatar BLOB);
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      title TEXT,
      author_id INTEGER REFERENCES authors(id),
      big INTEGER,
      score REAL
    );
    CREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT);
    CREATE INDEX idx_books_title ON books(title);
    CREATE TRIGGER trg_books_audit AFTER INSERT ON books
    BEGIN
      INSERT INTO audit (note) VALUES ('inserted ' || NEW.title);
    END;
  `)
  db.prepare('INSERT INTO authors (id, name, bio, avatar) VALUES (?, ?, ?, ?)')
    .run(1, "Jane O'Neil", 'line1\nline2\r\nback\\slash \'quoted\' "dq"', new Uint8Array([0, 1, 2, 255, 254]))
  db.prepare('INSERT INTO authors (id, name, bio, avatar) VALUES (?, ?, ?, ?)')
    .run(2, 'Zoë 日本語 🚀', null, new Uint8Array(0))
  const addBook = db.prepare('INSERT INTO books (id, title, author_id, big, score) VALUES (?, ?, ?, ?, ?)')
  addBook.run(1, 'First', 1, BIG, 0.1 + 0.2)
  addBook.run(2, null, 2, -BIG, 3.0)
  addBook.run(3, 'Third', null, 0, 1.5e300)
  db.close()
  return file
}

function snapshot(db) {
  const out = {}
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name)
  for (const name of names) {
    const stmt = db.prepare(`SELECT * FROM "${name}" ORDER BY 1`)
    stmt.setReadBigInts(true)
    out[name] = stmt.all().map(r => ({ ...r }))
  }
  const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map(r => ({ ...r }))
  return { data: out, schema }
}

async function callDump(client, args) {
  const result = await client.callTool({ name: 'dump_database', arguments: args })
  return { result, payload: JSON.parse(result.content[0].text) }
}

function sqliteConn(id, file, root) {
  return [{ id, name: id, type: 'sqlite', path: file, source: 'test', projectRoot: root }]
}

describe('dump_database (sqlite end-to-end)', () => {
  test('full dump round-trips data, indexes and triggers, and drop_existing re-applies cleanly', async () => {
    const root = tmpDir('full')
    const file = makeFixture(root)
    const out = path.join(root, 'out', 'backup.sql')
    await withMcpClient(sqliteConn('rt', file, root), root, async (client) => {
      const { payload } = await callDump(client, { connectionId: 'rt', output: 'out/backup.sql', project_root: root })
      assert.equal(payload.error, undefined)
      assert.equal(payload.file, out)
      assert.equal(payload.mode, 'full')
      assert.deepEqual(payload.tables, [
        { name: 'audit', rows: 3 }, { name: 'authors', rows: 2 }, { name: 'books', rows: 3 }
      ])
      assert.equal(payload.bytes, fs.statSync(out).size)
      assert.equal(typeof payload.durationMs, 'number')
    })

    const sql = fs.readFileSync(out, 'utf8')
    assert.match(sql, /^-- sqlmate-mcp dump/)
    assert.ok(sql.indexOf('CREATE TRIGGER') > sql.indexOf('INSERT INTO "books"'), 'triggers must come after data')

    const source = new DatabaseSync(file)
    const restored = new DatabaseSync(':memory:')
    restored.exec(sql)
    assert.deepEqual(snapshot(restored), snapshot(source))
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 3, 'trigger must not have fired during restore')

    // Re-applying onto the already-restored DB exercises DROP TABLE IF EXISTS.
    restored.exec(sql)
    assert.deepEqual(snapshot(restored), snapshot(source))
    source.close()
    restored.close()
  })

  test('schema mode has no rows, data mode has no DDL', async () => {
    const root = tmpDir('modes')
    const file = makeFixture(root)
    await withMcpClient(sqliteConn('modes', file, root), root, async (client) => {
      const schema = await callDump(client, { connectionId: 'modes', mode: 'schema', output: 'schema.sql', project_root: root })
      assert.ok(schema.payload.tables.every(t => t.rows === 0))
      const schemaSql = fs.readFileSync(schema.payload.file, 'utf8')
      assert.match(schemaSql, /CREATE TABLE/)
      assert.doesNotMatch(schemaSql, /INSERT INTO "/)

      const data = await callDump(client, { connectionId: 'modes', mode: 'data', output: 'data.sql', project_root: root })
      const dataSql = fs.readFileSync(data.payload.file, 'utf8')
      assert.match(dataSql, /INSERT INTO "authors"/)
      assert.doesNotMatch(dataSql, /CREATE|DROP/)
    })
  })

  test('tables subset limits the dump; unknown tables are an error', async () => {
    const root = tmpDir('subset')
    const file = makeFixture(root)
    await withMcpClient(sqliteConn('subset', file, root), root, async (client) => {
      const ok = await callDump(client, { connectionId: 'subset', tables: ['authors'], output: 'a.sql', project_root: root })
      assert.deepEqual(ok.payload.tables.map(t => t.name), ['authors'])
      assert.doesNotMatch(fs.readFileSync(ok.payload.file, 'utf8'), /books/)

      const bad = await callDump(client, { connectionId: 'subset', tables: ['authors', 'nope', 'nada'], output: 'b.sql', project_root: root })
      assert.equal(bad.result.isError, true)
      assert.match(bad.payload.error, /Unknown table\(s\): nope, nada/)
      assert.ok(!fs.existsSync(path.join(root, 'b.sql')))
    })
  })

  test('refuses to overwrite an existing file unless overwrite is true', async () => {
    const root = tmpDir('overwrite')
    const file = makeFixture(root)
    const out = path.join(root, 'exists.sql')
    fs.writeFileSync(out, 'precious')
    await withMcpClient(sqliteConn('ow', file, root), root, async (client) => {
      const refused = await callDump(client, { connectionId: 'ow', output: 'exists.sql', project_root: root })
      assert.equal(refused.result.isError, true)
      assert.match(refused.payload.error, /already exists/)
      assert.equal(fs.readFileSync(out, 'utf8'), 'precious')

      const replaced = await callDump(client, { connectionId: 'ow', output: 'exists.sql', overwrite: true, project_root: root })
      assert.equal(replaced.payload.error, undefined)
      assert.match(fs.readFileSync(out, 'utf8'), /^-- sqlmate-mcp dump/)
      assert.ok(!fs.existsSync(out + '.partial'))
    })
  })

  test('gzip output decompresses to a restorable dump', async () => {
    const root = tmpDir('gzip')
    const file = makeFixture(root)
    await withMcpClient(sqliteConn('gz', file, root), root, async (client) => {
      const { payload } = await callDump(client, { connectionId: 'gz', gzip: true, output: 'dump.sql.gz', project_root: root })
      assert.equal(payload.bytes, fs.statSync(payload.file).size)
      const sql = zlib.gunzipSync(fs.readFileSync(payload.file)).toString('utf8')
      const restored = new DatabaseSync(':memory:')
      restored.exec(sql)
      assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM books').get().n, 3)
      restored.close()
    })
  })

  test('default path lands in .sqlmate/dumps with an auto .gitignore, and event args carry no contents', async () => {
    const root = tmpDir('default')
    const file = makeFixture(root)
    const seen = []
    const onStart = (e) => seen.push(e)
    emitter.on('tool_start', onStart)
    try {
      await withMcpClient(sqliteConn('def conn', file, root), root, async (client) => {
        const { payload } = await callDump(client, { connectionId: 'def conn', gzip: true, project_root: root })
        assert.equal(path.dirname(payload.file), path.join(root, '.sqlmate', 'dumps'))
        assert.match(path.basename(payload.file), /^def_conn-\d{8}-\d{6}\.sql\.gz$/)
        assert.equal(fs.readFileSync(path.join(root, '.sqlmate', '.gitignore'), 'utf8'), '*\n')
      })
    } finally {
      emitter.off('tool_start', onStart)
    }
    const evt = seen.find(e => e.tool === 'dump_database')
    assert.deepEqual(Object.keys(evt.args).sort(), ['connectionId', 'mode', 'tables'])
  })

  test('an existing .sqlmate/.gitignore is left alone', async () => {
    const root = tmpDir('gitignore')
    const file = makeFixture(root)
    fs.mkdirSync(path.join(root, '.sqlmate'))
    fs.writeFileSync(path.join(root, '.sqlmate', '.gitignore'), 'custom\n')
    await withMcpClient(sqliteConn('gi', file, root), root, async (client) => {
      await callDump(client, { connectionId: 'gi', project_root: root })
    })
    assert.equal(fs.readFileSync(path.join(root, '.sqlmate', '.gitignore'), 'utf8'), 'custom\n')
  })

  test('pages through more rows than one read batch (keyset pagination)', async () => {
    const root = tmpDir('paging')
    const file = path.join(root, 'big.sqlite')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE n (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE nopk (v TEXT)')
    db.exec('BEGIN')
    for (let i = 1; i <= 2503; i++) {
      db.prepare('INSERT INTO n (id, v) VALUES (?, ?)').run(i * 3, `v${i}`)
      db.prepare('INSERT INTO nopk (v) VALUES (?)').run(`p${i}`)
    }
    db.exec('COMMIT')
    db.close()
    await withMcpClient(sqliteConn('paging', file, root), root, async (client) => {
      const { payload } = await callDump(client, { connectionId: 'paging', output: 'p.sql', project_root: root })
      assert.deepEqual(payload.tables, [{ name: 'n', rows: 2503 }, { name: 'nopk', rows: 2503 }])
      const restored = new DatabaseSync(':memory:')
      restored.exec(fs.readFileSync(payload.file, 'utf8'))
      assert.equal(restored.prepare('SELECT SUM(id) AS s FROM n').get().s, 3 * (2503 * 2504) / 2)
      assert.equal(restored.prepare('SELECT COUNT(DISTINCT v) AS c FROM nopk').get().c, 2503)
      restored.close()
    })
  })
})

describe('value literal formatters', () => {
  test('mysql', () => {
    assert.equal(mysqlLiteral(null), 'NULL')
    assert.equal(mysqlLiteral(undefined), 'NULL')
    assert.equal(mysqlLiteral(42), '42')
    assert.equal(mysqlLiteral(1.5), '1.5')
    assert.equal(mysqlLiteral(NaN), 'NULL')
    assert.equal(mysqlLiteral(10n), '10')
    assert.equal(mysqlLiteral(true), '1')
    assert.equal(mysqlLiteral(false), '0')
    assert.equal(mysqlLiteral("it's"), "'it''s'")
    assert.equal(mysqlLiteral('a\\b'), "'a\\\\b'")
    assert.equal(mysqlLiteral('a\0b\nc\rd\x1ae'), "'a\\0b\\nc\\rd\\Ze'")
    assert.equal(mysqlLiteral('日本 🚀'), "'日本 🚀'")
    assert.equal(mysqlLiteral(Buffer.from([0xde, 0xad])), "X'dead'")
    assert.equal(mysqlLiteral(Buffer.alloc(0)), "X''")
    assert.equal(mysqlLiteral({ a: "x'y" }), `'{"a":"x''y"}'`)
    assert.equal(mysqlLiteral('9223372036854775807'), "'9223372036854775807'")
  })

  test('sqlite', () => {
    assert.equal(sqliteLiteral(null), 'NULL')
    assert.equal(sqliteLiteral("it's \\ ok\n"), "'it''s \\ ok\n'")
    assert.equal(sqliteLiteral(4611686018427387905n), '4611686018427387905')
    assert.equal(sqliteLiteral(0.30000000000000004), '0.30000000000000004')
    assert.equal(sqliteLiteral(3), '3.0')
    assert.equal(sqliteLiteral(1.5e300), '1.5e+300')
    assert.equal(sqliteLiteral(Infinity), '9e999')
    assert.equal(sqliteLiteral(-Infinity), '-9e999')
    assert.equal(sqliteLiteral(NaN), 'NULL')
    assert.equal(sqliteLiteral(new Uint8Array([1, 171])), "X'01ab'")
  })

  test('postgres', () => {
    assert.equal(postgresLiteral(null), 'NULL')
    assert.equal(postgresLiteral(undefined), 'NULL')
    assert.equal(postgresLiteral("it's"), "'it''s'")
    assert.equal(postgresLiteral('a\\b'), "'a\\b'")
    assert.equal(postgresLiteral('\\xdeadbeef'), "'\\xdeadbeef'")
    assert.equal(postgresLiteral('{1,2,3}'), "'{1,2,3}'")
    assert.equal(postgresLiteral('t'), "'t'")
    assert.equal(postgresLiteral(''), "''")
  })

  test('mssql', () => {
    assert.equal(mssqlLiteral(null), 'NULL')
    assert.equal(mssqlLiteral("it's"), "N'it''s'")
    assert.equal(mssqlLiteral('a\\b\n'), "N'a\\b\n'")
    assert.equal(mssqlLiteral(7), '7')
    assert.equal(mssqlLiteral(1.25), '1.25')
    assert.equal(mssqlLiteral(Infinity), 'NULL')
    assert.equal(mssqlLiteral(true), '1')
    assert.equal(mssqlLiteral(false), '0')
    assert.equal(mssqlLiteral(123n), '123')
    assert.equal(mssqlLiteral(new Date('2024-05-06T07:08:09.123Z')), "'2024-05-06T07:08:09.123'")
    assert.equal(mssqlLiteral(new Date(NaN)), 'NULL')
    assert.equal(mssqlLiteral(Buffer.from([0, 255])), '0x00ff')
  })
})

// No live servers: these drive dumpDatabase with canned catalog answers to
// exercise the DDL/paging code paths and sanity-check the generated SQL text.
function fakeSession(dialect, handlers, rowsByTable) {
  const calls = []
  const answer = (sql, kind) => {
    calls.push(sql)
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql)
    throw new Error(`unexpected ${kind}: ${sql}`)
  }
  return {
    dialect, calls,
    async query(sql) { return answer(sql, 'query') },
    async queryRows(sql) {
      calls.push(sql)
      for (const [re, rows] of rowsByTable) if (re.test(sql)) return rows
      return []
    },
    async close() {}
  }
}

async function runDump(session, opts = {}) {
  let out = ''
  const res = await dumpDatabase(session, { write: async (s) => { out += s }, database: 'testdb', ...opts })
  return { out, res }
}

describe('dumpDatabase generation (fake sessions)', () => {
  test('mysql: SHOW CREATE TABLE, generated columns skipped, keyset paging', async () => {
    const session = fakeSession('mysql', [
      [/INFORMATION_SCHEMA\.TABLES/, () => [{ name: 'users' }]],
      [/INFORMATION_SCHEMA\.COLUMNS/, () => [{ name: 'id', extra: 'auto_increment' }, { name: 'name', extra: '' }, { name: 'g', extra: 'VIRTUAL GENERATED' }]],
      [/KEY_COLUMN_USAGE/, () => [{ name: 'id' }]],
      [/SHOW CREATE TABLE/, () => [{ 'Create Table': 'CREATE TABLE `users` (`id` int)' }]]
    ], [[/FROM `users`/, [{ id: '1', name: "O'Brien\n" }]]])
    const { out, res } = await runDump(session)
    assert.deepEqual(res.tables, [{ name: 'users', rows: 1 }])
    assert.match(out, /SET FOREIGN_KEY_CHECKS=0;/)
    assert.match(out, /DROP TABLE IF EXISTS `users`;\nCREATE TABLE `users` \(`id` int\);/)
    assert.match(out, /INSERT INTO `users` \(`id`, `name`\) VALUES\n\('1', 'O''Brien\\n'\);/)
    assert.match(out, /SET FOREIGN_KEY_CHECKS=1;/)
    assert.ok(session.calls.some(c => /ORDER BY `id` LIMIT 1000/.test(c)))
  })

  test('postgres: constraints inline, FKs/indexes/setval after data, identity override', async () => {
    const cols = [
      { name: 'id', type: 'integer', notnull: true, def: "nextval('users_id_seq'::regclass)", identity: '', generated: '', basetype: 'b', basename: 'int4', localtype: false, labels: null },
      { name: 'mood', type: 'mood', notnull: false, def: null, identity: '', generated: '', basetype: 'e', basename: 'mood', localtype: true, labels: ['sad', "it's ok"] },
      { name: 'oid_', type: 'integer', notnull: true, def: null, identity: 'a', generated: '', basetype: 'b', basename: 'int4', localtype: false, labels: null }
    ]
    const session = fakeSession('postgres', [
      [/relispartition/, () => [{ name: 'users' }]],
      [/c\.oid::int AS oid/, () => [{ oid: 16385 }]],
      [/FROM pg_attribute a\s+LEFT JOIN pg_attrdef/, () => cols],
      [/unnest\(c\.conkey\)/, () => [{ name: 'id' }]],
      [/pg_get_serial_sequence/, () => [{ seq: 'public.users_id_seq' }]],
      [/FROM pg_constraint c WHERE c\.conrelid/, () => [
        { name: 'users_pkey', type: 'p', def: 'PRIMARY KEY (id)', reftable: null },
        { name: 'users_self_fk', type: 'f', def: 'FOREIGN KEY (id) REFERENCES users(id)', reftable: 'users' },
        { name: 'users_other_fk', type: 'f', def: 'FOREIGN KEY (id) REFERENCES elsewhere(id)', reftable: 'elsewhere' }
      ]],
      [/pg_get_indexdef/, () => [{ def: 'CREATE INDEX users_mood_idx ON public.users USING btree (mood)' }]],
      [/WHERE c\.contype = 'f' AND rn\.nspname/, () => [
        { name: 'orders_user_fk', def: 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE', pschema: 'public', ptable: 'orders', plocal: true },
        { name: 'users_self_fk', def: 'FOREIGN KEY (id) REFERENCES users(id)', pschema: 'public', ptable: 'users', plocal: true }
      ]]
    ], [[/FROM "users"/, [{ id: '1', mood: 'sad', oid_: '5' }]]])
    const { out } = await runDump(session)
    assert.match(out, /^BEGIN;$/m)
    assert.match(out, /standard_conforming_strings = on/)
    assert.match(out, /CREATE SEQUENCE IF NOT EXISTS users_id_seq;/)
    assert.match(out, /CREATE TYPE "mood" AS ENUM \('sad', 'it''s ok'\)/)
    assert.match(out, /DROP TABLE IF EXISTS "users" CASCADE;/)
    assert.match(out, /"oid_" integer GENERATED ALWAYS AS IDENTITY NOT NULL/)
    assert.match(out, /"id" integer DEFAULT nextval\('users_id_seq'::regclass\) NOT NULL/)
    assert.match(out, /CONSTRAINT "users_pkey" PRIMARY KEY \(id\)/)
    assert.match(out, /INSERT INTO "users" \("id", "mood", "oid_"\) OVERRIDING SYSTEM VALUE VALUES\n\('1', 'sad', '5'\);/)
    const dataAt = out.indexOf('INSERT INTO')
    assert.ok(out.indexOf('SELECT setval(') > dataAt)
    assert.ok(out.indexOf('ADD CONSTRAINT "users_self_fk"') > dataAt)
    assert.ok(out.indexOf('CREATE INDEX users_mood_idx') > dataAt)
    assert.match(out, /-- skipped foreign key users_other_fk: references elsewhere/)
    assert.match(out, /ALTER SEQUENCE users_id_seq OWNED BY "users"\."id";/)
    assert.ok(out.indexOf('DROP TABLE IF EXISTS "users" CASCADE') < out.indexOf('CREATE SEQUENCE IF NOT EXISTS'), 'DROP must precede CREATE SEQUENCE')
    assert.ok(out.indexOf('CREATE SEQUENCE IF NOT EXISTS') < out.indexOf('CREATE TABLE "users"'))
    // FK on a table outside the dump is restored after data and indexes; the in-dump one is not duplicated.
    const restoredFk = out.indexOf('ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_user_fk" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE; END IF;')
    assert.ok(restoredFk > out.indexOf('CREATE INDEX users_mood_idx'))
    // Guarded so a restore into a DB without "orders" (or with the FK intact) doesn't abort.
    assert.match(out, /DO \$sqlmate\$ BEGIN IF to_regclass\('"public"\."orders"'\) IS NOT NULL AND NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'orders_user_fk'/)
    assert.equal(out.split('"users_self_fk"').length - 1, 1)
    assert.match(out.trimEnd(), /COMMIT;$/)
  })

  test('mssql: identity insert wrapper, FK drop prelude, text-converted dates, TOP paging', async () => {
    const col = (o) => ({ user_defined: false, type_schema: 'sys', max_length: 4, precision: 10, scale: 0, is_nullable: false, is_identity: false, is_computed: false, seed: null, incr: null, defname: null, def: null, compdef: null, persisted: false, ...o })
    const cols = [
      col({ name: 'id', type: 'int', is_identity: true, seed: 1, incr: 1 }),
      col({ name: 'title', type: 'nvarchar', max_length: -1, is_nullable: true }),
      col({ name: 'created', type: 'datetime2', scale: 7, defname: 'DF_c', def: '(sysutcdatetime())' }),
      col({ name: 'amt', type: 'decimal', precision: 18, scale: 4 }),
      col({ name: 'calc', type: 'int', is_computed: true, compdef: '([id]*2)' })
    ]
    const session = fakeSession('mssql', [
      [/FROM sys\.tables t WHERE/, () => [{ name: 'books' }]],
      [/SCHEMA_NAME\(\) AS name/, () => [{ name: 'dbo' }]],
      [/FROM sys\.columns c\s+JOIN sys\.types/, () => cols],
      [/i\.is_primary_key = 1 ORDER BY/, () => [{ name: 'id' }]],
      [/JOIN sys\.tables rt ON rt\.object_id = fk\.referenced_object_id\s*$/, () => [{ name: 'FK_x', pschema: 'dbo', ptable: 'loans', rtable: 'books', rschema: 'dbo' }]],
      [/FROM sys\.indexes i\s+JOIN sys\.index_columns/, () => [
        { name: 'PK_books', type_desc: 'CLUSTERED', is_unique: true, is_pk: true, is_uc: false, filter: null, col: 'id', is_desc: false, included: false },
        { name: 'IX_t', type_desc: 'NONCLUSTERED', is_unique: false, is_pk: false, is_uc: false, filter: null, col: 'title', is_desc: true, included: false }
      ]],
      [/sys\.check_constraints/, () => [{ name: 'CK_a', def: '([amt]>(0))' }]],
      [/WHERE fk\.parent_object_id/, () => []],
      [/FROM sys\.foreign_keys fk\s+JOIN sys\.foreign_key_columns/, () => [
        { name: 'FK_x', del: 'CASCADE', upd: 'NO_ACTION', pschema: 'dbo', ptable: 'loans', rschema: 'dbo', rtable: 'books', pcol: 'book_id', rcol: 'id' },
        { name: 'FK_in', del: 'NO_ACTION', upd: 'NO_ACTION', pschema: 'dbo', ptable: 'books', rschema: 'dbo', rtable: 'books', pcol: 'parent', rcol: 'id' }
      ]]
    ], [[/FROM \[dbo\]\.\[books\] AS x/, [{ id: 1, title: "x'y", created: '2024-01-01 00:00:00.0000000', amt: '12.5000' }]]])
    const { out, res } = await runDump(session)
    assert.deepEqual(res.tables, [{ name: 'books', rows: 1 }])
    assert.match(out, /ALTER TABLE \[dbo\]\.\[loans\] DROP CONSTRAINT \[FK_x\]/)
    assert.match(out, /IF OBJECT_ID\(N'\[dbo\]\.\[books\]', N'U'\) IS NOT NULL DROP TABLE \[dbo\]\.\[books\];/)
    assert.match(out, /\[id\] int IDENTITY\(1,1\) NOT NULL/)
    assert.match(out, /\[title\] nvarchar\(max\) NULL/)
    assert.match(out, /\[created\] datetime2\(7\) NOT NULL CONSTRAINT \[DF_c\] DEFAULT \(sysutcdatetime\(\)\)/)
    assert.match(out, /\[amt\] decimal\(18, 4\) NOT NULL/)
    assert.match(out, /\[calc\] AS \(\[id\]\*2\)/)
    assert.match(out, /CONSTRAINT \[PK_books\] PRIMARY KEY CLUSTERED \(\[id\] ASC\)/)
    assert.match(out, /SET IDENTITY_INSERT \[dbo\]\.\[books\] ON;\nINSERT INTO \[dbo\]\.\[books\] \(\[id\], \[title\], \[created\], \[amt\]\) VALUES\n\(1, N'x''y', N'2024-01-01 00:00:00.0000000', N'12.5000'\);\nSET IDENTITY_INSERT \[dbo\]\.\[books\] OFF;/)
    assert.match(out, /IF OBJECT_ID\(N'\[dbo\]\.\[loans\]', N'U'\) IS NOT NULL AND NOT EXISTS \(SELECT 1 FROM sys\.foreign_keys WHERE name = N'FK_x' AND parent_object_id = OBJECT_ID\(N'\[dbo\]\.\[loans\]'\)\) ALTER TABLE \[dbo\]\.\[loans\] ADD CONSTRAINT \[FK_x\] FOREIGN KEY \(\[book_id\]\) REFERENCES \[dbo\]\.\[books\] \(\[id\]\) ON DELETE CASCADE;/)
    assert.doesNotMatch(out, /ADD CONSTRAINT \[FK_in\]/)
    assert.ok(out.indexOf('ADD CONSTRAINT [FK_x]') > out.indexOf('CREATE NONCLUSTERED INDEX'))
    assert.match(out, /CREATE NONCLUSTERED INDEX \[IX_t\] ON \[dbo\]\.\[books\] \(\[title\] DESC\);/)
    assert.ok(session.calls.some(c => /SELECT TOP \(1000\) .*CONVERT\(varchar\(40\), x\.\[created\], 121\) AS \[created\].* ORDER BY x\.\[id\]/.test(c)))
  })
})
