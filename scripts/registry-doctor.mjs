#!/usr/bin/env node
/**
 * Workspace registry doctor.
 *
 * `move-to-workspace` 0.1.8 and 0.1.9 could register a second workspace for a
 * folder that was already registered under another path spelling (a symlink and
 * its target), and the new row adopted the folder's Sessions. That leaves one
 * Session accounted for by two workspaces, which `@deepseek-ai/dsh-workspace`
 * rejects on the next load: the workspace domain never mounts, and the app shows
 * no workspaces and no conversations until the registry is repaired.
 *
 * This tool finds those rows and repairs them. It only touches the workspace
 * registry: no conversation log, projection cache, or archive/pin membership is
 * removed.
 *
 * Usage (quit the app first — the Host rewrites the registry while it runs):
 *   node scripts/registry-doctor.mjs           # report only
 *   node scripts/registry-doctor.mjs --fix     # repair in place
 *   node scripts/registry-doctor.mjs --file path/to/workspace.json --fix
 */
import { execFile } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { realpath } from 'node:fs/promises'

const run = promisify(execFile)

/** Default registry location for the current DSH home. */
export function defaultRegistryPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'workspace.json')
}

/** Resolve one stored path, falling back to the stored spelling. */
async function resolvePath(targetPath) {
  if (typeof targetPath !== 'string' || targetPath === '') return undefined
  return await realpath(targetPath).catch(() => targetPath)
}

/**
 * Report the registry defects that stop the workspace domain from loading.
 * Pure apart from resolving registered paths on disk.
 * @param state - parsed `workspace.json` payload.
 * @returns duplicate folder groups and Sessions with more than one owner.
 */
export async function analyzeRegistry(state) {
  const workspaces = state?.tables?.workspaces ?? {}
  const rows = Object.entries(workspaces).map(([workspaceId, workspace]) => ({
    workspaceId,
    path: workspace.path,
    createdAt: String(workspace.createdAt ?? ''),
    sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
  }))
  const resolved = new Map()
  for (const row of rows) resolved.set(row.workspaceId, await resolvePath(row.path))

  const byRealPath = new Map()
  for (const row of rows) {
    const realPath = resolved.get(row.workspaceId)
    const bucket = byRealPath.get(realPath) ?? []
    bucket.push(row)
    byRealPath.set(realPath, bucket)
  }
  const duplicateFolders = [...byRealPath.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([realPath, bucket]) => ({ realPath, workspaceIds: bucket.map((row) => row.workspaceId) }))

  const owners = new Map()
  for (const row of rows) {
    for (const sessionId of row.sessionIds) {
      const bucket = owners.get(sessionId) ?? []
      bucket.push(row.workspaceId)
      owners.set(sessionId, bucket)
    }
  }
  const sharedSessions = [...owners.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([sessionId, workspaceIds]) => ({ sessionId, workspaceIds }))

  return { workspaces: rows.length, duplicateFolders, sharedSessions }
}

/** Whether a reported analysis needs a repair. */
export function isConsistent(analysis) {
  return analysis.duplicateFolders.length === 0 && analysis.sharedSessions.length === 0
}

/**
 * Repair a registry payload: collapse folders registered more than once onto a
 * single row, then leave each Session with exactly one owning workspace.
 * @param state - parsed `workspace.json` payload.
 * @param resolvedPaths - `workspaceId -> resolved path`, from `analyzeRegistry`.
 * @returns the repaired payload plus the changes that were applied.
 */
