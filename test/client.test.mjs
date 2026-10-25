import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const WORKSPACES = {
  items: [
    { workspaceId: 'w1', title: 'Target', path: '/tmp/target', sessionIds: [] },
    { workspaceId: 'w2', title: 'Second', path: '/tmp/second', sessionIds: [] },
  ],
  archivedSessionIds: [],
  pinnedSessionIds: [],
}

function loadClient() {
  const registrations = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect() {},
    useRef() {
      return { current: null }
    },
  }
  let definition
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  vm.runInNewContext(source, {
    window,
    document: undefined,
    fetch: () => Promise.reject(new Error('offline')),
    AbortController,
    console,
    setTimeout,
    clearTimeout,
  })
  const module = definition.factory((name) => (name === 'react' ? react : {}))
  const ctx = {
    locale: { bind: () => (key) => key, register() {} },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    get(key) {
      if (key === 'uiWorkspace') return { pickDirectory: async () => null, openSession() {} }
      if (key === 'workspaces') return { create: async () => ({ workspaceId: 'w3', sessionIds: [] }) }
      return undefined
    },
  }
  module.apply(ctx)
  return { registrations, react }
}

function slotProps(overrides = {}) {
  return {
    useWorkspaces: (selector) => selector(WORKSPACES),
    t: (key) => key,
    onMoved() {},
    pickDirectory: async () => null,
    createWorkspace: async () => ({ workspaceId: 'w3', sessionIds: [] }),
    ...overrides,
  }
}

function called(node) {
  let current = node
  while (typeof current?.type === 'function') current = current.type(current.props)
  return current
}

function textOf(node) {
  if (node === undefined || node === null || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textOf)
  return textOf(node.children)
}

test('registers the session-row action and the dialog overlay', () => {
  const { registrations } = loadClient()
  const menu = registrations.find((entry) => entry.spec.id === 'move-to-workspace')
  assert.ok(menu, 'menu registration exists')
  assert.equal(menu.spec.name, 'sidebar.workspaces.session.menu.item')
  assert.equal(menu.spec.order, 350)
  const overlay = registrations.find((entry) => entry.spec.id === 'move-to-workspace.dialog')
  assert.ok(overlay, 'overlay registration exists')
  assert.equal(overlay.spec.name, 'shell.overlay')
})

test('the menu row is offered for ordinary rows and hidden for archived rows', () => {
  const { registrations } = loadClient()
  const menu = registrations.find((entry) => entry.spec.id === 'move-to-workspace').component
  const row = called(menu({ sessionId: 's1', displayTitle: 'Row', useMenuOpenState: () => [false, () => {}], ...slotProps() }))
  assert.equal(row.type, 'button')
  assert.equal(row.props.role, 'menuitem')
  const archived = menu({
    sessionId: 's1',
    displayTitle: 'Row',
    useMenuOpenState: () => [false, () => {}],
    ...slotProps({ useWorkspaces: (selector) => selector({ ...WORKSPACES, archivedSessionIds: ['s1'] }) }),
  })
  assert.equal(archived, null)
})

test('clicking the row opens a dialog that can register a new workspace', () => {
  const { registrations } = loadClient()
  const menu = registrations.find((entry) => entry.spec.id === 'move-to-workspace').component
  const overlay = registrations.find((entry) => entry.spec.id === 'move-to-workspace.dialog').component
  const row = called(menu({ sessionId: 's1', displayTitle: 'Row', useMenuOpenState: () => [false, () => {}], ...slotProps() }))
  row.props.onClick()
  const tree = called(overlay(slotProps()))
  const text = textOf(tree)
  assert.ok(text.includes('dialog.create'), 'create-workspace row is rendered')
  assert.ok(text.includes('confirm'), 'confirm button is rendered')
  assert.ok(text.includes('Target'), 'existing workspace is listed')
})
