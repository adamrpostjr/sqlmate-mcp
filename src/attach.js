import emitter from './events.js'
import { APP, PROTOCOL_VERSION, HEARTBEAT_MS } from './protocol.js'

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, body: data }
}

// GET /api/info with a short timeout. Never throws — a dead/foreign port
// just resolves to null so callers can fall back without try/catch noise.
export async function probeHost(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    const body = await res.json()
    if (body?.app !== APP) return null
    return body
  } catch {
    return null
  }
}

// Client-side uplink: registers this process's project with a remote host
// GUI, keeps it alive with heartbeats, and forwards local tool events so the
// shared GUI can show a live feed across all attached projects.
export async function startAttach({ port, projectRoot, connections, onHostGone, heartbeatMs = HEARTBEAT_MS }) {
  const base = `http://127.0.0.1:${port}`

  async function register() {
    const { status, body } = await postJson(`${base}/api/host/register`, {
      protocolVersion: PROTOCOL_VERSION,
      projectRoot,
      connections
    })
    if (status !== 200 || !body?.ok) {
      throw new Error(`failed to register with host: ${body?.error || status}`)
    }
    return body.projectId
  }

  let projectId = await register()

  // The host only sees connections added/changed after startup if we push a
  // fresh register() call whenever mcp.js reports the shared array changed.
  const onConnectionsChanged = () => { register().then(id => { projectId = id }).catch(() => {}) }
  emitter.on('connections_changed', onConnectionsChanged)

  let goneNotified = false
  function notifyGone() {
    if (goneNotified) return
    goneNotified = true
    clearInterval(heartbeatTimer)
    emitter.off('tool_start', onToolStart)
    emitter.off('tool_end', onToolEnd)
    emitter.off('connections_changed', onConnectionsChanged)
    if (typeof onHostGone === 'function') onHostGone()
  }

  const heartbeatTimer = setInterval(async () => {
    try {
      const { status, body } = await postJson(`${base}/api/host/heartbeat`, { projectId })
      if (status === 404 || body?.unknownProject) {
        projectId = await register()
      }
    } catch {
      notifyGone()
    }
  }, heartbeatMs)
  heartbeatTimer.unref()

  const onToolStart = (data) => {
    fetch(`${base}/api/host/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tool_start', data })
    }).catch(() => {})
  }
  const onToolEnd = (data) => {
    fetch(`${base}/api/host/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tool_end', data })
    }).catch(() => {})
  }
  emitter.on('tool_start', onToolStart)
  emitter.on('tool_end', onToolEnd)

  return {
    get projectId() { return projectId },
    async stop({ deregister = true } = {}) {
      clearInterval(heartbeatTimer)
      emitter.off('tool_start', onToolStart)
      emitter.off('tool_end', onToolEnd)
      emitter.off('connections_changed', onConnectionsChanged)
      if (deregister) {
        try {
          await fetch(`${base}/api/host/projects/${projectId}`, { method: 'DELETE' })
        } catch {}
      }
    }
  }
}
