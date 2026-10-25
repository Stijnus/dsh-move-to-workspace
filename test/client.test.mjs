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

test('registers the session-row actions and both dialog overlays', () => {
  const { registrations } = loadClient()
  const menu = registrations.find((entry) => entry.spec.id === 'move-to-workspace')
  assert.ok(menu, 'move menu registration exists')
  assert.equal(menu.spec.name, 'sidebar.workspaces.session.menu.item')
  assert.equal(menu.spec.order, 350)
  const organize = registrations.find((entry) => entry.spec.id === 'organize-conversations')
  assert.ok(organize, 'organize menu registration exists')
  assert.equal(organize.spec.name, 'sidebar.workspaces.session.menu.item')
  assert.equal(organize.spec.order, 40)
  const overlay = registrations.find((entry) => entry.spec.id === 'move-to-workspace.dialog')
  assert.ok(overlay, 'move overlay registration exists')
  assert.equal(overlay.spec.name, 'shell.overlay')
  const organizeOverlay = registrations.find((entry) => entry.spec.id === 'move-to-workspace.organize')
  assert.ok(organizeOverlay, 'organize overlay registration exists')
  assert.equal(organizeOverlay.spec.name, 'shell.overlay')
  const deleteRow = registrations.find((entry) => entry.spec.id === 'delete-conversation')
  assert.ok(deleteRow, 'delete menu registration exists')
  assert.equal(deleteRow.spec.name, 'sidebar.workspaces.session.menu.item')
  assert.equal(deleteRow.spec.order, 410)
  const deleteOverlay = registrations.find((entry) => entry.spec.id === 'move-to-workspace.delete')
  assert.ok(deleteOverlay, 'delete overlay registration exists')
  assert.equal(deleteOverlay.spec.name, 'shell.overlay')
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

test('the organize action opens a preview dialog', () => {
  const { registrations } = loadClient()
  const menu = registrations.find((entry) => entry.spec.id === 'organize-conversations').component
  const overlay = registrations.find((entry) => entry.spec.id === 'move-to-workspace.organize').component
  const row = called(menu({ sessionId: 's1', displayTitle: 'Row', useMenuOpenState: () => [false, () => {}], ...slotProps() }))
  assert.equal(row.type, 'button')
  assert.equal(row.props.role, 'menuitem')
  row.props.onClick()
  const tree = called(overlay(slotProps()))
  const text = textOf(tree)
  assert.ok(text.includes('organize.title'), 'dialog title is rendered')
  assert.ok(text.includes('organize.loading'), 'dialog starts by loading the plan')
})

test('the delete action asks for confirmation before removing anything', () => {
  const { registrations } = loadClient()
  const menu = registrations.find((entry) => entry.spec.id === 'delete-conversation').component
  const overlay = registrations.find((entry) => entry.spec.id === 'move-to-workspace.delete').component
  let fetchCalls = 0
  const row = called(menu({ sessionId: 's1', displayTitle: 'Delete me', useMenuOpenState: () => [false, () => {}], ...slotProps() }))
  assert.equal(row.type, 'button')
  assert.equal(row.props.role, 'menuitem')
  row.props.onClick()
  const tree = called(overlay(slotProps()))
  const text = textOf(tree)
  assert.ok(text.includes('delete.title'), 'confirmation title is rendered')
  assert.ok(text.includes('delete.warning'), 'destructive warning is rendered')
  assert.ok(text.includes('delete.confirm'), 'confirm button is rendered')
  assert.ok(text.includes('delete.description'), 'conversation description is rendered')
  assert.equal(fetchCalls, 0, 'nothing is requested before confirmation')
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
