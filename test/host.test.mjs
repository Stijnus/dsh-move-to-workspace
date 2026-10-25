import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'

function fakeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writableEnded: false,
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(body) {
      this.body = body
      this.writableEnded = true
    },
  }
}

function captureRoute({ admit = () => ({ rejection: 401 }), ...services } = {}) {
  let route
  const routes = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register(value) {
        routes.push(value)
        if (value.path === '/move-to-workspace') route = value
        return () => {}
      },
    },
    connection: { admit },
    logger: { warn() {} },
    ...services,
  }
  plugin.apply(ctx)
  route.routes = routes
  return route
}

function request(method, contentType, body) {
  const req = new EventEmitter()
  req.method = method
  req.headers = contentType === undefined ? {} : { 'content-type': contentType }
  req.resume = () => {}
  return { req, emit: () => {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  } }
}

test('exports the Harness plugin contract', () => {
  assert.equal(plugin.name, 'move-to-workspace')
  assert.equal(typeof plugin.apply, 'function')
  for (const service of ['connection', 'webServer', 'workspaceRegistry', 'sessionPersistence', 'sessionQuery']) {
    assert.ok(plugin.inject.includes(service), `inject includes ${service}`)
  }
})

test('rewriteSessionReferences retargets only the moved Session delivery marker', () => {
  const events = [
    { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'session-old stays quoted here' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2, data: { sessionId: 'session-old', sessionFormatVersion: 4, throughSeq: 0 } },
    { type: 'session-log-deepseek/delivery-accepted', seq: 2, time: 3, data: { sessionId: 'session-ancestor', sessionFormatVersion: 4, throughSeq: 1 } },
  ]
  const rewritten = plugin.rewriteSessionReferences(events, 'session-old', 'session-new')
  assert.equal(rewritten[0], events[0])
  assert.equal(rewritten[0].data.content[0].text, 'session-old stays quoted here')
  assert.equal(rewritten[1].data.sessionId, 'session-new')
  assert.equal(rewritten[1].seq, 1)
  assert.equal(rewritten[1].data.throughSeq, 0)
  assert.equal(rewritten[2].data.sessionId, 'session-ancestor')
  assert.equal(events[1].data.sessionId, 'session-old')
})

test('planOrganization groups by project folder and infers from titles', () => {
  const home = '/home/u'
  const workspaces = [
    { id: 'w1', title: 'default-workspace', path: '/home/u/dev/default-workspace' },
    { id: 'w2', title: 'composer-predictions', path: '/home/u/dev/default-workspace/composer-predictions' },
    { id: 'w3', title: 'werfregistratie-demo', path: '/home/u/GitHub/werfregistratie-demo' },
  ]
  const projects = [
    { path: '/home/u/dev/default-workspace/composer-predictions', title: 'composer-predictions' },
    { path: '/home/u/GitHub/dsh-moodboard', title: 'dsh-moodboard' },
    { path: '/home/u/GitHub/werfregistratie-demo', title: 'werfregistratie-demo' },
  ]
  const sessions = [
    { sessionId: 's1', title: 'Composer predictions tab completion', cwd: '/home/u/dev/default-workspace', origin: null, archived: false, workspaceId: 'w1' },
    { sessionId: 's2', title: 'DSH moodboard plugin for agent style guides', cwd: '/home/u/dev/default-workspace', origin: null, archived: false, workspaceId: 'w1' },
    { sessionId: 's3', title: 'Frontend review', cwd: '/home/u/GitHub/werfregistratie-demo', origin: null, archived: false, workspaceId: 'w3' },
    { sessionId: 's4', title: 'New project chat', cwd: '/home/u/GitHub/new-project', origin: null, archived: false, workspaceId: null },
    { sessionId: 's5', title: 'home chatter', cwd: '/home/u', origin: null, archived: false, workspaceId: null },
    { sessionId: 's6', title: 'subagent child', cwd: '/home/u/dev/default-workspace', origin: 'subagent', archived: false, workspaceId: null },
    { sessionId: 's7', title: 'Archived composer chat', cwd: '/home/u/dev/default-workspace', origin: null, archived: true, workspaceId: 'w1' },
    { sessionId: 's8', title: 'Plugin notes', cwd: '/home/u/dev/default-workspace', origin: null, archived: false, workspaceId: 'w1' },
  ]
  const plan = plugin.planOrganization({ home, sessions, workspaces, projects })
  assert.equal(plan.summary.considered, 6)
  const byPath = Object.fromEntries(plan.targets.map((target) => [target.path, target]))
  const composer = byPath['/home/u/dev/default-workspace/composer-predictions']
  assert.ok(composer, 'composer target present')
  assert.equal(composer.action, 'reuse')
  assert.deepEqual(composer.sessions.map((session) => [session.sessionId, session.mode]), [['s1', 'move']])
  const moodboard = byPath['/home/u/GitHub/dsh-moodboard']
  assert.ok(moodboard, 'moodboard target present')
  assert.equal(moodboard.action, 'create')
  assert.deepEqual(moodboard.sessions.map((session) => [session.sessionId, session.mode]), [['s2', 'move']])
  const fresh = byPath['/home/u/GitHub/new-project']
  assert.ok(fresh, 'folder without a workspace becomes a create target')
  assert.deepEqual(fresh.sessions.map((session) => [session.sessionId, session.mode]), [['s4', 'attach']])
  const stayIds = plan.stays.map((entry) => entry.sessionId)
  assert.ok(stayIds.includes('s3'), 'already grouped conversation stays')
  assert.ok(stayIds.includes('s5'), 'generic home folder stays')
  assert.ok(!stayIds.includes('s6') && !stayIds.includes('s7'), 'subagent and archived conversations are excluded')
  for (const target of plan.targets) {
    assert.notEqual(target.path, '/home/u/dev/default-workspace', 'a catch-all workspace is never a target')
  }
})

