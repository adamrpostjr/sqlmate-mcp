<script>
  import {
    ActivityIcon, CheckCircle2Icon, XCircleIcon, Loader2Icon, ShieldAlertIcon,
    DatabaseIcon, TableIcon, SearchIcon, PenLineIcon, ListIcon, Trash2Icon, PlugIcon
  } from '@lucide/svelte'
  import { store } from './store.svelte.js'

  let listEl = $state(null)
  let autoScroll = $state(true)

  const toolMeta = {
    list_connections: { label: 'list connections', color: 'text-surface-400',    bg: 'bg-surface-500/10 border-surface-500/20',    Icon: DatabaseIcon },
    add_connection:   { label: 'add connection',   color: 'text-primary-400',    bg: 'bg-primary-500/10 border-primary-500/20',    Icon: PlugIcon },
    list_tables:      { label: 'list tables',      color: 'text-secondary-400',  bg: 'bg-secondary-500/10 border-secondary-500/20', Icon: ListIcon },
    describe_table:   { label: 'describe table',   color: 'text-tertiary-400',   bg: 'bg-tertiary-500/10 border-tertiary-500/20',  Icon: TableIcon },
    run_query:        { label: 'run query',         color: 'text-success-400',    bg: 'bg-success-500/10 border-success-500/20',    Icon: SearchIcon },
    run_write:        { label: 'run write',         color: 'text-warning-400',    bg: 'bg-warning-500/10 border-warning-500/20',    Icon: PenLineIcon },
  }

  function meta(tool) {
    return toolMeta[tool] || { label: tool, color: 'text-surface-400', bg: 'bg-surface-500/10 border-surface-500/20', Icon: ActivityIcon }
  }

  function timeAgo(iso) {
    if (!iso) return ''
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (diff < 5) return 'just now'
    if (diff < 60) return `${diff}s ago`
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    return `${Math.floor(diff / 3600)}h ago`
  }

  function argPreview(tool, args) {
    if (!args) return ''
    if (args.sql) return args.sql.trim().replace(/\s+/g, ' ').slice(0, 120)
    if (args.table) return args.table
    if (args.connectionId && tool === 'list_tables') return args.connectionId
    return ''
  }

  function connName(ev) {
    if (!ev.connectionId) return ''
    return store.getConnection(ev.projectId, ev.connectionId)?.name || ev.connectionId
  }

  // Auto-scroll to top (newest events are unshifted)
  $effect(() => {
    const _ = store.agentEvents.length
    if (autoScroll && listEl) {
      listEl.scrollTop = 0
    }
  })
</script>

<div class="flex flex-col h-full">
  <!-- Header -->
  <div class="flex items-center gap-2 px-3 py-2 border-b border-surface-200-800 flex-shrink-0">
    <ActivityIcon class="size-4 text-primary-400" />
    <span class="text-xs font-medium flex-1">Agent Activity</span>
    {#if store.agentEvents.some(e => e.status === 'pending')}
      <span class="flex items-center gap-1 text-[10px] text-warning-400">
        <Loader2Icon class="size-3 animate-spin" /> active
      </span>
    {:else if store.agentEvents.length > 0}
      <span class="text-[10px] text-surface-500">{store.agentEvents.length} calls</span>
    {/if}
    {#if store.agentEvents.length > 0}
      <button
        class="p-1 text-surface-500 hover:text-error-400 transition-colors rounded"
        onclick={() => store.clearAgentEvents()}
        title="Clear feed"
      >
        <Trash2Icon class="size-3" />
      </button>
    {/if}
  </div>

  <!-- Events list -->
  <div
    class="flex-1 overflow-y-auto py-2 flex flex-col gap-1.5 px-2"
    bind:this={listEl}
    onscroll={(e) => { autoScroll = e.target.scrollTop < 20 }}
  >
    {#if store.agentEvents.length === 0}
      <div class="flex flex-col items-center justify-center h-full gap-3 text-surface-500">
        <ActivityIcon class="size-8 opacity-20" />
        <p class="text-xs text-center px-4">
          Live tool calls from Claude will appear here as the agent queries your databases.
        </p>
      </div>
    {:else}
      {#each store.agentEvents as ev (ev.id)}
        {@const m = meta(ev.tool)}
        {@const preview = argPreview(ev.tool, ev.args)}
        <div class="rounded-lg border p-2.5 text-xs {m.bg} transition-all">
          <!-- Top row: tool badge + status + time -->
          <div class="flex items-center gap-1.5 mb-1">
            <span class="flex items-center gap-1 {m.color} font-mono text-[11px]">
              <m.Icon class="size-3 flex-shrink-0" />
              {m.label}
            </span>
            <div class="flex-1"></div>
            {#if ev.status === 'pending'}
              <Loader2Icon class="size-3 text-warning-400 animate-spin flex-shrink-0" />
            {:else if ev.status === 'awaiting_confirm'}
              <ShieldAlertIcon class="size-3 text-warning-400 flex-shrink-0" />
            {:else if ev.status === 'success'}
              <CheckCircle2Icon class="size-3 text-success-400 flex-shrink-0" />
            {:else if ev.status === 'error'}
              <XCircleIcon class="size-3 text-error-400 flex-shrink-0" />
            {/if}
            <span class="text-surface-500 text-[10px] flex-shrink-0">{timeAgo(ev.timestamp)}</span>
          </div>

          <!-- Connection -->
          {#if ev.connectionId}
            <div class="text-surface-500 text-[11px] mb-1 font-mono truncate">
              {#if store.projects.length > 1}
                <span class="opacity-60">{store.projectName(ev.projectId)}/</span>
              {/if}
              {connName(ev)}
            </div>
          {/if}

          <!-- Query / table preview -->
          {#if preview}
            <div class="font-mono text-[11px] text-surface-300-700 bg-surface-900-100/30 rounded px-2 py-1 truncate" title={preview}>
              {preview}
            </div>
          {/if}

          <!-- Result / error / confirmation request -->
          {#if ev.status === 'awaiting_confirm'}
            <div class="mt-1.5 rounded border border-warning-500/40 bg-warning-500/10 px-2 py-1.5 text-[11px] text-warning-300 flex items-start gap-1.5">
              <ShieldAlertIcon class="size-3 flex-shrink-0 mt-0.5" />
              <span>Awaiting user approval before proceeding</span>
            </div>
          {:else if ev.status === 'success' && ev.duration != null}
            <div class="mt-1 text-[10px] text-surface-500 flex gap-2">
              {#if ev.rowCount != null}
                <span class="text-success-400">{ev.rowCount} rows</span>
              {/if}
              <span>{ev.duration}ms</span>
            </div>
          {:else if ev.status === 'error' && ev.error}
            <div class="mt-1 text-[10px] text-error-400 truncate" title={ev.error}>{ev.error}</div>
          {:else if ev.status === 'pending'}
            <div class="mt-1 text-[10px] text-surface-500 italic">running…</div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>
