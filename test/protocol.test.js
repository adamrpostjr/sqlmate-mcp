import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { APP, PROTOCOL_VERSION, HEARTBEAT_MS, PROJECT_TTL_MS, GC_INTERVAL_MS, projectId } from '../src/protocol.js'

describe('protocol constants', () => {
  test('exposes expected values', () => {
    assert.equal(APP, 'sqlmate-mcp')
    assert.equal(PROTOCOL_VERSION, 1)
    assert.equal(HEARTBEAT_MS, 15_000)
    assert.equal(PROJECT_TTL_MS, 60_000)
    assert.equal(GC_INTERVAL_MS, 15_000)
  })
})

describe('projectId', () => {
  test('is stable across repeated calls for the same path', () => {
    const a = projectId('/home/user/my-project')
    const b = projectId('/home/user/my-project')
    assert.equal(a, b)
  })

  test('incorporates the basename as a readable prefix', () => {
    const id = projectId('/home/user/my-project')
    assert.ok(id.startsWith('my-project-'), `expected id to start with "my-project-", got ${id}`)
  })

  test('differs for different paths with the same basename', () => {
    const a = projectId(path.join('/home/alice', 'shared-name'))
    const b = projectId(path.join('/home/bob', 'shared-name'))
    assert.notEqual(a, b)
  })

  test('appends an 8-char hex suffix derived from the full path', () => {
    const id = projectId('/home/user/my-project')
    const suffix = id.slice(id.lastIndexOf('-') + 1)
    assert.match(suffix, /^[0-9a-f]{8}$/)
  })

  test('maps casing differences to the same id on win32', { skip: process.platform !== 'win32' }, () => {
    const a = projectId('C:\\Users\\test\\MyProject')
    const b = projectId('c:\\users\\test\\myproject')
    assert.equal(a, b)
  })
})