test('tokenizeProjectText normalizes plural words and drops glue words', () => {
  const tokens = plugin.tokenizeProjectText('DSH plugin for conversation workspaces')
  assert.ok(tokens.has('conversation'))
  assert.ok(tokens.has('workspace'))
  assert.ok(!tokens.has('for'))
})

test('registers the move and organize endpoints', () => {
  const route = captureRoute()
  assert.deepEqual(route.routes.map((candidate) => [candidate.kind, candidate.path]), [
    ['exact', '/move-to-workspace'],
    ['exact', '/organize'],
    ['exact', '/delete-session'],
  ])
  assert.equal(typeof route.handler, 'function')
  assert.equal(typeof route.routes[1].handler, 'function')
  assert.equal(typeof route.routes[2].handler, 'function')
})

test('refuses an unauthenticated call before reading the body', async () => {
  const route = captureRoute()
  const { req } = request('POST', 'application/json', '{}')
  const res = fakeResponse()
  await route.handler(req, res)
  assert.equal(res.status, 401)
  assert.equal(JSON.parse(res.body).code, 'unauthorized')
})

test('refuses non-POST methods', async () => {
  const route = captureRoute()
  const { req } = request('GET')
  const res = fakeResponse()
  await route.handler(req, res)
  assert.equal(res.status, 405)
  assert.equal(JSON.parse(res.body).code, 'method-not-allowed')
})

test('refuses a non-JSON body from the owner', async () => {
  const route = captureRoute({ admit: () => ({ peer: { principal: { kind: 'owner' } } }) })
  const { req } = request('POST', 'text/plain', '{}')
  const res = fakeResponse()
  await route.handler(req, res)
  assert.equal(res.status, 415)
  assert.equal(JSON.parse(res.body).code, 'unsupported-media-type')
})

test('rejects a JSON body without both identifiers', async () => {
  const route = captureRoute({ admit: () => ({ peer: { principal: { kind: 'owner' } } }) })
  const { req, emit } = request('POST', 'application/json', '{}')
  const res = fakeResponse()
  const pending = route.handler(req, res)
  emit()
  await pending
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).code, 'invalid-body')
})

test('refuses a non-owner principal', async () => {
  const route = captureRoute({ admit: () => ({ peer: { principal: { kind: 'peer' } } }) })
  const { req } = request('POST', 'application/json', '{}')
  const res = fakeResponse()
  await route.handler(req, res)
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).code, 'forbidden')
})

