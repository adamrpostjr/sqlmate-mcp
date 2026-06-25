<script>
  import { onMount } from 'svelte'
  import { ChevronLeftIcon, ChevronRightIcon, Trash2Icon, Loader2Icon, TableIcon, CodeIcon } from '@lucide/svelte'
  import { store } from './store.svelte.js'
  import { api, loadTableData, openSqlTab } from './api.js'

  let { connId, table } = $props()

  const LIMIT = 100

  // Local state
  let editingCell = $state(null)   // { rowIndex, column, pk, pkValue, value }

  // Derived
  const tabId = $derived(store.tabId(connId, table))
  const data = $derived(store.tableData[tabId])
  const schema = $derived(store.getSchema(connId, table))
  const pk = $derived(store.getPkColumn(connId, table))
  const page = $derived(store.currentPage[tabId] || 0)
  const loading = $derived(!!store.loading[tabId])
  const totalPages = $derived(data ? Math.max(1, Math.ceil(data.total / LIMIT)) : 1)
  const currentTab = $derived(store.openTabs.find(t => t.id === tabId))

  onMount(() => {
    if (!data) loadTableData(tabId)
  })

  function setView(view) {
    if (currentTab) currentTab.view = view
  }

  async function changePage(newPage) {
    if (newPage < 0 || newPage >= totalPages) return
    store.currentPage[tabId] = newPage
    editingCell = null
    await loadTableData(tabId)
  }

  function startEdit(rowIndex, column, pkValue, value) {
    editingCell = { rowIndex, column, pk, pkValue, value: String(value ?? '') }
  }

  async function commitEdit() {
    if (!editingCell) return
    const { rowIndex, column, pkValue, value } = editingCell
    const original = data?.rows?.[rowIndex]?.[column]
    editingCell = null
    if (value === String(original ?? '')) return
    try {
      await api('PATCH', `/api/connections/${connId}/tables/${encodeURIComponent(table)}/rows`, {
        pk, pkValue, column, value
      })
      await loadTableData(tabId)
    } catch (err) {
      store.addToast(`Update failed: ${err.message}`)
      await loadTableData(tabId)
    }
  }

  function cancelEdit() { editingCell = null }

  function editKeydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
    if (e.key === 'Escape') cancelEdit()
  }

  async function deleteRow(pkValue) {
    if (!confirm(`Delete row where ${pk} = ${pkValue}?`)) return
    try {
      await api('DELETE', `/api/connections/${connId}/tables/${encodeURIComponent(table)}/rows`, { pk, pkValue })
      await loadTableData(tabId)
    } catch (err) {
      store.addToast(`Delete failed: ${err.message}`)
    }
  }

  function tryJson(v) {
    if (typeof v !== 'string') return null
    const t = v.trim()
    if (!t.startsWith('{') && !t.startsWith('[')) return null
    try { return JSON.parse(t) } catch { return null }
  }

  function openJson(col, v) {
    store.jsonPane = { title: col, data: tryJson(v) }
  }

  function cellClick(rowIndex, col, pkValue, value) {
    const json = tryJson(value)
    if (json !== null) { openJson(col, value); return }
    startEdit(rowIndex, col, pkValue, value)
  }

  // Focus input when edit starts
  $effect(() => {
    if (editingCell) {
      requestAnimationFrame(() => {
        const input = document.querySelector('.cell-editing input')
        if (input) { input.focus(); input.select() }
      })
    }
  })
</script>

