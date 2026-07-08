import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startGuiServer } from '../src/gui.js'
import { ProjectRegistry } from '../src/registry.js'
import { startAttach, probeHost } from '../src/attach.js'
import emitter from '../src/events.js'

async function withServer(fn) {
  const registry = new ProjectRegistry()
  const server = await startGuiServer(registry, 0)
  const port = server.address().port
  try {
    await fn({ registry, port, server })
  } finally {
    registry.stopGc()
    await new Promise(resolve => server.close(resolve))
  }
}

function waitFor(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitUntil(predicate, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitUntil: timed out')
    await waitFor(interval)
  }
}

describe('startAttach', () => {
  test('registers the project with the host and returns a projectId', async () => {
    await withServer(async ({ registry, port }) => {
      const attach = await startAttach({ port, projectRoot: '/proj/client-a', connections: [] })
      try {
        assert.equal(typeof attach.projectId, 'string')
        const snap = registry.snapshot()
        assert.equal(snap.length, 1)
        assert.equal(snap[0].projectId, attach.projectId)
        assert.equal(snap[0].projectRoot, '/proj/client-a')
      } finally {
        await attach.stop()
      }
    })
  })

  test('forwards tool_start/tool_end as feed_ events stamped with projectId', async () => {
    await withServer(async ({ port }) => {
      const attach = await startAttach({ port, projectRoot: '/proj/client-b', connections: [] })
      try {
        const seen = []
        const onFeedStart = (data) => seen.push(data)
        emitter.on('feed_tool_start', onFeedStart)
        try {
          emitter.emit('tool_start', { id: '1', tool: 'run_query', projectRoot: '/proj/client-b' })
          await waitUntil(() => seen.length > 0)
          assert.equal(seen[0].projectId, attach.projectId)
        } finally {
          emitter.off('feed_tool_start', onFeedStart)
        }
      } finally {
        await attach.stop()
      }
    })
  })

  test('stop({deregister:true}) removes the project from the registry', async () => {
    await withServer(async ({ registry, port }) => {
      const attach = await startAttach({ port, projectRoot: '/proj/client-c', connections: [] })
      assert.equal(registry.projects.has(attach.projectId), true)
      await attach.stop({ deregister: true })
      assert.equal(registry.projects.has(attach.projectId), false)
    })
  })

  test('re-registers after the host loses track of the project (heartbeat)', async () => {
    await withServer(async ({ registry, port }) => {
      const attach = await startAttach({ port, projectRoot: '/proj/client-d', connections: [], heartbeatMs: 30 })
      try {
        const originalId = attach.projectId
        registry.remove(originalId)
        assert.equal(registry.projects.has(originalId), false)

        await waitUntil(() => registry.projects.has(attach.projectId), { timeout: 2000 })
        assert.equal(registry.projects.has(attach.projectId), true)
      } finally {
        await attach.stop()
      }
    })
  })

  test('re-registers with the host when the shared connections array changes', async () => {
    await withServer(async ({ registry, port }) => {
      const connections = [{ name: 'A', type: 'mysql', host: 'h', database: 'a', username: 'u', password: 'p' }]
      const attach = await startAttach({ port, projectRoot: '/proj/client-g', connections })
      try {
        assert.equal(registry.projects.get(attach.projectId).connections.length, 1)

        connections.push({ name: 'B', type: 'mysql', host: 'h', database: 'b', username: 'u', password: 'p' })
        emitter.emit('connections_changed')

        await waitUntil(() => registry.projects.get(attach.projectId).connections.length === 2)
      } finally {
        await attach.stop()
      }
    })
  })

  test('calls onHostGone once when the host becomes unreachable', async () => {
    const registry = new ProjectRegistry()
    const server = await startGuiServer(registry, 0)
    const port = server.address().port

    const attach = await startAttach({ port, projectRoot: '/proj/client-e', connections: [], heartbeatMs: 30 })
    let goneCount = 0
    // Recreate attach with onHostGone wired: startAttach already ran register,
    // so instead close the server and rely on the heartbeat interval to detect it.
    // We can't rewire onHostGone post-hoc, so stop this one and start a fresh one.
    await attach.stop({ deregister: false })
    registry.stopGc()
    await new Promise(resolve => server.close(resolve))

    const registry2 = new ProjectRegistry()
    const server2 = await startGuiServer(registry2, 0)
    const port2 = server2.address().port
    const attach2 = await startAttach({
      port: port2,
      projectRoot: '/proj/client-f',
      connections: [],
      heartbeatMs: 30,
      onHostGone: () => { goneCount++ }
    })
    registry2.stopGc()
    await new Promise(resolve => server2.close(resolve))

    await waitUntil(() => goneCount === 1, { timeout: 2000 })
    await waitFor(100)
    assert.equal(goneCount, 1)
    await attach2.stop({ deregister: false }).catch(() => {})
  })
})

describe('probeHost', () => {
  test('returns null for a dead port', async () => {
    const info = await probeHost(1)
    assert.equal(info, null)
  })

  test('returns the info payload for a live sqlmate host', async () => {
    await withServer(async ({ port }) => {
      const info = await probeHost(port)
      assert.ok(info)
      assert.equal(info.app, 'sqlmate-mcp')
    })
  })
})
