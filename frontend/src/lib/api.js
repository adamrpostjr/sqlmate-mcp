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

export function connectionPath(projectId, connId, suffix = '') {
  return `/api/projects/${projectId}/connections/${connId}${suffix}`
}

export async function loadInfo() {
  const info = await api('GET', '/api/info')
  store.selfProjectId = info.selfProjectId
  store.projects = info.projects ?? []
}

export async function loadTables(projectId, connId) {
  const key = store.ck(projectId, connId)
  if (store.connTables[key]) return store.connTables[key]
  const tables = await api('GET', connectionPath(projectId, connId, '/tables'))
  store.connTables[key] = tables
  return tables
}

export async function loadSchema(projectId, connId, table) {
  const key = `${store.ck(projectId, connId)}:${table}`
  if (store.schemaCache[key]) return store.schemaCache[key]
  const schema = await api('GET', connectionPath(projectId, connId, `/tables/${encodeURIComponent(table)}/schema`))
  store.schemaCache[key] = schema
  return schema
}

export async function runExplain(projectId, connId, tabId, sql, analyze = false) {
  store.loading[`explain:${tabId}`] = true
  try {
    const res = await api('POST', connectionPath(projectId, connId, '/explain'), { sql, analyze })
    store.sqlResults[tabId] = {
      ...store.sqlResults[tabId],
      plan: res.plan,
      planFormat: res.format,
      error: res.error
    }
  } catch (err) {
    store.sqlResults[tabId] = { ...store.sqlResults[tabId], plan: null, planFormat: null, error: err.message }
  } finally {
    delete store.loading[`explain:${tabId}`]
  }
}

export async function loadTableData(tabId) {
  const tab = store.openTabs.find(t => t.id === tabId)
  if (!tab || tab.view === 'sql') return
  const page = store.currentPage[tabId] || 0
  const offset = page * 100
  store.loading[tabId] = true
  try {
    const data = await api('GET',
      connectionPath(tab.projectId, tab.connId, `/tables/${encodeURIComponent(tab.table)}/data?limit=100&offset=${offset}`)
    )
    store.tableData[tabId] = data
  } catch (err) {
    store.addToast(`Failed to load ${tab.table}: ${err.message}`)
  } finally {
    delete store.loading[tabId]
  }
}

export async function openTable(projectId, connId, table) {
  const id = store.tabId(projectId, connId, table)
  if (!store.openTabs.find(t => t.id === id)) {
    store.openTabs.push({ id, projectId, connId, table, view: 'data' })
  }
  store.activeTabId = id
  await loadSchema(projectId, connId, table)
  await loadTableData(id)
}

export async function openSqlTab(projectId, connId) {
  const id = store.sqlTabId(projectId, connId)
  if (!store.openTabs.find(t => t.id === id)) {
    const conn = store.getConnection(projectId, connId)
    store.openTabs.push({ id, projectId, connId, table: null, view: 'sql', name: conn?.name || connId })
  }
  store.activeTabId = id
}

export async function loadSchemaGraph(projectId, connId) {
  const key = store.ck(projectId, connId)
  if (store.schemaGraph[key]) return store.schemaGraph[key]
  store.loading[`erd:${key}`] = true
  try {
    const data = await api('GET', connectionPath(projectId, connId, '/schema-graph'))
    store.schemaGraph[key] = data
    return data
  } catch (err) {
    store.addToast(`Failed to load schema graph: ${err.message}`)
    return null
  } finally {
    delete store.loading[`erd:${key}`]
  }
}

export async function openErdTab(projectId, connId) {
  const id = store.erdTabId(projectId, connId)
  if (!store.openTabs.find(t => t.id === id)) {
    const conn = store.getConnection(projectId, connId)
    store.openTabs.push({ id, projectId, connId, table: null, view: 'erd', name: 'ERD — ' + (conn?.name ?? connId) })
  }
  store.activeTabId = id
  await loadSchemaGraph(projectId, connId)
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