<div class="flex flex-col h-full">
  <!-- Toolbar -->
  <div class="flex items-center gap-2 px-4 py-2 border-b border-surface-200-800 flex-shrink-0 bg-surface-100-900">
    <TableIcon class="size-4 text-primary-400 flex-shrink-0" />
    <span class="font-mono text-sm text-primary-400">{table}</span>
    {#if schema.length > 0}
      <span class="text-xs text-surface-500">{schema.length} cols</span>
    {/if}
    <div class="flex-1"></div>
    <button
      class="btn btn-sm preset-tonal gap-1 text-xs"
      onclick={() => setView('data')}
      class:preset-filled-primary-500={currentTab?.view === 'data'}
    >
      Data
    </button>
    <button
      class="btn btn-sm preset-tonal gap-1 text-xs"
      onclick={() => setView('schema')}
    >
      Schema
    </button>
    <button
      class="btn btn-sm preset-tonal gap-1 text-xs"
      onclick={() => openSqlTab(connId)}
    >
      <CodeIcon class="size-3" /> SQL
    </button>
  </div>

  <!-- Grid -->
  <div class="flex-1 overflow-auto">
    {#if loading && !data}
      <div class="flex items-center justify-center h-32 gap-2 text-surface-500">
        <Loader2Icon class="size-5 animate-spin" />
        <span class="text-sm">Loading rows...</span>
      </div>
    {:else if data}
      {@const columns = data.columns || (data.rows[0] ? Object.keys(data.rows[0]) : [])}
      <table class="w-full text-xs border-collapse">
        <thead>
          <tr class="sticky top-0 z-10 bg-surface-100-900">
            {#each columns as col}
              {@const colMeta = schema.find(c => c.column === col)}
              <th
                class="px-3 py-2 text-left font-normal border-b border-surface-200-800 whitespace-nowrap {colMeta?.pk ? 'text-primary-400' : 'text-surface-500'}"
                title={colMeta ? `${colMeta.type}${colMeta.nullable ? '' : ' NOT NULL'}` : ''}
              >
                {col}{colMeta?.pk ? ' 🔑' : ''}
              </th>
            {/each}
            <th class="w-8 border-b border-surface-200-800"></th>
          </tr>
        </thead>
        <tbody>
          {#if data.rows.length === 0}
            <tr>
              <td colspan={columns.length + 1} class="text-center py-8 text-surface-500 italic">No rows</td>
            </tr>
          {/if}
          {#each data.rows as row, ri}
            {@const pkVal = pk ? row[pk] : ri}
            <tr class="data-row border-b border-surface-100-900 hover:bg-surface-200-800/40 transition-colors">
              {#each columns as col}
                {@const val = row[col]}
                {@const isEditing = editingCell?.rowIndex === ri && editingCell?.column === col}
                {@const isJson = !isEditing && tryJson(val) !== null}

                {#if isEditing}
                  <td class="cell-editing px-0 py-0">
                    <input
                      value={editingCell.value}
                      oninput={(e) => editingCell.value = e.target.value}
                      onblur={commitEdit}
                      onkeydown={editKeydown}
                    />
                  </td>
                {:else}
                  <td
                    class="px-3 py-1.5 max-w-xs overflow-hidden text-ellipsis whitespace-nowrap cursor-pointer
                           {val === null || val === undefined ? 'text-surface-500 italic' : ''}
                           {isJson ? 'text-sky-400 underline decoration-dotted' : ''}"
                    title={isJson ? 'JSON — click to expand' : (val !== null && val !== undefined ? String(val) : 'NULL')}
                    onclick={() => cellClick(ri, col, pkVal, val)}
                  >
                    {#if val === null || val === undefined}
                      NULL
                    {:else if isJson}
                      &#123;…&#125;
                    {:else}
                      {String(val).length > 80 ? String(val).slice(0, 80) + '…' : String(val)}
                    {/if}
                  </td>
                {/if}
              {/each}
              <td class="px-1 py-1 text-center">
                <button
                  class="p-1 text-surface-600 hover:text-error-400 transition-colors rounded"
                  onclick={() => deleteRow(pkVal)}
                  title="Delete row"
                >
                  <Trash2Icon class="size-3" />
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if loading}
        <div class="flex items-center justify-center py-2 gap-1 text-surface-500 text-xs">
          <Loader2Icon class="size-3 animate-spin" /> Loading...
        </div>
      {/if}
    {:else}
      <div class="flex items-center justify-center h-32 text-surface-500 text-sm">Select a table to view data</div>
    {/if}
  </div>

  <!-- Pagination -->
  {#if data && data.total > 0}
    <div class="flex items-center gap-3 px-4 py-2 border-t border-surface-200-800 bg-surface-100-900 flex-shrink-0">
      <button class="btn btn-sm preset-tonal" onclick={() => changePage(page - 1)} disabled={page === 0}>
        <ChevronLeftIcon class="size-4" />
      </button>
      <span class="text-xs text-surface-500 flex-1 text-center">
        Page {page + 1} / {totalPages} · {data.total.toLocaleString()} rows
      </span>
      <button class="btn btn-sm preset-tonal" onclick={() => changePage(page + 1)} disabled={page >= totalPages - 1}>
        <ChevronRightIcon class="size-4" />
      </button>
    </div>
  {/if}
</div>
