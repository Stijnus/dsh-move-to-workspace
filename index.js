/**
 * Host half of move-to-workspace.
 *
 * A conversation's Workspace is fixed by the directory it started in: the
 * registry validates `SessionHeader.cwd` against the Workspace path at attach
 * time, and persisted session logs are append-only. So this plugin realises a
 * move as a **relocate**: it copies the complete event log into a brand-new
 * Session whose header points at the target Workspace, attaches that Session
 * where it belongs, archives the original, and restores the original's pinned
 * state on the copy. The browser half adds the sidebar action; this half owns
 * the operation and the one same-origin endpoint it calls.
 *
 * Two endpoints:
 * - `POST /move-to-workspace` — `{ sessionId, workspaceId }` → the moved Session.
 * - `POST /organize` — `{ mode: 'plan' }` previews a bulk organization, and
 *   `{ mode: 'apply', targets }` applies the selected workspace groups.
 */

import { randomUUID } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'

export const name = 'move-to-workspace'

export const inject = ['connection', 'webServer', 'workspaceRegistry', 'sessionPersistence', 'sessionQuery']

/** Same-origin endpoint the Client half posts to. */
const ENDPOINT = '/move-to-workspace'

/** One move request carries two identifiers. */
const MAX_BODY_BYTES = 8 * 1024

/** Same-origin endpoint that previews and applies bulk organization. */
const ORGANIZE_ENDPOINT = '/organize'

/** Organization plans may carry many session identities. */
const MAX_ORGANIZE_BODY_BYTES = 64 * 1024

/** Stored plan for a failing request; `status` travels on the wire. */
class MoveError extends Error {
  /**
   * @param {number} status - HTTP status the endpoint answers with.
   * @param {string} code - stable machine code the Client localizes.
   * @param {string} message - developer-facing explanation.
   * @param {Record<string, unknown>} [details] - extra JSON-safe fields.
   */
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'MoveError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * Register the endpoint. The operation itself runs inside the request so a
 * failure always has a response to name it.
 * @param ctx - context exposing the web server, connection, and session services.
 */
export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ENDPOINT,
      handler: (request, response) => serveMove(ctx, request, response),
    }),
  )
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ORGANIZE_ENDPOINT,
      handler: (request, response) => serveOrganize(ctx, request, response),
    }),
  )
}

/**
 * Answer one move request: admit the caller, validate the body, then move.
 * @param ctx - host context.
 * @param request - incoming HTTP request.
 * @param response - outgoing HTTP response.
 */
