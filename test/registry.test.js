import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectRegistry } from '../src/registry.js'
import emitter from '../src/events.js'
import { projectId } from '../src/protocol.js'

function conn(overrides = {}) {
  return {
    name: 'Main DB',
    type: 'sqlite',
    source: '/proj/.sqlmaterc',
    database: undefined,
    path: '/tmp/main.sqlite',
    username: 'root',
    password: 'secret',
    ...overrides
  }
}

function waitFor(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── register ───────────────────────────────────────────────────────────────

describe('ProjectRegistry.register', () => {
  test('creates a new project and returns a stable projectId', () => {
    const registry = new ProjectRegistry()
    const { projectId: id1 } = registry.register({ projectRoot: '/proj/a', connections: [conn()] })
    assert.equal(id1, projectId('/proj/a'))
    assert.equal(registry.projects.size, 1)
  })

  test('is idempotent: registering the same payload twice keeps the same ids', () => {
    const registry = new ProjectRegistry()
    const { projectId: id1 } = registry.register({ projectRoot: '/proj/a', connections: [conn()] })
    const firstConnId = registry.projects.get(id1).connections[0].id

    const { projectId: id2 } = registry.register({ projectRoot: '/proj/a', connections: [conn()] })
    assert.equal(id2, id1)
    assert.equal(registry.projects.get(id2).connections[0].id, firstConnId)
    assert.equal(registry.projects.get(id2).connections.length, 1)
  })

  test('second identical registration does not emit projects_changed', () => {
    const registry = new ProjectRegistry()
    registry.register({ projectRoot: '/proj/a', connections: [conn()] })

    let emitted = false
    const onChanged = () => { emitted = true }
    emitter.on('projects_changed', onChanged)
    try {
      registry.register({ projectRoot: '/proj/a', connections: [conn()] })
      assert.equal(emitted, false, 'no-op re-register should not emit projects_changed')
    } finally {
      emitter.off('projects_changed', onChanged)
    }
  })

  test('reconciles: updates changed config in place, keeping the connection id', () => {
    const registry = new ProjectRegistry()
    const { projectId: id } = registry.register({ projectRoot: '/proj/a', connections: [conn({ password: 'old' })] })
    const originalId = registry.projects.get(id).connections[0].id

    registry.register({ projectRoot: '/proj/a', connections: [conn({ password: 'new' })] })
    const stored = registry.projects.get(id).connections[0]
    assert.equal(stored.id, originalId)
    assert.equal(stored.password, 'new')
  })

  test('reconciles: drops connections no longer present', () => {
    const registry = new ProjectRegistry()
    const { projectId: id } = registry.register({
      projectRoot: '/proj/a',
      connections: [conn({ name: 'Keep', database: 'keep' }), conn({ name: 'Drop', database: 'drop' })]
    })
    assert.equal(registry.projects.get(id).connections.length, 2)

    registry.register({ projectRoot: '/proj/a', connections: [conn({ name: 'Keep', database: 'keep' })] })
    const remaining = registry.projects.get(id).connections
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].database, 'keep')
  })

  test('reconciles: adds newly-appeared connections', () => {
    const registry = new ProjectRegistry()
    const { projectId: id } = registry.register({ projectRoot: '/proj/a', connections: [conn({ name: 'One' })] })
    registry.register({
      projectRoot: '/proj/a',
      connections: [conn({ name: 'One' }), conn({ name: 'Two', database: 'two' })]
    })
    assert.equal(registry.projects.get(id).connections.length, 2)
  })

  test('stamps stored connections with projectRoot', () => {
    const registry = new ProjectRegistry()
    const { projectId: id } = registry.register({ projectRoot: '/proj/a', connections: [conn()] })
    assert.equal(registry.projects.get(id).connections[0].projectRoot, '/proj/a')
  })

  // mcp.js's shared `connections` array can contain entries for OTHER project
  // roots (the multi-project-per-server feature) or global (projectRoot: null)
  // ones. register() must not absorb foreign-project connections into the
  // registering project, nor strip a global connection's global-ness.
  test('does not absorb connections belonging to a different project', () => {
    const registry = new ProjectRegistry()
    const { projectId: id } = registry.register({
      projectRoot: '/proj/a',
      connections: [
        conn({ name: 'A DB', database: 'a', projectRoot: '/proj/a' }),
        conn({ name: 'B DB', database: 'b', projectRoot: '/proj/b' })
      ]
    })
    const stored = registry.projects.get(id).connections
    assert.equal(stored.length, 1)
    assert.equal(stored[0].database, 'a')
  })

  test('preserves a global (projectRoot: null) connection as global instead of pinning it to the registering project', () => {
    const registry = new ProjectRegistry()
    const { projectId: id } = registry.register({
      projectRoot: '/proj/a',
      connections: [conn({ name: 'Global DB', database: 'g', projectRoot: null })]
    })
    const stored = registry.projects.get(id).connections
    assert.equal(stored.length, 1)
    assert.equal(stored[0].projectRoot, null)
  })

  test('filters out foreign-project connections on reconciliation too, not just initial registration', () => {
    const registry = new ProjectRegistry()
    const { projectId: id } = registry.register({
      projectRoot: '/proj/a',
      connections: [conn({ name: 'A DB', database: 'a', projectRoot: '/proj/a' })]
    })
    registry.register({
      projectRoot: '/proj/a',
      connections: [
        conn({ name: 'A DB', database: 'a', projectRoot: '/proj/a' }),
        conn({ name: 'B DB', database: 'b', projectRoot: '/proj/b' })
      ]
    })
    const stored = registry.projects.get(id).connections
    assert.equal(stored.length, 1)
    assert.equal(stored[0].database, 'a')
  })
})