for (const failureAt of [null, 'append', 'flush', 'attach', 'archive', 'changed', 'active']) {
  test(`move preserves the original until the copy is durable: ${failureAt ?? 'success'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-move-test-'))
    try {
      const targetPath = join(root, 'target')
      await mkdir(targetPath)
      const calls = []
      let reads = 0
      const step = async (name) => {
        calls.push(name)
        if (failureAt === name) throw new Error(`failed ${name}`)
      }
      const target = { id: 'target', path: targetPath, sessionIds: [], attachSession: () => step('attach') }
      const route = captureRoute({
        admit: () => ({ peer: { principal: { kind: 'owner' } } }),
        waterfall: async () => failureAt === 'active' ? [{ kind: 'turn' }] : [],
        get: () => undefined,
        workspaceRegistry: {
          get: () => target, list: () => [], archivedSessionIds: [], pinnedSessionIds: [],
          archiveSession: () => step('archive'),
        },
        sessionQuery: { readSession: async () => ({
          session: { id: 'source', version: 0, cwd: root, createdAt: 1 },
          inheritedEventCount: 0,
          events: failureAt === 'changed' && reads++ > 0 ? [{ seq: 1 }, { seq: 2 }] : [{ seq: 1 }],
        }) },
        sessionPersistence: { create: async () => {
          await step('create')
          return { append: () => step('append'), flush: () => step('flush'), close: () => step('close') }
        } },
      })
      const { req, emit } = request('POST', 'application/json', JSON.stringify({ sessionId: 'source', workspaceId: 'target' }))
      const res = fakeResponse()
      const pending = route.handler(req, res)
      emit()
      await pending
      if (failureAt === null) {
        assert.equal(res.status, 200)
        assert.deepEqual(calls, ['create', 'append', 'flush', 'close', 'attach', 'archive'])
      } else {
        assert.notEqual(res.status, 200)
        if (failureAt !== 'archive') assert.ok(!calls.includes('archive'))
        if (failureAt === 'active') assert.deepEqual(calls, [])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('planOrganization treats a symlinked workspace path and its target as one workspace', () => {
  const real = '/home/u/Developer/GitHub/Plugins/dsh-moodboard'
  const workspaces = [{ id: 'w1', title: 'dsh-moodboard', path: '/home/u/Developer/GitHub/dsh-moodboard', realPath: real }]
  const projects = [{ path: real, title: 'dsh-moodboard' }]
  const sessions = [
    { sessionId: 's1', title: 'Moodboard work', cwd: real, origin: null, archived: false, workspaceId: 'w1' },
  ]
  const plan = plugin.planOrganization({ home: '/home/u', sessions, workspaces, projects })
  assert.equal(plan.summary.create, 0, 'a folder that is already registered under another spelling is never a create target')
  assert.equal(plan.summary.targets, 0)
  assert.deepEqual(plan.stays.map((entry) => [entry.sessionId, entry.reason]), [['s1', 'already-grouped']])
})

test('planOrganization reuses the workspace registered under the symlink spelling', () => {
  const real = '/home/u/Developer/GitHub/Plugins/dsh-moodboard'
  const workspaces = [{ id: 'w1', title: 'dsh-moodboard', path: '/home/u/Developer/GitHub/dsh-moodboard', realPath: real }]
  const projects = [{ path: real, title: 'dsh-moodboard' }]
  const sessions = [
    { sessionId: 's1', title: 'Moodboard work', cwd: real, origin: null, archived: false, workspaceId: null },
  ]
  const plan = plugin.planOrganization({ home: '/home/u', sessions, workspaces, projects })
  assert.deepEqual(
    plan.targets.map((target) => [target.path, target.action, target.workspaceId]),
    [['/home/u/Developer/GitHub/dsh-moodboard', 'reuse', 'w1']],
    'the registered spelling is reused instead of creating a second workspace',
  )
})

test('applying a target for an already registered folder reuses it instead of creating a duplicate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-symlink-'))
  try {
    const real = join(root, 'real')
    const link = join(root, 'link')
    await mkdir(real)
    await symlink(real, link)
    let createCalls = 0
    const existing = { id: 'w1', title: 'real', path: link, sessionIds: [], detachSession: async () => {} }
    const route = captureRoute({
      admit: () => ({ peer: { principal: { kind: 'owner' } } }),
      workspaceRegistry: {
        get: () => existing,
        list: () => [existing],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        create: async (path) => { createCalls += 1; return { id: 'new', title: 'real', path, sessionIds: [] } },
      },
    })
    const organize = route.routes.find((candidate) => candidate.path === '/organize')
    const { req, emit } = request('POST', 'application/json', JSON.stringify({ mode: 'apply', targets: [{ path: link, sessionIds: [] }] }))
    const res = fakeResponse()
    const pending = organize.handler(req, res)
    emit()
    await pending
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(createCalls, 0, 'no second workspace is registered for the same folder')
    assert.equal(body.workspaces[0].workspaceId, 'w1')
    assert.equal(body.workspaces[0].created, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a workspace that adopts an already accounted session releases it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-adopt-'))
  try {
    const folder = join(root, 'fresh')
    await mkdir(folder)
    const detached = []
    const created = { id: 'new', title: 'fresh', path: folder, sessionIds: ['s1'], detachSession: async (sessionId) => { detached.push(sessionId) } }
    const owner = { id: 'w1', title: 'default-workspace', path: root, sessionIds: ['s1'], detachSession: async () => {} }
    const route = captureRoute({
      admit: () => ({ peer: { principal: { kind: 'owner' } } }),
      workspaceRegistry: {
        get: () => undefined,
        list: () => [owner],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        create: async () => created,
      },
    })
    const organize = route.routes.find((candidate) => candidate.path === '/organize')
    const { req, emit } = request('POST', 'application/json', JSON.stringify({ mode: 'apply', targets: [{ path: folder, sessionIds: [] }] }))
    const res = fakeResponse()
    const pending = organize.handler(req, res)
    emit()
    await pending
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).workspaces[0].created, true)
    assert.deepEqual(detached, ['s1'], 'the adopted session keeps its original single owner')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