async function serveMove(ctx, request, response) {
  try {
    if (request.method !== 'POST') {
      respond(response, 405, failure('method-not-allowed', 'Move requests must use POST.'))
      return
    }
    if (!admitOwnerJson(ctx, request, response)) return
    let body
    try {
      body = await readJsonBody(request)
    } catch {
      respond(response, 400, failure('invalid-body', 'The request body is not valid JSON.'))
      return
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      respond(response, 400, failure('invalid-body', 'The request body must be a JSON object.'))
      return
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    if (sessionId === '' || workspaceId === '') {
      respond(response, 400, failure('invalid-body', 'Both sessionId and workspaceId are required.'))
      return
    }

    const result = await moveSession(ctx, sessionId, workspaceId)
    respond(response, 200, { ok: true, ...result })
  } catch (error) {
    if (error instanceof MoveError) {
      respond(response, error.status, failure(error.code, error.message, error.details))
      return
    }
    ctx.logger.warn(`move-to-workspace: unexpected failure: ${describeError(error)}`)
    respond(response, 500, failure('move-failed', 'Moving the conversation failed unexpectedly.'))
  }
}

/**
 * Relocate one conversation into another Workspace.
 *
 * The original is archived first, so the activity waterfall inside the
 * registry decides up front whether anything still runs. A later failure
 * restores the original; a copy that was already attached stays attached.
 *
 * @param ctx - host context.
 * @param sessionId - Session to move.
 * @param workspaceId - target Workspace identity.
 * @returns `{ sessionId, workspaceId, copied }` where `copied` is false when
 *   the Session could simply be attached because its directory is the
 *   target's directory.
 */
async function moveSession(ctx, sessionId, workspaceId) {
  const registry = ctx.workspaceRegistry
  const target = registry.get(workspaceId)
  if (target === undefined) {
    throw new MoveError(404, 'workspace-not-found', `Workspace "${workspaceId}" does not exist.`)
  }
  if (registry.archivedSessionIds.includes(sessionId)) {
    throw new MoveError(409, 'already-archived', 'This conversation is archived. Restore it before moving it.')
  }

  let snapshot
  try {
    snapshot = await ctx.sessionQuery.readSession(sessionId)
  } catch (error) {
    if (isErrorCode(error, 'SESSION_QUERY_SESSION_NOT_FOUND')) {
      throw new MoveError(404, 'session-not-found', `Conversation "${sessionId}" does not exist.`)
    }
    throw error
  }

  const source = snapshot.session
  if (source.origin === 'subagent') {
    throw new MoveError(400, 'subagent-session', 'A subagent conversation cannot be moved.')
  }
  if (snapshot.events.length === 0) {
    throw new MoveError(409, 'blank-session', 'This conversation has no history yet. Start a new conversation in the target workspace instead.')
  }
  if (typeof source.cwd !== 'string' || source.cwd === '') {
    throw new MoveError(400, 'no-origin', 'This conversation records no starting directory, so it cannot be placed in a workspace.')
  }

  const targetInfo = await stat(target.path).catch(() => undefined)
  if (targetInfo === undefined || !targetInfo.isDirectory()) {
    throw new MoveError(409, 'workspace-missing', `The target workspace directory "${target.path}" is not available.`)
  }

  const accounted = registry.list().find((workspace) => workspace.sessionIds.includes(sessionId))
  if (accounted !== undefined && accounted.id === target.id) {
    throw new MoveError(409, 'same-workspace', 'This conversation is already in that workspace.')
  }

  const sourcePath = await realpath(source.cwd).catch(() => undefined)
  if (sourcePath === target.path) {
    // The conversation already ran in the target directory: attaching the same
    // Session is exact, so no copy and no new identity are needed.
    if (accounted !== undefined) {
      throw new MoveError(409, 'same-workspace', 'This conversation already belongs to that workspace.')
    }
    try {
      await target.attachSession(sessionId)
    } catch (error) {
      throw new MoveError(409, 'move-failed', `The conversation could not be attached to that workspace: ${describeError(error)}`)
    }
    return { sessionId, workspaceId: target.id, copied: false }
  }

  const pinned = registry.pinnedSessionIds.includes(sessionId)
  try {
    await registry.archiveSession(sessionId)
  } catch (error) {
    if (isErrorName(error, 'WorkspaceActiveSessionError')) {
      throw new MoveError(409, 'session-active', 'The conversation still has running work.', {
        activity: sanitizeActivity(error.activity),
      })
    }
    if (isErrorName(error, 'WorkspaceUnknownSessionError')) {
      throw new MoveError(404, 'session-not-found', `Conversation "${sessionId}" does not exist.`)
    }
    throw error
  }

  let copy
  try {
    copy = await copySession(ctx, snapshot, target)
    await target.attachSession(copy.sessionId)
    if (pinned) {
      try {
        await registry.pinSession(copy.sessionId)
      } catch (error) {
        ctx.logger.warn(`move-to-workspace: could not restore the pin on "${copy.sessionId}": ${describeError(error)}`)
      }
    }
    announceSession(ctx, copy)
    return { sessionId: copy.sessionId, workspaceId: target.id, copied: true }
  } catch (error) {
    // The original was archived before the copy; put it back where it was.
    try {
      await registry.unarchiveSession(sessionId)
    } catch (restoreError) {
      ctx.logger.warn(`move-to-workspace: could not restore original "${sessionId}" after a failed move: ${describeError(restoreError)}`)
    }
    if (error instanceof MoveError) throw error
    const suffix = copy === undefined ? '' : ` The copied conversation is "${copy.sessionId}".`
    throw new MoveError(500, 'move-failed', `The conversation could not be copied into that workspace: ${describeError(error)}.${suffix}`, {
      ...(copy === undefined ? {} : { sessionId: copy.sessionId }),
    })
  }
}

/**
 * Rewrite the copy's self-referencing delivery markers. The DeepSeek session-log
 * plugin records `session-log-deepseek/delivery-accepted` events whose
 * `sessionId` names the Session that produced them; the Session format
 * validator rejects a current-generation marker that names another Session. A
 * faithful event copy would keep the source id, so the moved log would load as
 * corrupt. Every other field, and every occurrence of the id inside message
 * content, stays untouched as historical fact.
 *
 * @param events - complete source event log.
 * @param sourceSessionId - Session that produced the log.
 * @param targetSessionId - Session the copy belongs to.
 * @returns the events with only the source's delivery markers retargeted.
 */
export function rewriteSessionReferences(events, sourceSessionId, targetSessionId) {
  return events.map((event) => {
    if (event.type !== 'session-log-deepseek/delivery-accepted') return event
    if (event.data?.sessionId !== sourceSessionId) return event
    return { ...event, data: { ...event.data, sessionId: targetSessionId } }
  })
}

/**
 * Copy one exact logical Session log into a new Session bound to the target
 * Workspace directory, then rebuild its projection checkpoint so the new row
 * carries the copied title before it is first opened.
 *
 * @param ctx - host context.
 * @param snapshot - complete source header and log.
 * @param target - target Workspace entity.
 * @returns the created identity, its header, its events, and its projections.
 */
async function copySession(ctx, snapshot, target) {
  const source = snapshot.session
  const sessionId = `session-${randomUUID()}`
  const header = {
    version: source.version,
    id: sessionId,
    createdAt: Date.now(),
    cwd: target.path,
    ...(source.parentSession === undefined ? {} : { parentSession: source.parentSession }),
    isSeeded: source.isSeeded,
    ...(source.origin === undefined ? {} : { origin: source.origin }),
    ...(source.delegationDepth === undefined ? {} : { delegationDepth: source.delegationDepth }),
    ...(source.agentPreset === undefined ? {} : { agentPreset: source.agentPreset }),
  }
  const events = rewriteSessionReferences(snapshot.events, String(source.id), sessionId)
  const inheritedEventCount = snapshot.inheritedEventCount

  const handle = await ctx.sessionPersistence.create(header, { inheritedEventCount })
  try {
    if (events.length > 0) await handle.append(events)
    await handle.flush()
  } finally {
    try {
      await handle.close()
    } catch (error) {
      ctx.logger.warn(`move-to-workspace: closing the copied log "${sessionId}" failed: ${describeError(error)}`)
    }
  }

  let projections
  const cache = ctx.get('sessionProjectionCache')
  if (cache !== undefined) {
    try {
      projections = cache.coldSnapshot?.(header, inheritedEventCount, events)
    } catch (error) {
      ctx.logger.warn(`move-to-workspace: projection checkpoint for "${sessionId}" failed: ${describeError(error)}`)
    }
  }
  return { sessionId, header, events, projections }
}

/**
 * Announce the new Session to the connected Clients. A Session created through
 * persistence alone does not pass the Agent factory, so the session
 * controller's own `session/created` announcement never fires; the list row
 * would otherwise wait for the first open.
 *
 * @param ctx - host context.
 * @param copy - the copied Session.
 */
function announceSession(ctx, copy) {
  try {
    const last = copy.events.at(-1)
    const lastPromptAt = copy.projections?.values?.sessionListMetadata?.lastPromptAt ?? 0
    ctx.emit('api-session/added', {
      sessionId: copy.sessionId,
      updatedAt: Math.max(copy.header.createdAt, Number(lastPromptAt) || 0, last?.time ?? 0),
      agentAvailable: false,
      formatStatus: 'current',
      running: false,
      blank: false,
      cwd: copy.header.cwd,
      ...(copy.header.parentSession === undefined ? {} : { parentSessionId: copy.header.parentSession }),
      ...(copy.header.origin === undefined ? {} : { origin: copy.header.origin }),
      ...(copy.projections === undefined
        ? {}
        : {
            projections: {
              kind: 'cached',
              asOfSeq: copy.projections.asOfSeq,
              values: copy.projections.values,
            },
          }),
    })
  } catch (error) {
    ctx.logger.warn(`move-to-workspace: could not announce the moved Session: ${describeError(error)}`)
  }
}

/**
 * Keep only the JSON-safe report of what still runs, so the Client can name it.
 * @param activity - registry activity entries.
 * @returns sanitized entries.
 */
function sanitizeActivity(activity) {
  if (!Array.isArray(activity)) return []
  return activity.map((entry) => ({
    kind: typeof entry?.kind === 'string' ? entry.kind : 'activity',
    items: Array.isArray(entry?.items)
      ? entry.items.slice(0, 20).map((item) => ({
          id: typeof item?.id === 'string' ? item.id : '',
          ...(typeof item?.label === 'string' && item.label !== '' ? { label: item.label } : {}),
        }))
      : [],
  }))
}

/**
 * Admit one owner-scoped JSON request, answering the refusal itself.
 * @param ctx - host context.
 * @param request - incoming HTTP request.
 * @param response - outgoing HTTP response.
 * @returns whether the caller may continue.
 */
function admitOwnerJson(ctx, request, response) {
  const admission = ctx.connection.admit(request)
  if ('rejection' in admission) {
    const status = admission.rejection
    respond(response, status, failure(status === 401 ? 'unauthorized' : 'forbidden', status === 401 ? 'This browser is not signed in.' : 'This caller may not change conversations.'))
    return false
  }
  if (admission.peer.principal.kind !== 'owner') {
    respond(response, 403, failure('forbidden', 'Only the owner may change conversations.'))
    return false
  }
  const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    respond(response, 415, failure('unsupported-media-type', 'Requests must be JSON.'))
    return false
  }
  return true
}

