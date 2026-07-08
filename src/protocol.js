import path from 'path'
import crypto from 'crypto'
import { slugify } from './connections.js'

export const APP = 'sqlmate-mcp'
export const PROTOCOL_VERSION = 1
export const HEARTBEAT_MS = 15_000
export const PROJECT_TTL_MS = 60_000
export const GC_INTERVAL_MS = 15_000

// Stable, filesystem-path-derived id for a project. Two paths that only differ
// by casing on a case-insensitive filesystem (Windows) resolve to the same id.
export function projectId(projectRoot) {
  let full = path.resolve(projectRoot)
  if (process.platform === 'win32') full = full.toLowerCase()
  const hash = crypto.createHash('sha1').update(full).digest('hex').slice(0, 8)
  const base = slugify(path.basename(projectRoot)) || 'project'
  return `${base}-${hash}`
}
