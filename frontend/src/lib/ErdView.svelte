<script>
  import { SvelteFlow, Background, Controls, MiniMap } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import Dagre from '@dagrejs/dagre'
  import { Loader2Icon, NetworkIcon } from '@lucide/svelte'
  import { store } from './store.svelte.js'
  import { loadSchemaGraph, openTable } from './api.js'
  import ErdTableNode from './ErdTableNode.svelte'

  let { projectId, connId } = $props()

  const nodeTypes = { table: ErdTableNode }

  let nodes = $state([])
  let edges = $state([])

  const ck = $derived(store.ck(projectId, connId))
  const graph = $derived(store.schemaGraph[ck])
  const loading = $derived(!!store.loading[`erd:${ck}`])

  $effect(() => {
    if (!store.schemaGraph[ck]) {
      loadSchemaGraph(projectId, connId)
    }
  })

  function handleOpenTable(table) {
    openTable(projectId, connId, table)
  }

  const NODE_WIDTH = 240

  function layout(g) {
    const tables = g?.tables ?? []
    const tableNames = new Set(tables.map(t => t.name))

    const dagreGraph = new Dagre.graphlib.Graph()
    dagreGraph.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 })
    dagreGraph.setDefaultEdgeLabel(() => ({}))

    for (const table of tables) {
      const height = 36 + table.columns.length * 22
      dagreGraph.setNode(table.name, { width: NODE_WIDTH, height })
    }

    const builtEdges = []
    for (const table of tables) {
      for (const fk of table.foreignKeys ?? []) {
        if (!tableNames.has(fk.refTable)) continue
        const id = `${table.name}.${fk.column}->${fk.refTable}`
        dagreGraph.setEdge(table.name, fk.refTable)
        builtEdges.push({
          id,
          source: table.name,
          target: fk.refTable,
          label: fk.column,
          animated: false
        })
      }
    }

    Dagre.layout(dagreGraph)

    const builtNodes = tables.map(table => {
      const dagreNode = dagreGraph.node(table.name)
      const height = 36 + table.columns.length * 22
      return {
        id: table.name,
        type: 'table',
        position: {
          x: (dagreNode?.x ?? 0) - NODE_WIDTH / 2,
          y: (dagreNode?.y ?? 0) - height / 2
        },
        data: { table, width: NODE_WIDTH, onOpenTable: handleOpenTable }
      }
    })

    return { builtNodes, builtEdges }
  }

  $effect(() => {
    const g = graph
    if (!g) {
      nodes = []
      edges = []
      return
    }
    const { builtNodes, builtEdges } = layout(g)
    nodes = builtNodes
    edges = builtEdges
  })
</script>

<div class="flex flex-col h-full">
  <div class="flex items-center gap-2 px-4 py-2 border-b border-surface-200-800 flex-shrink-0 bg-surface-100-900">
    <NetworkIcon class="size-4 text-primary-400" />
    <span class="font-mono text-sm text-primary-400">Schema ERD</span>
    {#if graph}
      <span class="text-xs text-surface-500">{graph.tables.length} tables</span>
    {/if}
  </div>

  <div class="flex-1 relative">
    {#if loading}
      <div class="absolute inset-0 flex items-center justify-center gap-2 text-surface-500">
        <Loader2Icon class="size-5 animate-spin" />
        <span class="text-sm">Loading schema graph…</span>
      </div>
    {:else if !graph || graph.tables.length === 0}
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-surface-500 select-none">
        <NetworkIcon class="size-10 opacity-15" />
        <p class="text-sm">No tables to diagram</p>
      </div>
    {:else}
      <div class="w-full h-full">
        <SvelteFlow bind:nodes bind:edges {nodeTypes} fitView minZoom={0.1}>
          <Background />
          <Controls />
          <MiniMap />
        </SvelteFlow>
      </div>
    {/if}
  </div>
</div>