/**
 * Answer one organize request. `plan` computes the preview; `apply` creates or
 * reuses the selected workspace groups and moves their conversations.
 * @param ctx - host context.
 * @param request - incoming HTTP request.
 * @param response - outgoing HTTP response.
 */
async function serveOrganize(ctx, request, response) {
  try {
    if (request.method !== 'POST') {
      respond(response, 405, failure('method-not-allowed', 'Organize requests must use POST.'))
      return
    }
    if (!admitOwnerJson(ctx, request, response)) return
    let body
    try {
      body = await readJsonBody(request, MAX_ORGANIZE_BODY_BYTES)
    } catch {
      respond(response, 400, failure('invalid-body', 'The request body is not valid JSON.'))
      return
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      respond(response, 400, failure('invalid-body', 'The request body must be a JSON object.'))
      return
    }
    if (body.mode === 'plan') {
      const plan = await planFromHost(ctx)
      respond(response, 200, { ok: true, plan })
      return
    }
    if (body.mode !== 'apply' || !Array.isArray(body.targets)) {
      respond(response, 400, failure('invalid-body', 'Use mode "plan" or mode "apply" with a targets array.'))
      return
    }
    const result = await applyOrganization(ctx, body.targets)
    respond(response, 200, { ok: true, ...result })
  } catch (error) {
    if (error instanceof MoveError) {
      respond(response, error.status, failure(error.code, error.message, error.details))
      return
    }
    ctx.logger.warn('move-to-workspace: organize failed unexpectedly: ' + describeError(error))
    respond(response, 500, failure('organize-failed', 'Organizing conversations failed unexpectedly.'))
  }
}