// ─── heartbeat ──────────────────────────────────────────────────────────────

describe('ProjectRegistry.heartbeat', () => {
  test('returns false for an unknown projectId', () => {
    const registry = new ProjectRegistry()
    assert.equal(registry.heartbeat('does-not-exist'), false)
  })

  test('returns true and refreshes lastSeen for a known project', async () => {
    const registry = new ProjectRegistry()
    const { projectId: id } = registry.register({ projectRoot: '/proj/a', connections: [] })
    const before = registry.projects.get(id).lastSeen
    await waitFor(5)
    assert.equal(registry.heartbeat(id), true)
    assert.ok(registry.projects.get(id).lastSeen >= before)
  })
})

// ─── remove ─────────────────────────────────────────────────────────────────

describe('ProjectRegistry.remove', () => {
  test('deletes the project and emits projects_changed with a fresh snapshot', () => {
    const registry = new ProjectRegistry()
    const { projectId: id } = registry.register({ projectRoot: '/proj/a', connections: [conn()] })

    let payload = null
    const onChanged = (snap) => { payload = snap }
    emitter.on('projects_changed', onChanged)
    try {
      registry.remove(id)
      assert.equal(registry.projects.has(id), false)
      assert.deepEqual(payload, [])
    } finally {
      emitter.off('projects_changed', onChanged)
    }
  })

  test('removing an unknown projectId is a no-op', () => {
    const registry = new ProjectRegistry()
    assert.doesNotThrow(() => registry.remove('nope'))
  })

  test('never removes the self project, which has no heartbeat to resurrect it', () => {
    const registry = new ProjectRegistry()
    const { projectId: id } = registry.register({ projectRoot: '/proj/self', connections: [conn()], self: true })
    registry.remove(id)
    assert.equal(registry.projects.has(id), true)
  })
})

describe('ProjectRegistry.getSelfProjectId', () => {
  test('returns null when no self project is registered', () => {
    const registry = new ProjectRegistry()
    registry.register({ projectRoot: '/proj/a', connections: [] })
    assert.equal(registry.getSelfProjectId(), null)
  })

  test('returns the id of the project registered with self: true', () => {
    const registry = new ProjectRegistry()
    registry.register({ projectRoot: '/proj/a', connections: [] })
    const { projectId: selfId } = registry.register({ projectRoot: '/proj/self', connections: [], self: true })
    assert.equal(registry.getSelfProjectId(), selfId)
  })
})

