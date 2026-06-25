<script>
  import { XIcon, CopyIcon } from '@lucide/svelte'
  import { store } from './store.svelte.js'

  const formatted = $derived(
    store.jsonPane ? JSON.stringify(store.jsonPane.data, null, 2) : ''
  )

  async function copy() {
    try {
      await navigator.clipboard.writeText(formatted)
      store.addToast('Copied to clipboard', 'success')
    } catch {}
  }

  function close() { store.jsonPane = null }

  function backdropClick(e) {
    if (e.target === e.currentTarget) close()
  }
</script>

<!-- Backdrop -->
<div
  class="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
  onclick={backdropClick}
  role="dialog"
  aria-modal="true"
>
  <!-- Panel -->
  <div class="absolute right-0 top-0 bottom-0 w-96 bg-surface-100-900 border-l border-primary-500/30 flex flex-col shadow-2xl">
    <!-- Header -->
    <div class="flex items-center gap-3 px-4 py-3 border-b border-surface-200-800">
      <span class="text-sm font-mono text-primary-400 flex-1 truncate">
        {store.jsonPane?.title || 'JSON'}
      </span>
      <button class="btn btn-icon-sm preset-tonal" onclick={copy} title="Copy JSON">
        <CopyIcon class="size-3.5" />
      </button>
      <button class="btn btn-icon-sm preset-tonal" onclick={close} title="Close">
        <XIcon class="size-3.5" />
      </button>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-auto p-4">
      <pre class="text-xs font-mono text-surface-950-50 whitespace-pre-wrap break-words leading-relaxed">{formatted}</pre>
    </div>
  </div>
</div>
