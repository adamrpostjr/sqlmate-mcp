import emitter from './events.js'
import { invalidateDriver } from './drivers.js'
import { connIdentity, CONFIG_FIELDS, assignId } from './connections.js'
import { projectId as computeProjectId, PROJECT_TTL_MS, GC_INTERVAL_MS } from './protocol.js'

function sameConfig(a, b) {
  return CONFIG_FIELDS.every(f => a[f] === b[f])
}

// Host-side source of truth for which projects (this process's own project,
// plus any attached client projects) are currently live, and what connections
// each one exposes. Connections here always carry full credentials — callers
// that expose data externally (the GUI) must use snapshot() instead.
export class ProjectRegistry {
  constructor({ ttlMs = PROJECT_TTL_MS, gcIntervalMs = GC_INTERVAL_MS } = {}) {
    this.projects = new Map()
    this.ttlMs = ttlMs
    this.gcIntervalMs = gcIntervalMs
    this._gcTimer = null
  }

  // Idempotent upsert. First call for a projectRoot creates the project;
  // subsequent calls reconcile the incoming connection list against the
  // stored one (same diffing rules as connections.js mergeProjectConnections):
  // unchanged connections keep their id/driver, changed ones are updated in
  // place and have their cached driver invalidated, removed ones are dropped
  // (and invalidated), new ones are appended with a collision-safe id.
  register({ projectRoot, connections = [], self = false }) {
    const id = computeProjectId(projectRoot)
    const existing = this.projects.get(id)

    // Callers (mcp.js) may pass their whole shared connections array, which can
    // include entries for OTHER project roots (the shared multi-project server
    // feature) or global (projectRoot: null) ones. Only this project's own and
    // global connections belong here — anything else must never merge in.
    const scoped = connections.filter(c => c.projectRoot == null || c.projectRoot === projectRoot)
    // Preserve each connection's own projectRoot (null stays global); only
    // default to the registering project when the caller didn't set one at all.
    const stamp = (conn) => ({ ...conn, projectRoot: conn.projectRoot === undefined ? projectRoot : conn.projectRoot })

    if (!existing) {
      const stored = []
      for (const conn of scoped) {
        const copy = stamp(conn)
        assignId(copy, stored)
        stored.push(copy)
      }
      this.projects.set(id, {
        projectId: id,
        projectRoot,
        connections: stored,
        lastSeen: Date.now(),
        self
      })
      emitter.emit('projects_changed', this.snapshot())
      return { projectId: id }
    }

    let changed = false
    const freshIdentities = new Set(scoped.map(connIdentity))

    // 1. Drop stored connections no longer present in the incoming list.
    for (const stored of existing.connections.slice()) {
      if (!freshIdentities.has(connIdentity(stored))) {
        existing.connections.splice(existing.connections.indexOf(stored), 1)
        invalidateDriver(stored)
        changed = true
      }
    }

    // 2. Upsert incoming connections.
    for (const conn of scoped) {
      const match = existing.connections.find(c => connIdentity(c) === connIdentity(conn))
      if (match) {
        if (!sameConfig(match, conn)) {
          for (const f of CONFIG_FIELDS) match[f] = conn[f]
          match.name = conn.name
          invalidateDriver(match)
          changed = true
        }
      } else {
        const copy = stamp(conn)
        assignId(copy, existing.connections)
        existing.connections.push(copy)
        changed = true
      }
    }

    existing.lastSeen = Date.now()
    existing.self = existing.self || self

    if (changed) emitter.emit('projects_changed', this.snapshot())

    return { projectId: id }
  }

  heartbeat(projectId) {
    const p = this.projects.get(projectId)
    if (!p) return false
    p.lastSeen = Date.now()
    return true
  }

  remove(projectId) {
    const p = this.projects.get(projectId)
    // The self project has no heartbeat to resurrect it if removed — never
    // allow it to be dismissed out from under the running process.
    if (!p || p.self) return
    for (const conn of p.connections) invalidateDriver(conn)
    this.projects.delete(projectId)
    emitter.emit('projects_changed', this.snapshot())
  }

  getSelfProjectId() {
    for (const [id, p] of this.projects) if (p.self) return id
    return null
  }

  // Re-tag a raw MCP tool_start/tool_end event with the project it belongs to
  // (derived from the projectRoot the caller stamped it with) and re-emit it
  // under a distinct name so a host doesn't double-see its own local events.
  handleToolEvent(type, data) {
    const projectRoot = data?.projectRoot
    const projectId = projectRoot ? computeProjectId(projectRoot) : undefined
    emitter.emit(`feed_${type}`, { ...data, projectId, projectRoot })
  }

  // Public view of the registry: no credentials, ever.
  snapshot() {
    return [...this.projects.values()].map(p => ({
      projectId: p.projectId,
      projectRoot: p.projectRoot,
      connections: p.connections.map(c => ({ id: c.id, name: c.name, type: c.type, source: c.source }))
    }))
  }

  startGc() {
    if (this._gcTimer) return
    this._gcTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, p] of this.projects) {
        // The self project is alive as long as this process — nothing
        // heartbeats it, so it must never expire.
        if (!p.self && now - p.lastSeen > this.ttlMs) this.remove(id)
      }
    }, this.gcIntervalMs)
    this._gcTimer.unref()
  }

  stopGc() {
    if (this._gcTimer) {
      clearInterval(this._gcTimer)
      this._gcTimer = null
    }
  }

  findConnection(projectId, connId) {
    const p = this.projects.get(projectId)
    if (!p) throw new Error('Connection not found')
    const conn = p.connections.find(c => c.id === connId)
    if (!conn) throw new Error('Connection not found')
    return conn
  }
}
