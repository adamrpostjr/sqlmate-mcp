import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  slugify,
  parseConnectionUrl,
  inferTypeFromEnv,
  buildFromEnv,
  normalizeRcEntry,
  assignId,
  loadConnections,
  mergeProjectConnections,
  resolveConnection,
} from '../src/connections.js'

// ─── helpers ────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sqlmate-test-'))
}

function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content, 'utf8')
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
}

// ─── slugify ────────────────────────────────────────────────────────────────

describe('slugify', () => {
  test('lowercases and replaces non-alphanumeric with hyphens', () => {
    assert.equal(slugify('My Database'), 'my-database')
    assert.equal(slugify('ENV MySQL'), 'env-mysql')
    assert.equal(slugify('  leading/trailing  '), 'leading-trailing')
  })

  test('strips leading and trailing hyphens', () => {
    assert.equal(slugify('---foo---'), 'foo')
  })
})

// ─── parseConnectionUrl ─────────────────────────────────────────────────────

describe('parseConnectionUrl', () => {
  test('parses mysql URL', () => {
    const conn = parseConnectionUrl('mysql://root:secret@localhost:3306/myapp')
    assert.equal(conn.type, 'mysql')
    assert.equal(conn.host, 'localhost')
    assert.equal(conn.port, 3306)
    assert.equal(conn.username, 'root')
    assert.equal(conn.password, 'secret')
    assert.equal(conn.database, 'myapp')
  })

  test('parses mysql2 scheme as mysql', () => {
    const conn = parseConnectionUrl('mysql2://root@localhost/db')
    assert.equal(conn.type, 'mysql')
  })

  test('parses sqlite URL', () => {
    const conn = parseConnectionUrl('sqlite:///home/user/db.sqlite')
    assert.equal(conn.type, 'sqlite')
    assert.equal(conn.path, '/home/user/db.sqlite')
  })

  test('parses sqlserver URL as mssql', () => {
    const conn = parseConnectionUrl('sqlserver://sa:pass@host:1433/mydb')
    assert.equal(conn.type, 'mssql')
    assert.equal(conn.port, 1433)
  })

  test('returns null for unsupported scheme', () => {
    assert.equal(parseConnectionUrl('postgres://localhost/db'), null)
  })

  test('returns null for malformed URL', () => {
    assert.equal(parseConnectionUrl('not a url'), null)
  })

  test('defaults missing port for mysql', () => {
    const conn = parseConnectionUrl('mysql://root@localhost/db')
    assert.equal(conn.port, 3306)
  })

  test('defaults missing port for mssql', () => {
    const conn = parseConnectionUrl('sqlserver://sa@host/db')
    assert.equal(conn.port, 1433)
  })
})

// ─── inferTypeFromEnv ───────────────────────────────────────────────────────

describe('inferTypeFromEnv', () => {
  test('infers mysql from DB_CONNECTION=mysql', () => {
    assert.equal(inferTypeFromEnv({ DB_CONNECTION: 'mysql' }), 'mysql')
  })

  test('infers sqlite from DB_CONNECTION=sqlite', () => {
    assert.equal(inferTypeFromEnv({ DB_CONNECTION: 'sqlite' }), 'sqlite')
  })

  test('infers mssql from DB_CONNECTION=sqlsrv', () => {
    assert.equal(inferTypeFromEnv({ DB_CONNECTION: 'sqlsrv' }), 'mssql')
  })

  test('infers mysql from DB_PORT=3306 when DB_CONNECTION absent', () => {
    assert.equal(inferTypeFromEnv({ DB_PORT: '3306' }), 'mysql')
  })

  test('infers mssql from DB_PORT=1433', () => {
    assert.equal(inferTypeFromEnv({ DB_PORT: '1433' }), 'mssql')
  })

  test('returns null when nothing matches', () => {
    assert.equal(inferTypeFromEnv({}), null)
  })
})

// ─── buildFromEnv ───────────────────────────────────────────────────────────