// ─── GC ─────────────────────────────────────────────────────────────────────

describe('ProjectRegistry GC', () => {
  test('expires projects whose heartbeat is older than ttlMs', async () => {
    const registry = new ProjectRegistry({ ttlMs: 20, gcIntervalMs: 10 })
    const { projectId: id } = registry.register({ projectRoot: '/proj/gc', connections: [] })
    registry.startGc()
    try {
      assert.equal(registry.projects.has(id), true)
      await waitFor(150)
      assert.equal(registry.projects.has(id), false)
    } finally {
      registry.stopGc()
    }
  })

  test('a heartbeating project survives GC sweeps', async () => {
    const registry = new ProjectRegistry({ ttlMs: 30, gcIntervalMs: 10 })
    const { projectId: id } = registry.register({ projectRoot: '/proj/alive', connections: [] })
    registry.startGc()
    try {
      const interval = setInterval(() => registry.heartbeat(id), 10)
      await waitFor(100)
      clearInterval(interval)
      assert.equal(registry.projects.has(id), true)
    } finally {
      registry.stopGc()
    }
  })

  test('never expires the self project, even without heartbeats', async () => {
    const registry = new ProjectRegistry({ ttlMs: 20, gcIntervalMs: 10 })
    const { projectId: id } = registry.register({ projectRoot: '/proj/self', connections: [], self: true })
    registry.startGc()
    try {
      await waitFor(150)
      assert.equal(registry.projects.has(id), true)
    } finally {
      registry.stopGc()
    }
  })
})

// ─── findConnection ─────────────────────────────────────────────────────────

describe('ProjectRegistry.findConnection', () => {
  test('scopes lookups per project, even with colliding connection ids', () => {
    const registry = new ProjectRegistry()
    const { projectId: idA } = registry.register({ projectRoot: '/proj/a', connections: [conn({ database: 'a' })] })
    const { projectId: idB } = registry.register({ projectRoot: '/proj/b', connections: [conn({ database: 'b' })] })

    const connIdA = registry.projects.get(idA).connections[0].id
    const connIdB = registry.projects.get(idB).connections[0].id
    assert.equal(connIdA, connIdB, 'both connections should slugify to the same id within their own project')

    assert.equal(registry.findConnection(idA, connIdA).database, 'a')
    assert.equal(registry.findConnection(idB, connIdB).database, 'b')
  })

  test('throws when the connection does not exist', () => {
    const registry = new ProjectRegistry()
    const { projectId: id } = registry.register({ projectRoot: '/proj/a', connections: [] })
    assert.throws(() => registry.findConnection(id, 'nope'), /Connection not found/)
  })

  test('throws when the project does not exist', () => {
    const registry = new ProjectRegistry()
    assert.throws(() => registry.findConnection('nope', 'nope'), /Connection not found/)
  })
})

// ─── snapshot ───────────────────────────────────────────────────────────────

describe('ProjectRegistry.snapshot', () => {
  test('excludes credentials', () => {
    const registry = new ProjectRegistry()
    registry.register({ projectRoot: '/proj/a', connections: [conn()] })
    const snap = registry.snapshot()
    assert.equal(snap.length, 1)
    const c = snap[0].connections[0]
    assert.deepEqual(Object.keys(c).sort(), ['id', 'name', 'path', 'source', 'type'])
    assert.equal(c.password, undefined)
    assert.equal(c.username, undefined)
  })

  test('includes non-secret host/port/database for networked connections', () => {
    const registry = new ProjectRegistry()
    registry.register({
      projectRoot: '/proj/a',
      connections: [conn({ type: 'mysql', path: undefined, host: 'db.internal', port: 3306, database: 'shop' })]
    })
    const c = registry.snapshot()[0].connections[0]
    assert.equal(c.host, 'db.internal')
    assert.equal(c.port, 3306)
    assert.equal(c.database, 'shop')
    assert.equal(c.username, undefined)
    assert.equal(c.password, undefined)
  })
})
