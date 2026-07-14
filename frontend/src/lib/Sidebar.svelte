<script>
  import { ChevronRightIcon, ChevronDownIcon, RefreshCwIcon, TableIcon, TerminalIcon, NetworkIcon, FolderIcon } from '@lucide/svelte'
  import { store } from './store.svelte.js'
  import { loadTables, openTable, openSqlTab, openErdTab } from './api.js'
  import { api, connectionPath } from './api.js'

  const typeColors = {
    mysql: 'text-amber-400',
    mariadb: 'text-amber-400',
    sqlite: 'text-sky-400',
    mssql: 'text-red-400'
  }

  // Project-group expansion (default open); only relevant when >1 project.
  let expandedProjects = $state({})

  function isProjectExpanded(projectId) {
    return expandedProjects[projectId] !== false
  }

  function toggleProject(projectId) {
    expandedProjects[projectId] = !isProjectExpanded(projectId)
  }

  async function toggleConn(projectId, connId) {
    const key = store.ck(projectId, connId)
    if (store.expandedConns[key]) {
      store.expandedConns[key] = false
      return
    }
    store.expandedConns[key] = true
    store.loading[`tables:${key}`] = true
    try {
      await loadTables(projectId, connId)
    } catch (err) {
      store.addToast(`Failed to load tables: ${err.message}`)
      store.expandedConns[key] = false
    } finally {
      delete store.loading[`tables:${key}`]
    }
  }

  async function reconnect(projectId, connId, e) {
    e.stopPropagation()
    const key = store.ck(projectId, connId)
    store.loading[`reconnect:${key}`] = true
    try {
      await api('POST', connectionPath(projectId, connId, '/reconnect'))
      delete store.connTables[key]
      store.expandedConns[key] = false
      store.addToast(`Reconnected: ${connId}`, 'success')
    } catch (err) {
      store.addToast(`Reconnect failed: ${err.message}`)
    } finally {
      delete store.loading[`reconnect:${key}`]
    }
  }

  function isTableActive(projectId, connId, table) {
    return store.activeTabId === store.tabId(projectId, connId, table)
  }

  function connSubtitle(conn) {
    if (conn.path) return conn.path
    if (conn.host) return `${conn.host}${conn.port ? ':' + conn.port : ''}${conn.database ? ' / ' + conn.database : ''}`
    return conn.database || ''
  }
</script>

{#snippet connectionList(projectId, connections)}
  {#each connections as conn (conn.id)}
    {@const key = store.ck(projectId, conn.id)}
    {@const expanded = !!store.expandedConns[key]}
    {@const tables = store.connTables[key] || []}
    {@const loadingTables = !!store.loading[`tables:${key}`]}
    {@const reconnecting = !!store.loading[`reconnect:${key}`]}

    <div class="select-none">
      <!-- Connection header -->
      <div
        class="flex items-start gap-1.5 px-3 py-2 text-sm hover:bg-surface-200-800 transition-colors group cursor-pointer"
        onclick={() => toggleConn(projectId, conn.id)}
        role="button"
        tabindex="0"
        onkeydown={(e) => e.key === 'Enter' && toggleConn(projectId, conn.id)}
      >
        <span class="text-surface-400 flex-shrink-0 w-3 mt-0.5">
          {#if loadingTables}
            <RefreshCwIcon class="size-3 animate-spin" />
          {:else if expanded}
            <ChevronDownIcon class="size-3" />
          {:else}
            <ChevronRightIcon class="size-3" />
          {/if}
        </span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="flex-1 text-left truncate text-xs font-medium">{conn.name}</span>
            <span class="text-[10px] font-mono px-1 py-0.5 rounded border {typeColors[conn.type] || 'text-surface-400'} border-current opacity-70 flex-shrink-0">
              {conn.type}
            </span>
          </div>
          {#if connSubtitle(conn)}
            <div class="text-[10px] text-surface-500 font-mono truncate mt-0.5" title={connSubtitle(conn)}>
              {connSubtitle(conn)}
            </div>
          {/if}
        </div>
        <button
          class="opacity-0 group-hover:opacity-100 text-surface-400 hover:text-primary-400 transition-all p-0.5 rounded flex-shrink-0"
          onclick={(e) => { e.stopPropagation(); openErdTab(projectId, conn.id) }}
          title="View ERD"
        >
          <NetworkIcon class="size-3" />
        </button>
        <button
          class="opacity-0 group-hover:opacity-100 text-surface-400 hover:text-primary-400 transition-all p-0.5 rounded flex-shrink-0"
          onclick={(e) => reconnect(projectId, conn.id, e)}
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
            {@const active = isTableActive(projectId, conn.id, table)}
            <div class="flex items-center group/row">
              <button
                class="flex-1 flex items-center gap-2 px-8 py-1.5 text-xs transition-colors text-left
                       {active ? 'text-primary-400 bg-primary-500/10' : 'text-surface-600-400 hover:bg-surface-200-800 hover:text-surface-950-50'}"
                onclick={() => openTable(projectId, conn.id, table)}
              >
                <TableIcon class="size-3 flex-shrink-0 opacity-60" />
                <span class="truncate font-mono">{table}</span>
              </button>
              <button
                class="opacity-0 group-hover/row:opacity-100 mr-2 p-1 text-surface-400 hover:text-warning-400 transition-all rounded"
                onclick={() => openSqlTab(projectId, conn.id)}
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
{/snippet}

<div class="py-2">
  {#if store.projects.length === 0 || store.projects.every(p => p.connections.length === 0)}
    <div class="px-4 py-6 text-center text-xs text-surface-500">
      <p>No connections found.</p>
      <p class="mt-1 opacity-60">Add <code>.env</code> or <code>.sqlmaterc</code></p>
    </div>
  {:else if store.projects.length === 1}
    {@render connectionList(store.projects[0].projectId, store.projects[0].connections)}
  {:else}
    {#each store.projects as project (project.projectId)}
      {@const projExpanded = isProjectExpanded(project.projectId)}
      <div class="mb-1">
        <div
          class="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-surface-500 hover:bg-surface-200-800/60 transition-colors cursor-pointer select-none"
          onclick={() => toggleProject(project.projectId)}
          role="button"
          tabindex="0"
          onkeydown={(e) => e.key === 'Enter' && toggleProject(project.projectId)}
        >
          {#if projExpanded}
            <ChevronDownIcon class="size-3 flex-shrink-0" />
          {:else}
            <ChevronRightIcon class="size-3 flex-shrink-0" />
          {/if}
          <FolderIcon class="size-3 flex-shrink-0" />
          <span class="flex-1 truncate">{store.projectName(project.projectId)}</span>
          {#if project.projectId === store.selfProjectId}
            <span class="text-[9px] font-mono px-1 py-0.5 rounded border border-current opacity-70 text-primary-400">current</span>
          {/if}
        </div>
        {#if projExpanded}
          {#if project.connections.length === 0}
            <div class="px-8 py-1 text-xs text-surface-500 italic">No connections</div>
          {:else}
            {@render connectionList(project.projectId, project.connections)}
          {/if}
        {/if}
      </div>
    {/each}
  {/if}
</div>