describe('buildFromEnv', () => {
  test('builds mysql connection from laravel-style vars', () => {
    const conn = buildFromEnv({
      DB_CONNECTION: 'mysql',
      DB_HOST: '127.0.0.1',
      DB_PORT: '3306',
      DB_DATABASE: 'myapp',
      DB_USERNAME: 'root',
      DB_PASSWORD: 'secret',
    })
    assert.equal(conn.type, 'mysql')
    assert.equal(conn.host, '127.0.0.1')
    assert.equal(conn.database, 'myapp')
    assert.equal(conn.username, 'root')
    assert.equal(conn.password, 'secret')
  })

  test('builds sqlite connection from DB_PATH', () => {
    const conn = buildFromEnv({ DB_CONNECTION: 'sqlite', DB_PATH: '/tmp/test.db' })
    assert.equal(conn.type, 'sqlite')
    assert.equal(conn.path, '/tmp/test.db')
  })

  test('prefers DATABASE_URL over individual vars', () => {
    const conn = buildFromEnv({
      DATABASE_URL: 'mysql://u:p@host/db',
      DB_CONNECTION: 'sqlite',
    })
    assert.equal(conn.type, 'mysql')
  })

  test('returns null when no type can be determined', () => {
    assert.equal(buildFromEnv({ SOME_OTHER_VAR: 'value' }), null)
  })
})

// ─── normalizeRcEntry ───────────────────────────────────────────────────────

describe('normalizeRcEntry', () => {
  test('normalizes a full entry', () => {
    const conn = normalizeRcEntry({
      name: 'Prod DB',
      type: 'MYSQL',
      host: 'db.example.com',
      port: 3306,
      username: 'admin',
      password: 'pw',
      database: 'prod',
    })
    assert.equal(conn.type, 'mysql')
    assert.equal(conn.name, 'Prod DB')
    assert.equal(conn.source, '.sqlmaterc')
    assert.deepEqual(conn.options, {})
  })

  test('defaults missing name to "Unnamed"', () => {
    const conn = normalizeRcEntry({ type: 'sqlite', path: '/db.sqlite' })
    assert.equal(conn.name, 'Unnamed')
  })
})

// ─── assignId ───────────────────────────────────────────────────────────────

describe('assignId', () => {
  test('assigns base id when no collision', () => {
    const conn = assignId({ name: 'My DB' }, [])
    assert.equal(conn.id, 'my-db')
  })

  test('appends suffix on collision', () => {
    const existing = [{ id: 'my-db' }, { id: 'my-db-2' }]
    const conn = assignId({ name: 'My DB' }, existing)
    assert.equal(conn.id, 'my-db-3')
  })
})

// ─── loadConnections ────────────────────────────────────────────────────────

