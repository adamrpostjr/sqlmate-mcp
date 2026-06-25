import { store } from './store.svelte.js'

export async function api(method, path, body) {
  const opts = { method, headers: {} }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(path, opts)
  const data = await res.json()
  if (!res.ok && !data.error) throw new Error(`HTTP ${res.status}`)
  return data
}

export async function loadConnections() {
  const conns = await api('GET', '/api/connections')
  store.connections = conns
  return conns
}

export async function loadTables(connId) {
  if (store.connTables[connId]) return store.connTables[connId]
  const tables = await api('GET', `/api/connections/${connId}/tables`)
  store.connTables[connId] = tables
  return tables
}

export async function loadSchema(connId, table) {
  const key = `${connId}:${table}`
  if (store.schemaCache[key]) return store.schemaCache[key]
  const schema = await api('GET', `/api/connections/${connId}/tables/${encodeURIComponent(table)}/schema`)
  store.schemaCache[key] = schema
  return schema
}

export async function loadTableData(tabId) {
  const tab = store.openTabs.find(t => t.id === tabId)
  if (!tab || tab.view === 'sql') return
  const page = store.currentPage[tabId] || 0
  const offset = page * 100
  store.loading[tabId] = true
  try {
    const data = await api('GET',
      `/api/connections/${tab.connId}/tables/${encodeURIComponent(tab.table)}/data?limit=100&offset=${offset}`
    )
    store.tableData[tabId] = data
  } catch (err) {
    store.addToast(`Failed to load ${tab.table}: ${err.message}`)
  } finally {
    delete store.loading[tabId]
  }
}

export async function openTable(connId, table) {
  const id = store.tabId(connId, table)
  if (!store.openTabs.find(t => t.id === id)) {
    store.openTabs.push({ id, connId, table, view: 'data' })
  }
  store.activeTabId = id
  await loadSchema(connId, table)
  await loadTableData(id)
}

export async function openSqlTab(connId) {
  const id = store.sqlTabId(connId)
  if (!store.openTabs.find(t => t.id === id)) {
    const conn = store.connections.find(c => c.id === connId)
    store.openTabs.push({ id, connId, table: null, view: 'sql', name: conn?.name || connId })
  }
  store.activeTabId = id
}

export function closeTab(id) {
  const idx = store.openTabs.findIndex(t => t.id === id)
  if (idx === -1) return
  store.openTabs.splice(idx, 1)
  if (store.activeTabId === id) {
    store.activeTabId = store.openTabs[Math.min(idx, store.openTabs.length - 1)]?.id || null
  }
}

export function activateTab(id) {
  store.activeTabId = id
  const tab = store.openTabs.find(t => t.id === id)
  if (tab && !store.isSqlTab(tab) && !store.tableData[id]) {
    loadTableData(id)
  }
}