/**
 * Gather the live facts the planner needs and build a preview.
 * @param ctx - host context.
 * @returns the organization plan.
 */
async function planFromHost(ctx) {
  const home = homedir()
  const registry = ctx.workspaceRegistry
  const cache = ctx.get('sessionProjectionCache')
  const workspaces = registry
    .list()
    .map((workspace) => ({
      id: String(workspace.id),
      title: workspace.title,
      path: workspace.path,
      sessionIds: workspace.sessionIds.map(String),
    }))
  const accounted = new Map()
  for (const workspace of workspaces) for (const sessionId of workspace.sessionIds) accounted.set(sessionId, workspace)
  const records = await ctx.sessionQuery.listSessions()
  const sessions = []
  for (const record of records) {
    const header = record.header
    const sessionId = String(header.id)
    const cwd = typeof header.cwd === 'string' ? await realpath(header.cwd).catch(() => header.cwd) : undefined
    let title = ''
    if (cache !== undefined) {
      try {
        title = String(cache.cachedSnapshot?.(header)?.values?.title ?? '')
      } catch {
        title = ''
      }
    }
    const workspace = accounted.get(sessionId)
    sessions.push({
      sessionId,
      title,
      cwd,
      origin: header.origin ?? null,
      archived: registry.archivedSessionIds.includes(sessionId),
      workspaceId: workspace === undefined ? null : String(workspace.id),
    })
  }
  const projects = await discoverProjects(workspaces, home)
  return {
    ...planOrganization({ home, sessions, workspaces, projects }),
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Discover candidate project folders: project directories under the user's
 * GitHub folder and under every catch-all workspace (a workspace that contains
 * other registered workspaces, such as the default workspace).
 * @param workspaces - registered workspace rows.
 * @param home - user home directory.
 * @returns project candidates with display titles.
 */
async function discoverProjects(workspaces, home) {
  const catchAll = workspaces
    .filter((workspace) => workspaces.some((other) => other.id !== workspace.id && other.path.startsWith(workspace.path + '/')))
    .map((workspace) => workspace.path)
  const roots = new Set([`${home}/Developer/GitHub`, ...catchAll])
  const projects = []
  const seen = new Set()
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.slice(0, 300)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const candidate = await realpath(`${root}/${entry.name}`).catch(() => undefined)
      if (candidate === undefined || seen.has(candidate)) continue
      seen.add(candidate)
      projects.push({ path: candidate, title: entry.name })
    }
  }
  return projects
}

