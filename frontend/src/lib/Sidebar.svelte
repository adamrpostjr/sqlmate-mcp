<script>
  import { ChevronRightIcon, ChevronDownIcon, RefreshCwIcon, TableIcon, TerminalIcon } from '@lucide/svelte'
  import { store } from './store.svelte.js'
  import { loadTables, openTable, openSqlTab } from './api.js'
  import { api, connectionPath } from './api.js'

  const typeColors = {
    mysql: 'text-amber-400',
    mariadb: 'text-amber-400',
    sqlite: 'text-sky-400',
    mssql: 'text-red-400'
  }

  async function toggleConn(connId) {
    if (store.expandedConns[connId]) {
      store.expandedConns[connId] = false
      return
    }
    store.expandedConns[connId] = true
    store.loading[`tables:${connId}`] = true
    try {
      await loadTables(connId)
    } catch (err) {
      store.addToast(`Failed to load tables: ${err.message}`)
      store.expandedConns[connId] = false
    } finally {
      delete store.loading[`tables:${connId}`]
    }
  }

  async function reconnect(connId, e) {
    e.stopPropagation()
    store.loading[`reconnect:${connId}`] = true
    try {
      await api('POST', connectionPath(connId, '/reconnect'))
      delete store.connTables[connId]
      store.expandedConns[connId] = false
      store.addToast(`Reconnected: ${connId}`, 'success')
    } catch (err) {
      store.addToast(`Reconnect failed: ${err.message}`)
    } finally {
      delete store.loading[`reconnect:${connId}`]
    }
  }

  function isTableActive(connId, table) {
    return store.activeTabId === store.tabId(connId, table)
  }
</script>

<div class="py-2">
  {#if store.connections.length === 0}
    <div class="px-4 py-6 text-center text-xs text-surface-500">
      <p>No connections found.</p>
      <p class="mt-1 opacity-60">Add <code>.env</code> or <code>.sqlmaterc</code></p>
    </div>
  {:else}
    {#each store.connections as conn (conn.id)}
      {@const expanded = !!store.expandedConns[conn.id]}
      {@const tables = store.connTables[conn.id] || []}
      {@const loadingTables = !!store.loading[`tables:${conn.id}`]}
      {@const reconnecting = !!store.loading[`reconnect:${conn.id}`]}

      <div class="select-none">
        <!-- Connection header -->
        <div
          class="flex items-center gap-1.5 px-3 py-2 text-sm hover:bg-surface-200-800 transition-colors group cursor-pointer"
          onclick={() => toggleConn(conn.id)}
          role="button"
          tabindex="0"
          onkeydown={(e) => e.key === 'Enter' && toggleConn(conn.id)}
        >
          <span class="text-surface-400 flex-shrink-0 w-3">
            {#if loadingTables}
              <RefreshCwIcon class="size-3 animate-spin" />
            {:else if expanded}
              <ChevronDownIcon class="size-3" />
            {:else}
              <ChevronRightIcon class="size-3" />
            {/if}
          </span>
          <span class="flex-1 text-left truncate text-xs font-medium">{conn.name}</span>
          <span class="text-[10px] font-mono px-1 py-0.5 rounded border {typeColors[conn.type] || 'text-surface-400'} border-current opacity-70 flex-shrink-0">
            {conn.type}
          </span>
          <button
            class="opacity-0 group-hover:opacity-100 text-surface-400 hover:text-primary-400 transition-all p-0.5 rounded"
            onclick={(e) => reconnect(conn.id, e)}
            title="Reconnect"
          >
            <RefreshCwIcon class="size-3 {reconnecting ? 'animate-spin' : ''}" />
          </button>
        </div>

        <!-- Source tag -->
        {#if expanded}
          <div class="px-8 pb-1">
            <span class="text-[10px] text-surface-500 font-mono">{conn.source}</span>
          </div>
        {/if}

        <!-- Table list -->
        {#if expanded}
          <div class="pb-1">
            {#if tables.length === 0 && !loadingTables}
              <div class="px-8 py-1 text-xs text-surface-500 italic">No tables found</div>
            {/if}
            {#each tables as table (table)}
              {@const active = isTableActive(conn.id, table)}
              <div class="flex items-center group/row">
                <button
                  class="flex-1 flex items-center gap-2 px-8 py-1.5 text-xs transition-colors text-left
                         {active ? 'text-primary-400 bg-primary-500/10' : 'text-surface-600-400 hover:bg-surface-200-800 hover:text-surface-950-50'}"
                  onclick={() => openTable(conn.id, table)}
                >
                  <TableIcon class="size-3 flex-shrink-0 opacity-60" />
                  <span class="truncate font-mono">{table}</span>
                </button>
                <button
                  class="opacity-0 group-hover/row:opacity-100 mr-2 p-1 text-surface-400 hover:text-warning-400 transition-all rounded"
                  onclick={() => openSqlTab(conn.id)}
                  title="Open SQL editor"
                >
                  <TerminalIcon class="size-3" />
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>
