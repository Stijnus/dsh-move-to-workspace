import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeRegistry, isConsistent, repairRegistry } from '../scripts/registry-doctor.mjs'

/** Registry payload with one workspace row per entry. */
function registry(rows, extra = {}) {
  const tables = { workspaces: {} }
  for (const [workspaceId, row] of Object.entries(rows)) {
    tables.workspaces[workspaceId] = {
      path: row.path,
      title: row.title ?? workspaceId,
      sessionIds: row.sessionIds ?? [],
      createdAt: row.createdAt ?? '2026-10-01T00:00:00.000Z',
      updatedAt: row.createdAt ?? '2026-10-01T00:00:00.000Z',
    }
  }
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: Object.keys(rows)[0] ?? null, workspaceIds: Object.keys(rows), archivedSessionIds: [], pinnedSessionIds: [], ...extra },
    tables,
  }
}

test('reports a folder registered under both its symlink and its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'registry-doctor-'))
  try {
    const real = join(root, 'real')
    const link = join(root, 'link')
    await mkdir(real)
    await symlink(real, link)
    const state = registry({
      w1: { path: link, sessionIds: ['session-a'] },
      w2: { path: real, sessionIds: ['session-a'] },
    })
    const canonical = await realpath(real)
    const analysis = await analyzeRegistry(state)
    assert.equal(isConsistent(analysis), false)
    assert.deepEqual(analysis.duplicateFolders, [{ realPath: canonical, workspaceIds: ['w1', 'w2'] }])
    assert.deepEqual(analysis.sharedSessions, [{ sessionId: 'session-a', workspaceIds: ['w1', 'w2'] }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('repair keeps the resolved spelling and moves sessions onto the survivor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'registry-doctor-'))
  try {
    const real = join(root, 'real')
    const link = join(root, 'link')
    await mkdir(real)
    await symlink(real, link)
    const state = registry({
      w1: { path: link, sessionIds: ['session-a', 'session-b'] },
      w2: { path: real, sessionIds: ['session-a', 'session-c'] },
    })
    const resolved = new Map([['w1', real], ['w2', real]])
    const { changes } = repairRegistry(state, resolved)
    assert.deepEqual(Object.keys(state.tables.workspaces), ['w2'])
    assert.equal(state.tables.workspaces.w2.path, real)
    assert.deepEqual(state.tables.workspaces.w2.sessionIds, ['session-a', 'session-c', 'session-b'])
    assert.deepEqual(state.global.workspaceIds, ['w2'])
    assert.ok(changes.some((change) => change.kind === 'drop-duplicate-workspace' && change.workspaceId === 'w1'))
    const analysis = await analyzeRegistry(state)
    assert.equal(isConsistent(analysis), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('repair leaves one owner when a session is accounted twice across distinct folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'registry-doctor-'))
  try {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(first)
    await mkdir(second)
    const state = registry({
      w2: { path: second, sessionIds: ['session-a'], createdAt: '2026-10-02T00:00:00.000Z' },
      w1: { path: first, sessionIds: ['session-a', 'session-b'], createdAt: '2026-10-01T00:00:00.000Z' },
    })
    const resolved = new Map([['w1', first], ['w2', second]])
    const { changes } = repairRegistry(state, resolved)
    assert.deepEqual(state.tables.workspaces.w1.sessionIds, ['session-a', 'session-b'], 'the oldest workspace keeps the session')
    assert.deepEqual(state.tables.workspaces.w2.sessionIds, [])
    assert.ok(changes.some((change) => change.kind === 'release-shared-session' && change.sessionId === 'session-a' && change.keptIn === 'w1'))
    assert.equal(isConsistent(await analyzeRegistry(state)), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a healthy registry reports consistent and repairs nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'registry-doctor-'))
  try {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(first)
    await mkdir(second)
    const state = registry({
      w1: { path: first, sessionIds: ['session-a'] },
      w2: { path: second, sessionIds: ['session-b'] },
    })
    const analysis = await analyzeRegistry(state)
    assert.equal(isConsistent(analysis), true)
    const resolved = new Map([['w1', first], ['w2', second]])
    const before = JSON.stringify(state)
    const { changes } = repairRegistry(state, resolved)
    assert.deepEqual(changes, [])
    assert.equal(JSON.stringify(state), before, 'a consistent registry is left untouched')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