/** Words that carry no project identity. */
const PROJECT_STOPWORDS = new Set(['the', 'and', 'for', 'to', 'of', 'a', 'an', 'in', 'on', 'with', 'my', 'our', 'is', 'it', 'this', 'that'])
/** Directories that are containers, not projects. */
const GENERIC_DIRECTORIES = new Set(['/', '/tmp', '/private/tmp'])

/** Normalize a word for loose project-name matching. */
function normalizeProjectToken(token) {
  const lower = token.toLowerCase()
  if (lower.endsWith('ies') && lower.length > 4) return lower.slice(0, -3) + 'y'
  if (lower.endsWith('s') && lower.length > 4) return lower.slice(0, -1)
  return lower
}

/**
 * Distinct normalized words of a conversation title or folder name.
 * @param text - title or name.
 * @returns normalized word set.
 */
export function tokenizeProjectText(text) {
  const tokens = new Set()
  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || PROJECT_STOPWORDS.has(raw)) continue
    tokens.add(normalizeProjectToken(raw))
  }
  return tokens
}

/** Whether a directory is a generic container rather than a project. */
function isGenericDirectory(directory, home) {
  return directory === home || GENERIC_DIRECTORIES.has(directory)
}

/** Last path segment of a directory. */
function titleFromPath(targetPath) {
  const segments = String(targetPath).split('/').filter((segment) => segment !== '')
  return segments.at(-1) ?? targetPath
}

/**
 * Score one project candidate against a conversation title.
 * @param title - conversation title.
 * @param candidate - project path and display title.
 * @returns number of shared words, plus a bonus for the exact folder name.
 */
function projectScore(title, candidate) {
  const textTokens = tokenizeProjectText(title)
  if (textTokens.size === 0) return 0
  const nameText = (titleFromPath(candidate.path) + ' ' + String(candidate.title ?? '')).toLowerCase()
  let score = 0
  for (const token of tokenizeProjectText(nameText)) if (textTokens.has(token)) score += 1
  const normalizedName = nameText.replace(/[^a-z0-9]+/g, ' ').trim()
  const normalizedTitle = String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  if (normalizedName !== '' && normalizedTitle.includes(normalizedName)) score += 3
  return score
}

