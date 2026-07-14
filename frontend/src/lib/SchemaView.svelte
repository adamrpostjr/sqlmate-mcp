<script>
  import { TableIcon, KeyIcon } from '@lucide/svelte'
  import { store } from './store.svelte.js'
  import { openSqlTab } from './api.js'

  let { projectId, connId, table } = $props()

  const schema = $derived(store.getSchema(projectId, connId, table))
  const currentTab = $derived(store.openTabs.find(t => t.id === store.tabId(projectId, connId, table)))

  function setView(view) {
    if (currentTab) currentTab.view = view
  }
</script>

<div class="flex flex-col h-full">
  <div class="flex items-center gap-2 px-4 py-2 border-b border-surface-200-800 flex-shrink-0 bg-surface-100-900">
    <TableIcon class="size-4 text-primary-400" />
    <span class="font-mono text-sm text-primary-400">{table}</span>
    <span class="text-xs text-surface-500">{schema.length} columns</span>
    <div class="flex-1"></div>
    <button class="btn btn-sm preset-tonal text-xs" onclick={() => setView('data')}>Data</button>
    <button class="btn btn-sm preset-filled-primary-500 text-xs">Schema</button>
    <button class="btn btn-sm preset-tonal text-xs" onclick={() => openSqlTab(projectId, connId)}>SQL</button>
  </div>

  <div class="flex-1 overflow-auto p-4">
    {#if schema.length === 0}
      <p class="text-sm text-surface-500 italic">No schema available</p>
    {:else}
      <table class="w-full text-sm border-collapse">
        <thead>
          <tr class="border-b border-surface-200-800">
            <th class="px-3 py-2 text-left font-normal text-surface-500 text-xs">Column</th>
            <th class="px-3 py-2 text-left font-normal text-surface-500 text-xs">Type</th>
            <th class="px-3 py-2 text-left font-normal text-surface-500 text-xs">Nullable</th>
            <th class="px-3 py-2 text-left font-normal text-surface-500 text-xs">Key</th>
          </tr>
        </thead>
        <tbody>
          {#each schema as col}
            <tr class="border-b border-surface-100-900 hover:bg-surface-200-800/30 transition-colors">
              <td class="px-3 py-2 font-mono text-xs {col.pk ? 'text-primary-400 font-medium' : ''}">
                {col.column}
              </td>
              <td class="px-3 py-2 font-mono text-xs text-sky-400">{col.type}</td>
              <td class="px-3 py-2 text-xs {col.nullable ? 'text-surface-500' : 'text-surface-700-300'}">
                {col.nullable ? 'YES' : 'NO'}
              </td>
              <td class="px-3 py-2">
                {#if col.pk}
                  <span class="inline-flex items-center gap-1 text-[10px] text-amber-400 border border-amber-400/40 rounded px-1.5 py-0.5">
                    <KeyIcon class="size-3" /> PK
                  </span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>
