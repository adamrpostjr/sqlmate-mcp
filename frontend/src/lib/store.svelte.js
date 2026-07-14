class AppStore {
  // Project / connection data
  selfProjectId = $state(null)
  projects = $state([])        // [{ projectId, projectRoot, connections: [...] }]

  // Sidebar
  expandedConns = $state({})   // `${projectId}::${connId}` → boolean
  connTables = $state({})      // `${projectId}::${connId}` → string[]

  // Tabs
  openTabs = $state([])        // [{ id, projectId, connId, table, view: 'data'|'schema'|'sql'|'erd', name? }]
  activeTabId = $state(null)

  // Per-tab data
  currentPage = $state({})     // tabId → 0-indexed page
  tableData = $state({})       // tabId → { rows, total, columns }
  schemaCache = $state({})     // `${projectId}::${connId}:${table}` → columns[]
  schemaGraph = $state({})     // `${projectId}::${connId}` → { tables: [...] }
  sqlContent = $state({})      // tabId → sql string
  sqlResults = $state({})      // tabId → { rows, columns, error? }
  loading = $state({})         // key → boolean

  // Agent feed
  agentEvents = $state([])     // live MCP tool call events (newest first)
  agentFeedOpen = $state(true)

  // JSON pane
  jsonPane = $state(null)      // { data, title } | null

  // Global error toasts
  toasts = $state([])          // [{ id, message, type }]

  get activeTab() {
    return this.openTabs.find(t => t.id === this.activeTabId) || null
  }

  // Composite key for anything keyed by (projectId, connId) — connId is only
  // unique WITHIN a project, so every cross-project cache must use this.
  ck(projectId, connId) {
    return `${projectId}::${connId}`
  }

  tabId(projectId, connId, table) {
    return `${projectId}__${connId}__${table}`
  }

  sqlTabId(projectId, connId) {
    return `sql__${projectId}__${connId}`
  }

  isSqlTab(tab) {
    return tab?.view === 'sql'
  }

  erdTabId(projectId, connId) {
    return `erd__${projectId}__${connId}`
  }

  isErdTab(tab) {
    return tab?.view === 'erd'
  }

  getSchema(projectId, connId, table) {
    return this.schemaCache[`${this.ck(projectId, connId)}:${table}`] || []
  }

  getPkColumn(projectId, connId, table) {
    const schema = this.getSchema(projectId, connId, table)
    return schema.find(c => c.pk)?.column || schema[0]?.column || null
  }

  getProject(projectId) {
    return this.projects.find(p => p.projectId === projectId) || null
  }

  getConnection(projectId, connId) {
    return this.getProject(projectId)?.connections?.find(c => c.id === connId) || null
  }

  projectName(projectId) {
    const project = this.getProject(projectId)
    const root = project?.projectRoot
    if (!root) return projectId
    const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
    return parts[parts.length - 1] || projectId
  }

  addToast(message, type = 'error') {
    const id = Date.now() + Math.random()
    this.toasts.push({ id, message, type })
    setTimeout(() => {
      const idx = this.toasts.findIndex(t => t.id === id)
      if (idx !== -1) this.toasts.splice(idx, 1)
    }, 5000)
  }

  dismissToast(id) {
    const idx = this.toasts.findIndex(t => t.id === id)
    if (idx !== -1) this.toasts.splice(idx, 1)
  }

  // Remove all state tied to a connection that no longer exists.
  pruneConnection(projectId, connId) {
    const key = this.ck(projectId, connId)
    delete this.connTables[key]
    delete this.expandedConns[key]
    delete this.schemaGraph[key]
    const schemaPrefix = `${key}:`
    for (const cacheKey of Object.keys(this.schemaCache)) {
      if (cacheKey.startsWith(schemaPrefix)) delete this.schemaCache[cacheKey]
    }
    // Close any tabs belonging to this (projectId, connId) and drop their per-tab state.
    const removedTabIds = this.openTabs
      .filter(t => t.projectId === projectId && t.connId === connId)
      .map(t => t.id)
    if (removedTabIds.length) {
      this.openTabs = this.openTabs.filter(t => !(t.projectId === projectId && t.connId === connId))
      for (const tabId of removedTabIds) {
        delete this.currentPage[tabId]
        delete this.tableData[tabId]
        delete this.sqlContent[tabId]
        delete this.sqlResults[tabId]
        delete this.loading[tabId]
        if (this.activeTabId === tabId) {
          this.activeTabId = this.openTabs[0]?.id || null
        }
      }
    }
  }

  applyAgentEvent(type, data) {
    if (type === 'projects_changed') {
      // `data` is the full snapshot of ALL projects. Reconcile: prune any
      // (projectId, connId) pair that existed before but is gone now —
      // this also covers whole projects vanishing, since all their
      // connections disappear at once.
      const stillPresent = new Set()
      for (const p of data) {
        for (const c of p.connections ?? []) {
          stillPresent.add(this.ck(p.projectId, c.id))
        }
      }
      for (const p of this.projects) {
        for (const c of p.connections ?? []) {
          const key = this.ck(p.projectId, c.id)
          if (!stillPresent.has(key)) this.pruneConnection(p.projectId, c.id)
        }
      }
      this.projects = data
      return
    }
    if (type === 'tool_start') {
      this.agentEvents.unshift({ ...data, status: 'pending' })
      if (this.agentEvents.length > 100) this.agentEvents.length = 100
    } else if (type === 'tool_end') {
      const ev = this.agentEvents.find(e => e.id === data.id)
      if (ev) {
        ev.status = data.requiresConfirmation ? 'awaiting_confirm'
          : data.error ? 'error'
          : 'success'
        ev.duration = data.duration
        ev.rowCount = data.rowCount
        ev.error = data.error
        ev.requiresConfirmation = data.requiresConfirmation ?? false
      }
    }
  }

  clearAgentEvents() {
    this.agentEvents = []
  }
}

export const store = new AppStore()
