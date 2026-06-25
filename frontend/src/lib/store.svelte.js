class AppStore {
  // Connection data
  connections = $state([])
  projectRoot = $state(null)

  // Sidebar
  expandedConns = $state({})   // connId → boolean
  connTables = $state({})      // connId → string[]

  // Tabs
  openTabs = $state([])        // [{ id, connId, table, view: 'data'|'schema'|'sql', name? }]
  activeTabId = $state(null)

  // Per-tab data
  currentPage = $state({})     // tabId → 0-indexed page
  tableData = $state({})       // tabId → { rows, total, columns }
  schemaCache = $state({})     // `connId:table` → columns[]
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

  tabId(connId, table) {
    return `${connId}__${table}`
  }

  sqlTabId(connId) {
    return `sql__${connId}`
  }

  isSqlTab(tab) {
    return tab?.view === 'sql'
  }

  getSchema(connId, table) {
    return this.schemaCache[`${connId}:${table}`] || []
  }

  getPkColumn(connId, table) {
    const schema = this.getSchema(connId, table)
    return schema.find(c => c.pk)?.column || schema[0]?.column || null
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

  applyAgentEvent(type, data) {
    if (type === 'connections_changed') {
      const newIds = new Set(data.map(c => c.id))
      for (const connId of Object.keys(this.connTables)) {
        if (!newIds.has(connId)) delete this.connTables[connId]
      }
      for (const key of Object.keys(this.schemaCache)) {
        if (!newIds.has(key.split(':')[0])) delete this.schemaCache[key]
      }
      this.connections = data
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
