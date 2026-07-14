<script>
  import { PlayIcon, Loader2Icon, TerminalIcon, Trash2Icon, GaugeIcon } from '@lucide/svelte'
  import { store } from './store.svelte.js'
  import { api, connectionPath, runExplain } from './api.js'

  let { projectId, connId, tabId } = $props()

  const conn = $derived(store.getConnection(projectId, connId))
  const loading = $derived(!!store.loading[`sql:${tabId}`])
  const explaining = $derived(!!store.loading[`explain:${tabId}`])
  const result = $derived(store.sqlResults[tabId])
  // Initialise from store snapshot; tabId is stable for a given editor instance
  const initSql = store.sqlContent[tabId] || ''
  let sql = $state(initSql)

  $effect(() => { store.sqlContent[tabId] = sql })

  async function runSql() {
    if (!sql.trim()) return
    store.loading[`sql:${tabId}`] = true
    try {
      const res = await api('POST', connectionPath(projectId, connId, '/query'), { sql })
      store.sqlResults[tabId] = res
    } catch (err) {
      store.sqlResults[tabId] = { rows: [], columns: [], error: err.message }
    } finally {
      delete store.loading[`sql:${tabId}`]
    }
  }

  async function explainSql() {
    if (!sql.trim()) return
    await runExplain(projectId, connId, tabId, sql, false)
  }

  function sqlKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      runSql()
    }
  }

  function clearResults() {
    delete store.sqlResults[tabId]
  }

  function tryJson(v) {
    if (typeof v !== 'string') return null
    const t = v.trim()
    if (!t.startsWith('{') && !t.startsWith('[')) return null
    try { return JSON.parse(t) } catch { return null }
  }
</script>

<div class="flex flex-col h-full">
  <!-- Header -->
  <div class="flex items-center gap-2 px-4 py-2 border-b border-surface-200-800 flex-shrink-0 bg-surface-100-900">
    <TerminalIcon class="size-4 text-warning-400" />
    <span class="text-sm text-warning-400 font-mono">SQL Editor</span>
    {#if conn}
      <span class="text-xs text-surface-500 font-mono">· {conn.name}</span>
    {/if}
  </div>

  <!-- Editor area -->
  <div class="flex flex-col flex-shrink-0 border-b border-surface-200-800 p-3 gap-2">
    <textarea
      class="w-full h-28 bg-surface-50-950 border border-surface-200-800 rounded p-2 font-mono text-sm
             outline-none focus:border-primary-500 resize-y text-surface-950-50 placeholder-surface-500"
      placeholder="SELECT * FROM table_name  (Ctrl+Enter to run)"
      bind:value={sql}
      onkeydown={sqlKeydown}
    ></textarea>
    <div class="flex items-center gap-2">
      <button
        class="btn btn-sm preset-filled-primary-500 gap-1.5"
        onclick={runSql}
        disabled={loading || !sql.trim()}
      >
        {#if loading}
          <Loader2Icon class="size-3.5 animate-spin" />
        {:else}
          <PlayIcon class="size-3.5" />
        {/if}
        Run
      </button>
      <button
        class="btn btn-sm preset-tonal gap-1.5"
        onclick={explainSql}
        disabled={explaining || !sql.trim()}
        title="Show the query execution plan without running it"
      >
        {#if explaining}
          <Loader2Icon class="size-3.5 animate-spin" />
        {:else}
          <GaugeIcon class="size-3.5" />
        {/if}
        Explain
      </button>
      {#if result}
        <button class="btn btn-sm preset-tonal gap-1" onclick={clearResults}>
          <Trash2Icon class="size-3" /> Clear
        </button>
      {/if}
      <span class="text-xs text-surface-500">Ctrl+Enter to run</span>
    </div>
  </div>

  <!-- Results -->
  <div class="flex-1 overflow-auto">
    {#if loading}
      <div class="flex items-center justify-center h-16 gap-2 text-surface-500 text-sm">
        <Loader2Icon class="size-4 animate-spin" /> Running query...
      </div>
    {:else if explaining}
      <div class="flex items-center justify-center h-16 gap-2 text-surface-500 text-sm">
        <Loader2Icon class="size-4 animate-spin" /> Building execution plan...
      </div>
    {:else if result?.plan !== undefined && result.plan !== null}
      <div class="text-xs text-surface-500 px-4 py-1.5 border-b border-surface-200-800">
        Execution plan ({result.planFormat})
      </div>
      {#if result.planFormat === 'query_plan' && Array.isArray(result.plan)}
        <pre class="p-4 font-mono text-xs whitespace-pre-wrap">{result.plan.map(r => `${'  '.repeat(r.id ?? 0)}${r.detail ?? JSON.stringify(r)}`).join('\n')}</pre>
      {:else if result.planFormat === 'json'}
        <pre class="p-4 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(result.plan, null, 2)}</pre>
      {:else}
        <pre class="p-4 font-mono text-xs whitespace-pre-wrap">{typeof result.plan === 'string' ? result.plan : JSON.stringify(result.plan, null, 2)}</pre>
      {/if}
    {:else if result?.error}
      <div class="p-4 text-error-400 font-mono text-sm">{result.error}</div>
    {:else if result?.rows?.length > 0}
      {@const columns = result.columns?.length ? result.columns : Object.keys(result.rows[0])}
      <div class="text-xs text-surface-500 px-4 py-1.5 border-b border-surface-200-800 flex items-center gap-2">
        <span>{result.rows.length} row{result.rows.length !== 1 ? 's' : ''}</span>
        {#if typeof result.durationMs === 'number'}
          <span class="text-surface-400">· {result.durationMs} ms</span>
        {/if}
      </div>
      <table class="w-full text-xs border-collapse">
        <thead>
          <tr class="sticky top-0 bg-surface-100-900 border-b border-surface-200-800">
            {#each columns as col}
              <th class="px-3 py-2 text-left font-normal text-surface-500 whitespace-nowrap">{col}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each result.rows as row}
            <tr class="border-b border-surface-100-900 hover:bg-surface-200-800/40 transition-colors">
              {#each columns as col}
                {@const val = row[col]}
                {@const isJson = val !== null && tryJson(val) !== null}
                <td
                  class="px-3 py-1.5 max-w-xs overflow-hidden text-ellipsis whitespace-nowrap
                         {val === null || val === undefined ? 'text-surface-500 italic' : ''}
                         {isJson ? 'text-sky-400 underline decoration-dotted cursor-pointer' : ''}"
                  title={val !== null && val !== undefined ? String(val) : 'NULL'}
                  onclick={isJson ? () => store.jsonPane = { title: col, data: tryJson(val) } : undefined}
                >
                  {#if val === null || val === undefined}NULL
                  {:else if isJson}&#123;…&#125;
                  {:else}{String(val).length > 80 ? String(val).slice(0, 80) + '…' : String(val)}
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if result}
      <div class="p-4 text-surface-500 text-sm italic">Query returned no rows.</div>
    {:else}
      <div class="flex flex-col items-center justify-center h-full gap-3 text-surface-500">
        <TerminalIcon class="size-8 opacity-20" />
        <p class="text-sm">Write a query and press Run</p>
      </div>
    {/if}
  </div>
</div>
