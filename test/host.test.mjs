import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
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

function captureRoute({ admit = () => ({ rejection: 401 }) } = {}) {
  let route
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register(value) {
        route = value
        return () => {}
      },
    },
    connection: { admit },
    logger: { warn() {} },
  }
  plugin.apply(ctx)
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

test('registers one exact endpoint', () => {
  const route = captureRoute()
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/move-to-workspace')
  assert.equal(typeof route.handler, 'function')
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