/**
 * Best unambiguous project for one conversation title.
 * @param title - conversation title.
 * @param candidates - project candidates.
 * @param excludedPaths - project paths that are not valid targets for this session.
 * @returns the winning candidate, or undefined for no match and for ties.
 */
function bestProjectMatch(title, candidates, excludedPaths) {
  const scored = candidates
    .filter((candidate) => !excludedPaths.has(candidate.path))
    .map((candidate) => ({ candidate, score: projectScore(title, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
  if (scored.length === 0) return undefined
  const top = scored.filter((entry) => entry.score === scored[0].score)
  return new Set(top.map((entry) => entry.candidate.path)).size === 1 ? scored[0].candidate : undefined
}

/**
 * Build the organization preview. Pure: the caller supplies sessions, existing
 * workspaces, and discovered project folders, so every rule is testable.
 * @param input - home directory, sessions, workspaces, and project candidates.
 * @returns workspace groups to create/reuse, sessions that stay put, and counts.
 */
export function planOrganization(input) {
  const home = input.home
  const sessions = input.sessions
  const workspaces = input.workspaces
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
  const catchAllPaths = new Set(
    workspaces
      .filter((workspace) => workspaces.some((other) => other.id !== workspace.id && other.path.startsWith(workspace.path + '/')))
      .map((workspace) => workspace.path),
  )
  const candidates = []
  const seenCandidates = new Set()
  for (const candidate of [...input.projects, ...workspaces]) {
    if (typeof candidate.path !== 'string' || seenCandidates.has(candidate.path)) continue
    if (catchAllPaths.has(candidate.path) || isGenericDirectory(candidate.path, home)) continue
    seenCandidates.add(candidate.path)
    candidates.push({ path: candidate.path, title: String(candidate.title ?? titleFromPath(candidate.path)) })
  }
  const groups = new Map()
  const stays = []
  const addSession = (target, session, mode) => {
    const existing = workspaceByPath.get(target.path)
    const group = groups.get(target.path) ?? {
      path: target.path,
      title: existing === undefined ? (target.title ?? titleFromPath(target.path)) : existing.title,
      workspaceId: existing === undefined ? null : String(existing.id),
      action: existing === undefined ? 'create' : 'reuse',
      sessions: [],
    }
    group.sessions.push({
      sessionId: session.sessionId,
      title: session.title ?? '',
      cwd: session.cwd ?? null,
      mode,
      currentWorkspace: session.workspaceId === null || session.workspaceId === undefined
        ? null
        : { id: session.workspaceId, title: workspaceById.get(session.workspaceId)?.title ?? null },
    })
    groups.set(target.path, group)
  }
  const eligible = sessions.filter((session) => session.archived !== true && session.origin !== 'subagent')
  for (const session of eligible) {
    if (typeof session.cwd !== 'string' || session.cwd === '') {
      stays.push({ sessionId: session.sessionId, title: session.title ?? '', reason: 'no-folder' })
      continue
    }
    const cwd = session.cwd
    const current = session.workspaceId === null || session.workspaceId === undefined ? undefined : workspaceById.get(session.workspaceId)
    if (current !== undefined && current.path === cwd) {
      if (!catchAllPaths.has(current.path)) {
        stays.push({ sessionId: session.sessionId, title: session.title ?? '', reason: 'already-grouped', workspace: current.title })
        continue
      }
      const match = bestProjectMatch(session.title ?? '', candidates, new Set([cwd, ...catchAllPaths]))
      if (match === undefined) {
        stays.push({ sessionId: session.sessionId, title: session.title ?? '', reason: 'no-project-match', workspace: current.title })
        continue
      }
      addSession(match, session, 'move')
      continue
    }
    if (!isGenericDirectory(cwd, home)) {
      addSession(workspaceByPath.get(cwd) ?? { path: cwd, title: titleFromPath(cwd) }, session, 'attach')
      continue
    }
    const match = bestProjectMatch(session.title ?? '', candidates, new Set(catchAllPaths))
    if (match === undefined) {
      stays.push({ sessionId: session.sessionId, title: session.title ?? '', reason: 'generic-folder' })
      continue
    }
    addSession(match, session, 'move')
  }
  const targets = [...groups.values()]
    .map((group) => ({ ...group, sessions: group.sessions.sort((left, right) => String(left.title).localeCompare(String(right.title))) }))
    .sort((left, right) => {
      if (left.action !== right.action) return left.action === 'create' ? -1 : 1
      return right.sessions.length - left.sessions.length || left.title.localeCompare(right.title)
    })
  const moves = targets.reduce((sum, group) => sum + group.sessions.length, 0)
  return {
    targets,
    stays,
    summary: {
      considered: eligible.length,
      moves,
      targets: targets.length,
      create: targets.filter((group) => group.action === 'create').length,
      reuse: targets.filter((group) => group.action === 'reuse').length,
      stays: stays.length,
    },
  }
}

/**
 * Apply the selected workspace groups: register each folder, then move every
 * selected conversation with the same archive-copy-attach operation as the
 * single-conversation endpoint. Failures stay isolated per conversation.
 * @param ctx - host context.
 * @param targets - selected `{ path, sessionIds }` groups.
 * @returns per-workspace and per-session results.
 */
async function applyOrganization(ctx, targets) {
  const registry = ctx.workspaceRegistry
  const workingDirectoryResults = []
  const sessionResults = []
  for (const target of targets) {
    if (target === null || typeof target !== 'object' || typeof target.path !== 'string' || !Array.isArray(target.sessionIds)) {
      workingDirectoryResults.push({ path: null, ok: false, error: 'invalid-target' })
      continue
    }
    const canonical = await realpath(target.path).catch(() => undefined)
    if (canonical === undefined) {
      workingDirectoryResults.push({ path: target.path, ok: false, error: 'missing-folder' })
      continue
    }
    const info = await stat(canonical).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) {
      workingDirectoryResults.push({ path: target.path, ok: false, error: 'not-a-directory' })
      continue
    }
    const existed = registry.list().some((workspace) => workspace.path === canonical)
    let workspace
    try {
      workspace = await registry.create(canonical)
    } catch (error) {
      workingDirectoryResults.push({ path: canonical, ok: false, error: describeError(error) })
      continue
    }
    workingDirectoryResults.push({ path: canonical, ok: true, workspaceId: String(workspace.id), title: workspace.title, created: !existed })
    for (const sessionId of target.sessionIds) {
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (workspace.sessionIds.includes(sessionId)) {
        sessionResults.push({ workspaceId: String(workspace.id), sessionId, ok: true, alreadyInPlace: true })
        continue
      }
      try {
        const result = await moveSession(ctx, sessionId, String(workspace.id))
        sessionResults.push({ workspaceId: String(workspace.id), sessionId, ok: true, ...result })
      } catch (error) {
        sessionResults.push({
          workspaceId: String(workspace.id),
          sessionId,
          ok: false,
          code: error instanceof MoveError ? error.code : 'move-failed',
          error: describeError(error),
        })
      }
    }
  }
  return { workspaces: workingDirectoryResults, sessions: sessionResults }
}

/**
 * Answer one JSON failure.
 * @param code - machine-readable failure code.
 * @param message - developer-facing explanation.
 * @param details - extra JSON-safe fields.
 * @returns the response payload.
 */
function failure(code, message, details = {}) {
  return { ok: false, code, message, ...details }
}

/** Write one JSON response once. */
function respond(response, status, payload) {
  if (response.writableEnded || response.headersSent === true) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Read and bound one JSON request body.
 * @param request - incoming request.
 * @returns the parsed body.
 */
function readJsonBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      request.resume?.()
      reject(error)
    }
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(new Error('body-too-large'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', fail)
    request.on('aborted', () => fail(new Error('request-aborted')))
    request.on('close', () => fail(new Error('request-closed')))
  })
}

/** Whether one failure carries an exact name. */
function isErrorName(error, name) {
  return error instanceof Error && error.name === name
}

/** Whether one failure carries an exact stable code. */
function isErrorCode(error, code) {
  return error !== null && typeof error === 'object' && error.code === code
}

/** Short description of a failure for logs and response messages. */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}