export function repairRegistry(state, resolvedPaths, options = {}) {
  const workspaces = state?.tables?.workspaces ?? {}
  const changes = []
  const drop = new Map()

  const groups = new Map()
  for (const workspaceId of Object.keys(workspaces)) {
    const realPath = resolvedPaths.get(workspaceId) ?? workspaces[workspaceId].path
    const bucket = groups.get(realPath) ?? []
    bucket.push(workspaceId)
    groups.set(realPath, bucket)
  }
  for (const [realPath, bucket] of groups) {
    if (bucket.length < 2) continue
    // Keep the row registered under the resolved spelling when there is one, so
    // the surviving workspace points at the folder rather than at a symlink.
    const keep = bucket.find((workspaceId) => workspaces[workspaceId].path === realPath) ?? bucket[0]
    for (const workspaceId of bucket) {
      if (workspaceId === keep) continue
      for (const sessionId of workspaces[workspaceId].sessionIds ?? []) {
        if (!workspaces[keep].sessionIds.includes(sessionId)) workspaces[keep].sessionIds.push(sessionId)
      }
      drop.set(workspaceId, keep)
      changes.push({ kind: 'drop-duplicate-workspace', workspaceId, mergedInto: keep, realPath })
    }
  }
  for (const workspaceId of drop.keys()) delete workspaces[workspaceId]

  const ordered = Object.entries(workspaces).sort((left, right) =>
    String(left[1].createdAt ?? '').localeCompare(String(right[1].createdAt ?? '')))
  const owners = new Map()
  for (const [workspaceId, workspace] of ordered) {
    const kept = []
    for (const sessionId of [...(workspace.sessionIds ?? [])]) {
      const owner = owners.get(sessionId)
      if (owner === undefined) {
        owners.set(sessionId, workspaceId)
        kept.push(sessionId)
        continue
      }
      changes.push({ kind: 'release-shared-session', sessionId, workspaceId, keptIn: owner })
    }
    workspace.sessionIds = kept
  }

  if (drop.size > 0) {
    const global = state.global ?? {}
    if (Array.isArray(global.workspaceIds)) global.workspaceIds = global.workspaceIds.filter((workspaceId) => !drop.has(workspaceId))
    if (typeof global.defaultWorkspaceId === 'string' && !workspaces[global.defaultWorkspaceId]) {
      global.defaultWorkspaceId = ordered[0]?.[0] ?? global.defaultWorkspaceId
      changes.push({ kind: 'retarget-default-workspace', workspaceId: global.defaultWorkspaceId })
    }
    state.global = global
  }
  return { state, changes, options }
}

/** Whether a DSH Host is running and would overwrite the repair. */
async function hostIsRunning() {
  try {
    const { stdout } = await run('pgrep', ['-f', 'dsh-desktop-host/lib/index.js'])
    return stdout.trim() !== ''
  } catch {
    return false
  }
}

async function main(argv) {
  const fix = argv.includes('--fix')
  const fileIndex = argv.indexOf('--file')
  const file = fileIndex === -1 ? defaultRegistryPath() : argv[fileIndex + 1]
  if (file === undefined) {
    console.error('registry-doctor: --file needs a path')
    return 2
  }
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    console.error(`registry-doctor: cannot read ${file}: ${error.message}`)
    return 2
  }
  let state
  try {
    state = JSON.parse(raw)
  } catch (error) {
    console.error(`registry-doctor: ${file} is not valid JSON: ${error.message}`)
    return 2
  }

  const analysis = await analyzeRegistry(state)
  console.log(`registry-doctor: ${file}`)
  console.log(`  workspaces: ${analysis.workspaces}`)
  if (isConsistent(analysis)) {
    console.log('  result: consistent — no duplicate folders, every conversation has one workspace')
    return 0
  }
  for (const duplicate of analysis.duplicateFolders) {
    console.log(`  duplicate folder: ${duplicate.realPath}`)
    for (const workspaceId of duplicate.workspaceIds) console.log(`    workspace ${workspaceId}`)
  }
  for (const shared of analysis.sharedSessions) {
    console.log(`  shared conversation: ${shared.sessionId} in ${shared.workspaceIds.join(', ')}`)
  }
  console.log('  result: INCONSISTENT — the workspace domain will not load while this is stored')

  if (!fix) {
    console.log('  run again with --fix to repair it')
    return 1
  }
  if (await hostIsRunning()) {
    console.error('  refusing to write: a DSH Host is running and would overwrite the repair. Quit the app first.')
    return 2
  }

  const resolvedPaths = new Map()
  for (const [workspaceId, workspace] of Object.entries(state.tables?.workspaces ?? {})) {
    resolvedPaths.set(workspaceId, await resolvePath(workspace.path))
  }

  const { changes } = repairRegistry(state, resolvedPaths)
  const backup = `${file}.before-doctor-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await writeFile(backup, raw, 'utf8')
  const temporary = `${file}.doctor-tmp`
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
  await rename(temporary, file)
  for (const change of changes) console.log(`  fixed: ${JSON.stringify(change)}`)
  console.log(`  backup: ${backup}`)
  console.log('  result: repaired — reopen the app')
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
