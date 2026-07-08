<script>
  import { onMount, onDestroy } from 'svelte'
  import { AppBar } from '@skeletonlabs/skeleton-svelte'
  import { ActivityIcon, DatabaseIcon, XIcon, AlertCircleIcon, CheckCircleIcon, Loader2Icon, FolderIcon } from '@lucide/svelte'
  import { store } from './lib/store.svelte.js'
  import { loadConnections, loadInfo, closeTab, activateTab } from './lib/api.js'
  import Sidebar from './lib/Sidebar.svelte'
  import DataGrid from './lib/DataGrid.svelte'
  import SchemaView from './lib/SchemaView.svelte'
  import SqlEditor from './lib/SqlEditor.svelte'
  import AgentFeed from './lib/AgentFeed.svelte'
  import JsonPane from './lib/JsonPane.svelte'

  let es = null
  let wasDown = false

  onMount(async () => {
    try {
      await loadInfo()
      await loadConnections()
    } catch (err) {
      store.addToast('Failed to connect to sqlmate server: ' + err.message)
    }

    es = new EventSource(`/api/events?projectId=${encodeURIComponent(store.projectId ?? '')}`)
    es.addEventListener('tool_start', (e) => store.applyAgentEvent('tool_start', JSON.parse(e.data)))
    es.addEventListener('tool_end', (e) => store.applyAgentEvent('tool_end', JSON.parse(e.data)))
    es.addEventListener('projects_changed', (e) => store.applyAgentEvent('projects_changed', JSON.parse(e.data)))
    es.onopen = () => { wasDown = false }
    es.onerror = () => {
      // EventSource auto-reconnects; surface a single toast per outage.
      if (!wasDown) {
        wasDown = true
        store.addToast('Lost live connection to sqlmate server; retrying…')
      }
    }
  })

  onDestroy(() => es?.close())

  function handleTabClick(e, tabId) {
    const close = e.target.closest('[data-tab-close]')
    if (close) {
      e.stopPropagation()
      closeTab(close.dataset.tabClose)
    } else {
      activateTab(tabId)
    }
  }
</script>

