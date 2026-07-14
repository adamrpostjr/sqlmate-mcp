<script>
  import { Handle, Position } from '@xyflow/svelte'
  import { KeyIcon, LinkIcon } from '@lucide/svelte'

  let { id, data } = $props()

  const table = $derived(data.table)
  const fkColumns = $derived(new Set((table?.foreignKeys ?? []).map(fk => fk.column)))
</script>

<div class="rounded-lg border border-surface-300-700 bg-surface-50-950 shadow-md text-xs overflow-hidden" style="width: {data.width}px">
  <Handle type="target" position={Position.Left} class="!bg-primary-500" />
  <Handle type="source" position={Position.Right} class="!bg-primary-500" />

  <button
    type="button"
    class="w-full flex items-center gap-1.5 px-2 py-1.5 bg-primary-500/10 border-b border-surface-300-700 text-left hover:bg-primary-500/20 transition-colors"
    onclick={() => data.onOpenTable?.(table.name)}
    title="Open {table.name} data"
  >
    <span class="font-mono font-semibold text-primary-400 truncate">{table.name}</span>
  </button>

  <div>
    {#each table.columns as col (col.column)}
      <div class="flex items-center gap-1.5 px-2 py-1 border-b border-surface-100-900 last:border-b-0">
        {#if col.pk}
          <KeyIcon class="size-2.5 text-amber-400 flex-shrink-0" />
        {:else if fkColumns.has(col.column)}
          <LinkIcon class="size-2.5 text-sky-400 flex-shrink-0" />
        {:else}
          <span class="size-2.5 flex-shrink-0"></span>
        {/if}
        <span class="font-mono truncate {col.pk ? 'text-primary-400' : 'text-surface-700-300'}">{col.column}</span>
        <span class="ml-auto font-mono text-surface-500 truncate">{col.type}</span>
      </div>
    {/each}
  </div>
</div>
