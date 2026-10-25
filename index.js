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
 * One endpoint:
 * - `POST /move-to-workspace` — `{ sessionId, workspaceId }` → the moved Session.
 */

import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'

export const name = 'move-to-workspace'

export const inject = ['connection', 'webServer', 'workspaceRegistry', 'sessionPersistence', 'sessionQuery']

/** Same-origin endpoint the Client half posts to. */
const ENDPOINT = '/move-to-workspace'

/** One request carries two identifiers. */
const MAX_BODY_BYTES = 8 * 1024

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
    const admission = ctx.connection.admit(request)
    if ('rejection' in admission) {
      const status = admission.rejection
      respond(response, status, failure(status === 401 ? 'unauthorized' : 'forbidden', status === 401 ? 'This browser is not signed in.' : 'This caller may not move conversations.'))
      return
    }
    if (admission.peer.principal.kind !== 'owner') {
      respond(response, 403, failure('forbidden', 'Only the owner may move conversations.'))
      return
    }
    const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      respond(response, 415, failure('unsupported-media-type', 'Move requests must be JSON.'))
      return
    }
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
function readJsonBody(request) {
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
      if (size > MAX_BODY_BYTES) {
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