describe('loadConnections', () => {
  test('returns empty array for empty directory', () => {
    const dir = tmpDir()
    try {
      assert.deepEqual(loadConnections(dir), [])
    } finally {
      cleanup(dir)
    }
  })

  test('loads connection from .env file', () => {
    const dir = tmpDir()
    try {
      writeFile(dir, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_PORT=3306\nDB_DATABASE=app\nDB_USERNAME=root\nDB_PASSWORD=\n')
      const conns = loadConnections(dir)
      assert.equal(conns.length, 1)
      assert.equal(conns[0].type, 'mysql')
      assert.equal(conns[0].database, 'app')
    } finally {
      cleanup(dir)
    }
  })

  test('loads connections from .sqlmaterc file', () => {
    const dir = tmpDir()
    try {
      writeFile(dir, '.sqlmaterc', JSON.stringify([
        { name: 'Alpha', type: 'mysql', host: 'host1', database: 'db1', username: 'u', password: 'p' },
        { name: 'Beta', type: 'mysql', host: 'host2', database: 'db2', username: 'u', password: 'p' },
      ]))
      const conns = loadConnections(dir)
      assert.equal(conns.length, 2)
      assert.equal(conns[0].name, 'Alpha')
      assert.equal(conns[1].name, 'Beta')
    } finally {
      cleanup(dir)
    }
  })

  test('assigns unique ids when .env and .sqlmaterc both present', () => {
    const dir = tmpDir()
    try {
      writeFile(dir, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_DATABASE=envdb\nDB_USERNAME=root\nDB_PASSWORD=\n')
      writeFile(dir, '.sqlmaterc', JSON.stringify([
        { name: 'RC DB', type: 'mysql', host: 'localhost', database: 'rcdb', username: 'root', password: '' },
      ]))
      const conns = loadConnections(dir)
      const ids = conns.map(c => c.id)
      assert.equal(new Set(ids).size, ids.length, 'ids must be unique')
    } finally {
      cleanup(dir)
    }
  })

  test('ignores malformed .sqlmaterc without throwing', () => {
    const dir = tmpDir()
    try {
      writeFile(dir, '.sqlmaterc', '{ bad json }}}')
      assert.doesNotThrow(() => loadConnections(dir))
    } finally {
      cleanup(dir)
    }
  })
})

// ─── mergeProjectConnections ────────────────────────────────────────────────

describe('mergeProjectConnections', () => {
  test('adds connections from a project directory', () => {
    const dir = tmpDir()
    try {
      writeFile(dir, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_DATABASE=newproject\nDB_USERNAME=root\nDB_PASSWORD=\n')
      const list = []
      const { added } = mergeProjectConnections(list, dir)
      assert.equal(added.length, 1)
      assert.equal(list.length, 1)
      assert.equal(list[0].database, 'newproject')
    } finally {
      cleanup(dir)
    }
  })

  test('tags added connections with their projectRoot', () => {
    const dir = tmpDir()
    try {
      writeFile(dir, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_DATABASE=db\nDB_USERNAME=root\nDB_PASSWORD=\n')
      const list = []
      mergeProjectConnections(list, dir)
      assert.equal(list[0].projectRoot, dir)
    } finally {
      cleanup(dir)
    }
  })

  test('resolves source to absolute path', () => {
    const dir = tmpDir()
    try {
      writeFile(dir, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_DATABASE=db\nDB_USERNAME=root\nDB_PASSWORD=\n')
      const list = []
      mergeProjectConnections(list, dir)
      assert.ok(path.isAbsolute(list[0].source), 'source should be an absolute path')
      assert.ok(list[0].source.includes(dir), 'source should contain the project root')
    } finally {
      cleanup(dir)
    }
  })

  test('is idempotent: repeated calls do not grow the list or change ids', () => {
    const dir = tmpDir()
    try {
      writeFile(dir, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_DATABASE=db\nDB_USERNAME=root\nDB_PASSWORD=\n')
      const list = []
      mergeProjectConnections(list, dir)
      const firstId = list[0].id
      const { added, removed } = mergeProjectConnections(list, dir)
      assert.equal(added.length, 0, 'second call should add nothing')
      assert.equal(removed.length, 0, 'second call should remove nothing')
      assert.equal(list.length, 1, 'list should still have one connection')
      assert.equal(list[0].id, firstId, 'id should be stable across reloads')
    } finally {
      cleanup(dir)
    }
  })

  test('first merge of the startup project is a no-op (source absolutized at load)', () => {
    const dir = tmpDir()
    try {
      writeFile(dir, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_DATABASE=db\nDB_USERNAME=root\nDB_PASSWORD=\n')
      const list = loadConnections(dir)          // simulate startup load
      const startupId = list[0].id
      const { added, removed } = mergeProjectConnections(list, dir)  // first list_connections(project_root)
      assert.equal(added.length, 0, 'startup connection should not be re-added')
      assert.equal(removed.length, 0, 'startup connection should not be removed')
      assert.equal(list.length, 1)
      assert.equal(list[0].id, startupId, 'id should be preserved from startup')
    } finally {
      cleanup(dir)
    }
  })

  test('adds connections from a second project without removing the first', () => {
    const dirA = tmpDir()
    const dirB = tmpDir()
    try {
      writeFile(dirA, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_DATABASE=project_a\nDB_USERNAME=root\nDB_PASSWORD=\n')
      writeFile(dirB, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_DATABASE=project_b\nDB_USERNAME=root\nDB_PASSWORD=\n')
      const list = []
      mergeProjectConnections(list, dirA)
      mergeProjectConnections(list, dirB)
      assert.equal(list.length, 2)
      const dbs = list.map(c => c.database)
      assert.ok(dbs.includes('project_a'))
      assert.ok(dbs.includes('project_b'))
    } finally {
      cleanup(dirA, dirB)
    }
  })

  test('assigns unique ids when two projects have the same connection name', () => {
    const dirA = tmpDir()
    const dirB = tmpDir()
    try {
      // Both projects produce an "env-mysql" id
      writeFile(dirA, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_DATABASE=a\nDB_USERNAME=root\nDB_PASSWORD=\n')
      writeFile(dirB, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_DATABASE=b\nDB_USERNAME=root\nDB_PASSWORD=\n')
      const list = []
      mergeProjectConnections(list, dirA)
      mergeProjectConnections(list, dirB)
      const ids = list.map(c => c.id)
      assert.equal(new Set(ids).size, ids.length, 'all ids must be unique')
    } finally {
      cleanup(dirA, dirB)
    }
  })

  test('assigns unique ids to two connections in the same batch sharing a base id', () => {
    const dir = tmpDir()
    try {
      // Two .sqlmaterc entries with the same name both slugify to the same base
      writeFile(dir, '.sqlmaterc', JSON.stringify([
        { name: 'DB', type: 'mysql', host: 'h1', database: 'one', username: 'u', password: 'p' },
        { name: 'db', type: 'mysql', host: 'h2', database: 'two', username: 'u', password: 'p' },
      ]))
      const list = []
      mergeProjectConnections(list, dir)
      const ids = list.map(c => c.id)
      assert.equal(list.length, 2)
      assert.equal(new Set(ids).size, 2, 'sibling connections must get distinct ids')
    } finally {
      cleanup(dir)
    }
  })

  test('removes a connection dropped from config and reports it via removed + onRemoved', () => {
    const dir = tmpDir()
    try {
      writeFile(dir, '.sqlmaterc', JSON.stringify([
        { name: 'Keep', type: 'mysql', host: 'h', database: 'keep', username: 'u', password: 'p' },
        { name: 'Drop', type: 'mysql', host: 'h', database: 'drop', username: 'u', password: 'p' },
      ]))
      const list = []
      mergeProjectConnections(list, dir)
      const dropId = list.find(c => c.database === 'drop').id

      // Rewrite config without the "Drop" connection
      writeFile(dir, '.sqlmaterc', JSON.stringify([
        { name: 'Keep', type: 'mysql', host: 'h', database: 'keep', username: 'u', password: 'p' },
      ]))
      const invalidated = []
      const { removed } = mergeProjectConnections(list, dir, (id) => invalidated.push(id))
      assert.deepEqual(removed, [dropId])
      assert.deepEqual(invalidated, [dropId], 'onRemoved should fire for the dropped connection')
      assert.equal(list.length, 1)
      assert.equal(list[0].database, 'keep')
    } finally {
      cleanup(dir)
    }
  })

  test('updates changed credentials in place, keeps id, and invalidates the driver', () => {
    const dir = tmpDir()
    try {
      writeFile(dir, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_DATABASE=db\nDB_USERNAME=root\nDB_PASSWORD=old\n')
      const list = []
      mergeProjectConnections(list, dir)
      const originalId = list[0].id

      writeFile(dir, '.env', 'DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_DATABASE=db\nDB_USERNAME=root\nDB_PASSWORD=new\n')
      const invalidated = []
      const { added, removed } = mergeProjectConnections(list, dir, (id) => invalidated.push(id))
      assert.equal(added.length, 0)
      assert.equal(removed.length, 0)
      assert.equal(list.length, 1)
      assert.equal(list[0].id, originalId, 'id stays stable when only credentials change')
      assert.equal(list[0].password, 'new', 'password should be updated in place')
      assert.deepEqual(invalidated, [originalId], 'stale driver should be invalidated')
    } finally {
      cleanup(dir)
    }
  })

  test('leaves other-project and global connections untouched for empty directory', () => {
    const dir = tmpDir()
    const existing = [{ id: 'x', source: '/other/.env', database: 'existing', path: undefined, projectRoot: '/other' }]
    try {
      const { added, removed } = mergeProjectConnections(existing, dir)
      assert.equal(added.length, 0)
      assert.equal(removed.length, 0)
      assert.equal(existing.length, 1)
    } finally {
      cleanup(dir)
    }
  })
})

// ─── resolveConnection ──────────────────────────────────────────────────────

describe('resolveConnection', () => {
  const list = [
    { id: 'env-mysql', database: 'a', projectRoot: '/proj/a' },
    { id: 'env-mysql-2', database: 'b', projectRoot: '/proj/b' },
    { id: 'manual', database: 'g', projectRoot: null },
  ]

  test('resolves an id within its own project', () => {
    assert.equal(resolveConnection(list, 'env-mysql', '/proj/a').database, 'a')
    assert.equal(resolveConnection(list, 'env-mysql-2', '/proj/b').database, 'b')
  })

  test('throws when resolving an id belonging to another project (no leakage)', () => {
    assert.throws(() => resolveConnection(list, 'env-mysql-2', '/proj/a'), /not found in this project/)
  })

  test('resolves global (projectRoot: null) connections in any project', () => {
    assert.equal(resolveConnection(list, 'manual', '/proj/a').database, 'g')
    assert.equal(resolveConnection(list, 'manual', '/proj/b').database, 'g')
  })

  test('falls back to id-only match when projectRoot is omitted', () => {
    assert.equal(resolveConnection(list, 'env-mysql-2').database, 'b')
  })

  test('throws when the id does not exist at all', () => {
    assert.throws(() => resolveConnection(list, 'nope', '/proj/a'), /Connection not found: nope/)
  })
})