<div class="h-screen flex flex-col bg-surface-50-950 text-surface-950-50 overflow-hidden">

  <!-- ── AppBar ──────────────────────────────────────────────────────────── -->
  <AppBar spaceY="" padding="px-4 py-2">
    {#snippet lead()}
      <div class="flex flex-col">
        <div class="flex items-center gap-2">
          <DatabaseIcon class="size-4 text-primary-500" />
          <span class="font-mono font-bold tracking-widest text-sm">sqlmate</span>
        </div>
        {#if store.projectRoot}
          <div class="flex items-center gap-1 text-[10px] text-surface-500 font-mono leading-none mt-0.5" title={store.projectRoot}>
            <FolderIcon class="size-2.5 flex-shrink-0" />
            <span class="truncate max-w-48">{store.projectRoot}</span>
          </div>
        {/if}
      </div>
      {#if store.activeTab && !store.isSqlTab(store.activeTab)}
        <span class="hidden sm:flex items-center gap-1 text-sm font-mono text-surface-500 ml-4">
          {store.connections.find(c => c.id === store.activeTab.connId)?.name || store.activeTab.connId}
          <span class="mx-1 opacity-40">/</span>
          <span class="text-primary-400">{store.activeTab.table}</span>
        </span>
      {:else if store.activeTab?.view === 'sql'}
        <span class="hidden sm:inline text-sm font-mono text-warning-400 ml-4">SQL Editor</span>
      {/if}
    {/snippet}
    {#snippet trail()}
      <button
        class="btn btn-sm {store.agentFeedOpen ? 'preset-filled-primary-500' : 'preset-tonal'} gap-2"
        onclick={() => store.agentFeedOpen = !store.agentFeedOpen}
        title="Toggle agent activity feed"
      >
        <ActivityIcon class="size-4" />
        <span class="hidden sm:inline text-xs">Agent Feed</span>
        {#if store.agentEvents.some(e => e.status === 'pending')}
          <span class="size-2 rounded-full bg-warning-400 animate-pulse inline-block"></span>
        {/if}
      </button>
    {/snippet}
  </AppBar>

  <!-- ── Body ───────────────────────────────────────────────────────────── -->
  <div class="flex flex-1 overflow-hidden">

    <!-- Sidebar -->
    <aside class="w-56 flex-shrink-0 border-r border-surface-200-800 overflow-y-auto bg-surface-100-900">
      <Sidebar />
    </aside>

    <!-- Main: tabs + content -->
    <main class="flex flex-col flex-1 overflow-hidden">

      <!-- Tab bar -->
      <div class="flex overflow-x-auto border-b border-surface-200-800 bg-surface-100-900 flex-shrink-0 scrollbar-none">
        {#if store.openTabs.length === 0}
          <div class="px-4 py-2 text-sm text-surface-500 italic">No tables open — select one from the sidebar</div>
        {:else}
          {#each store.openTabs as tab (tab.id)}
            {@const isActive = tab.id === store.activeTabId}
            <button
              class="flex items-center gap-2 px-3 py-2 text-sm border-r border-surface-200-800 whitespace-nowrap transition-colors select-none
                     {isActive ? 'bg-surface-50-950 text-primary-500 border-b-2 border-b-primary-500 -mb-px' : 'text-surface-600-400 hover:bg-surface-200-800/60'}"
              onclick={(e) => handleTabClick(e, tab.id)}
            >
              {#if store.isSqlTab(tab)}
                <span class="font-mono text-warning-400 text-xs leading-none">&gt;_</span>
                <span class="text-xs">{tab.name || tab.connId}</span>
              {:else}
                <span class="font-mono text-xs opacity-50 leading-none">⊞</span>
                <span class="text-xs font-mono">{tab.table}</span>
              {/if}
              <span
                class="size-4 flex items-center justify-center rounded hover:bg-error-500/20 hover:text-error-400 text-surface-400 transition-colors"
                data-tab-close={tab.id}
              >
                <XIcon class="size-3 pointer-events-none" />
              </span>
            </button>
          {/each}
        {/if}
      </div>

      <!-- Tab content -->
      <div class="flex-1 overflow-hidden">
        {#if !store.activeTab}
          <div class="h-full flex flex-col items-center justify-center gap-4 text-surface-500 select-none">
            <DatabaseIcon class="size-10 opacity-15" />
            <p class="text-sm">Open a table from the sidebar to get started</p>
          </div>
        {:else if store.activeTab.view === 'data'}
          <DataGrid connId={store.activeTab.connId} table={store.activeTab.table} />
        {:else if store.activeTab.view === 'schema'}
          <SchemaView connId={store.activeTab.connId} table={store.activeTab.table} />
        {:else if store.activeTab.view === 'sql'}
          <SqlEditor connId={store.activeTab.connId} tabId={store.activeTab.id} />
        {/if}
      </div>
    </main>

    <!-- Agent feed panel -->
    {#if store.agentFeedOpen}
      <aside class="w-80 flex-shrink-0 border-l border-surface-200-800 flex flex-col overflow-hidden bg-surface-100-900">
        <AgentFeed />
      </aside>
    {/if}
  </div>

  <!-- JSON pane overlay -->
  {#if store.jsonPane}
    <JsonPane />
  {/if}

  <!-- Toast notifications -->
  <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
    {#each store.toasts as toast (toast.id)}
      <div class="pointer-events-auto flex items-start gap-3 p-3 rounded-lg border shadow-lg
                  {toast.type === 'error'
                    ? 'bg-error-500/10 border-error-500/30 text-error-300'
                    : 'bg-success-500/10 border-success-500/30 text-success-300'}">
        {#if toast.type === 'error'}
          <AlertCircleIcon class="size-4 flex-shrink-0 mt-0.5" />
        {:else}
          <CheckCircleIcon class="size-4 flex-shrink-0 mt-0.5" />
        {/if}
        <span class="text-xs flex-1">{toast.message}</span>
        <button onclick={() => store.dismissToast(toast.id)} class="text-current opacity-60 hover:opacity-100">
          <XIcon class="size-3" />
        </button>
      </div>
    {/each}
  </div>
</div>
