/**
 * Browser half of move-to-workspace.
 *
 * One Session row action in the sidebar's "..." menu opens a picker of the
 * other Workspaces and posts the chosen target to the Host. The Host copies
 * the transcript into a new conversation bound to that Workspace and archives
 * the original; the Client then opens the moved conversation.
 *
 * The dialog writes its own markup and styles from Harness theme tokens so it
 * does not depend on shipped Client packages that can change between builds.
 */

window.__ModuleLoader__.load({
  id: 'dsh-move-to-workspace',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'move-to-workspace'
    const ENDPOINT = '/move-to-workspace'
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const OVERLAY_SLOT = 'shell.overlay'
    const MENU_ORDER = 350

    const DICTIONARIES = {
      en: {
        'menu.label': 'Move to workspace…',
        'dialog.title': 'Move to workspace',
        'dialog.description':
          'Copy “{title}” into another workspace. It continues there as a new conversation; the original is archived and can be restored.',
        'dialog.untitled': 'this conversation',
        'dialog.target': 'Target workspace',
        'dialog.empty': 'There is no other workspace yet. Create one below.',
        'dialog.create': 'New workspace…',
        'dialog.createBusy': 'Choosing folder…',
        'dialog.copyNote': 'The full history and title are kept. The moved conversation gets a new session ID.',
        'dialog.close': 'Close',
        cancel: 'Cancel',
        confirm: 'Move',
        moving: 'Moving…',
        'error.unauthorized': 'This browser is not signed in to the harness.',
        'error.forbidden': 'This caller may not move conversations.',
        'error.invalid': 'The move request was rejected as invalid.',
        'error.sessionNotFound': 'That conversation no longer exists.',
        'error.workspaceNotFound': 'That workspace no longer exists.',
        'error.noOrigin': 'This conversation records no starting directory, so it cannot be placed in a workspace.',
        'error.subagent': 'A subagent conversation cannot be moved.',
        'error.blank': 'This conversation has no history yet.',
        'error.archived': 'This conversation is archived. Restore it first.',
        'error.sameWorkspace': 'This conversation is already in that workspace.',
        'error.workspaceMissing': 'The target workspace folder is not available.',
        'error.noPicker': 'This build cannot open a folder picker, so a workspace cannot be created here.',
        'error.createWorkspace': 'The folder could not be added as a workspace.',
        'error.newWorkspaceIsCurrent': 'That folder is already this conversation\u2019s workspace.',
        'error.failed': 'The conversation could not be moved.',
        'error.unknown': 'The conversation could not be moved.',
        'error.network': 'The harness could not be reached. Try again.',
        'error.sessionActive':
          'The conversation still has running work: {activity}. Stop it, then try again.',
        'error.sessionActivePlain': 'The conversation still has running work. Stop it, then try again.',
        'activity.turn': 'a running turn',
        'activity.subagent': 'running subagents',
        'activity.job': 'background jobs',
        'activity.schedule': 'scheduled tasks',
      },
      zh: {
        'menu.label': '移动到工作区…',
        'dialog.title': '移动到工作区',
        'dialog.description': '将“{title}”复制到另一个工作区。它会在那里作为新会话继续，原会话会被归档并可恢复。',
        'dialog.untitled': '此会话',
        'dialog.target': '目标工作区',
        'dialog.empty': '还没有其他工作区。可在下方新建一个。',
        'dialog.create': '新建工作区…',
        'dialog.createBusy': '正在选择文件夹…',
        'dialog.copyNote': '完整历史与标题会保留，移动后的会话会获得新的会话 ID。',
        'dialog.close': '关闭',
        cancel: '取消',
        confirm: '移动',
        moving: '正在移动…',
        'error.unauthorized': '当前浏览器尚未登录 Harness。',
        'error.forbidden': '当前调用方无权移动会话。',
        'error.invalid': '移动请求无效，已被拒绝。',
        'error.sessionNotFound': '该会话已不存在。',
        'error.workspaceNotFound': '该工作区已不存在。',
        'error.noOrigin': '该会话没有记录起始目录，无法放入工作区。',
        'error.subagent': '子代理会话无法移动。',
        'error.blank': '该会话还没有历史记录。',
        'error.archived': '该会话已归档，请先恢复。',
        'error.sameWorkspace': '该会话已在目标工作区中。',
        'error.workspaceMissing': '目标工作区文件夹不可用。',
        'error.noPicker': '此构建无法打开文件夹选择器，因此无法在此新建工作区。',
        'error.createWorkspace': '该文件夹无法添加为工作区。',
        'error.newWorkspaceIsCurrent': '该文件夹已经是此会话所在的工作区。',
        'error.failed': '无法移动该会话。',
        'error.unknown': '无法移动该会话。',
        'error.network': '无法连接到 Harness，请重试。',
        'error.sessionActive': '该会话仍有运行中的工作：{activity}。请先停止后再试。',
        'error.sessionActivePlain': '该会话仍有运行中的工作。请先停止后再试。',
        'activity.turn': '运行中的回合',
        'activity.subagent': '运行中的子代理',
        'activity.job': '后台任务',
        'activity.schedule': '定时任务',
      },
    }

    const ERROR_KEYS = {
      unauthorized: 'error.unauthorized',
      forbidden: 'error.forbidden',
      'invalid-body': 'error.invalid',
      'unsupported-media-type': 'error.invalid',
      'method-not-allowed': 'error.invalid',
      'session-not-found': 'error.sessionNotFound',
      'workspace-not-found': 'error.workspaceNotFound',
      'no-origin': 'error.noOrigin',
      'subagent-session': 'error.subagent',
      'blank-session': 'error.blank',
      'already-archived': 'error.archived',
      'same-workspace': 'error.sameWorkspace',
      'workspace-missing': 'error.workspaceMissing',
      'move-failed': 'error.failed',
    }

    const ACTIVITY_KEYS = {
      turn: 'activity.turn',
      subagent: 'activity.subagent',
      job: 'activity.job',
      schedule: 'activity.schedule',
    }

    // The menu unmounts with its popup, so the dialog request lives at module
    // scope and the shell overlay entry renders it.
    let moveRequest = null
    const requestListeners = new Set()

    function openMoveDialog(sessionId, displayTitle) {
      moveRequest = { sessionId, displayTitle, nonce: `${Date.now()}-${Math.random()}` }
      for (const listener of requestListeners) listener(moveRequest)
    }

    function closeMoveDialog() {
      moveRequest = null
      for (const listener of requestListeners) listener(null)
    }

    function useMoveRequest() {
      const [current, setCurrent] = React.useState(moveRequest)
      React.useEffect(() => {
        requestListeners.add(setCurrent)
        setCurrent(moveRequest)
        return () => {
          requestListeners.delete(setCurrent)
        }
      }, [])
      return current
    }

    const MENU_ITEM_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      minHeight: '28px',
      boxSizing: 'border-box',
      padding: '6px 8px',
      border: 'none',
      borderRadius: '6px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
      textAlign: 'left',
      cursor: 'pointer',
    }

    const MENU_ITEM_HOVER_STYLE = { background: 'var(--dsw-alias-bg-layer-2)' }

    const BACKDROP_STYLE = {
      position: 'fixed',
      inset: 0,
      zIndex: 40,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
      background: 'rgba(0, 0, 0, 0.4)',
      pointerEvents: 'auto',
    }

    const CARD_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      width: 'min(460px, calc(100vw - 32px))',
      maxHeight: 'calc(100vh - 64px)',
      boxSizing: 'border-box',
      padding: '20px',
      borderRadius: '12px',
      border: '0.5px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 16px 48px rgba(0, 0, 0, 0.28)',
    }

    const TITLE_STYLE = { margin: 0, fontSize: '16px', lineHeight: '24px', fontWeight: 600 }
    const DESCRIPTION_STYLE = {
      margin: 0,
      fontSize: '13px',
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const LIST_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      overflowY: 'auto',
      maxHeight: '38vh',
      padding: '2px',
      margin: '0 -2px',
    }
    const OPTION_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '8px 10px',
      borderRadius: '8px',
      border: '0.5px solid transparent',
      cursor: 'pointer',
    }
    const OPTION_SELECTED_STYLE = {
      borderColor: 'var(--dsw-alias-brand-primary)',
      background: 'var(--dsw-alias-bg-layer-2)',
    }
    const OPTION_TITLE_STYLE = { fontSize: '13px', lineHeight: '20px', fontWeight: 500 }
    const OPTION_PATH_STYLE = {
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
      opacity: 0.75,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const EMPTY_STYLE = {
      margin: 0,
      padding: '10px 2px',
      fontSize: '13px',
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const CREATE_BUTTON_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      boxSizing: 'border-box',
      marginTop: '2px',
      padding: '7px 10px',
      borderRadius: '8px',
      border: '0.5px dashed var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
      textAlign: 'left',
      cursor: 'pointer',
    }
    const NOTE_STYLE = {
      margin: 0,
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
      opacity: 0.85,
    }
    const ERROR_STYLE = {
      margin: 0,
      padding: '8px 10px',
      borderRadius: '8px',
      border: '0.5px solid var(--dsw-alias-state-error-primary)',
      fontSize: '13px',
      lineHeight: '20px',
      color: 'var(--dsw-alias-state-error-primary)',
    }
    const FOOTER_STYLE = {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: '8px',
      paddingTop: '4px',
    }
    const BUTTON_BASE = {
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
      padding: '6px 14px',
      borderRadius: '8px',
      cursor: 'pointer',
    }
    const BUTTON_SECONDARY = {
      ...BUTTON_BASE,
      border: '0.5px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
    }
    const BUTTON_PRIMARY = {
      ...BUTTON_BASE,
      border: '0.5px solid transparent',
      background: 'var(--dsw-alias-brand-primary)',
      color: '#ffffff',
    }
    const BUTTON_DISABLED = { opacity: 0.5, cursor: 'default' }

    /** Folder-with-arrow glyph for the menu row. */
    function MoveIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        h('path', { d: 'M1.75 4.25a1 1 0 0 1 1-1h2.9l1.2 1.4h5.4a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z' }),
        h('path', { d: 'M6.1 7.9h3.6' }),
        h('path', { d: 'M8.3 6.3 9.9 7.9 8.3 9.5' }),
      )
    }

    /** Plus glyph for the create-workspace row. */
    function PlusIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        h('path', { d: 'M8 3.25v9.5' }),
        h('path', { d: 'M3.25 8h9.5' }),
      )
    }

    /**
     * One Session row entry: dismiss the menu and raise the picker request.
     * @param props - owner share, menu open state, Workspaces Hook, and locale.
     * @returns the menu row, or nothing for an archived row.
     */
    function MoveToWorkspaceMenuItem({ sessionId, useMenuOpenState, useWorkspaces, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const [hover, setHover] = React.useState(false)
      const archived = useWorkspaces((snapshot) => snapshot.archivedSessionIds.includes(sessionId))
      if (archived) return null
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          style: hover ? { ...MENU_ITEM_STYLE, ...MENU_ITEM_HOVER_STYLE } : MENU_ITEM_STYLE,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onFocus: () => setHover(true),
          onBlur: () => setHover(false),
          onClick: () => {
            setMenuOpen(false)
            openMoveDialog(sessionId)
          },
        },
        h(MoveIcon),
        h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('menu.label')),
      )
    }

    /**
     * The shell overlay entry: nothing while no move is pending, otherwise one
     * picker keyed by request so a new request starts clean state.
     * @param props - overlay share, the raise hook's value, and the settled move.
     * @returns the open dialog, or null.
     */
    function MoveDialogEntry({ useWorkspaces, t, onMoved, pickDirectory, createWorkspace }) {
      const request = useMoveRequest()
      if (request === null) return null
      return h(MoveDialog, {
        key: `${request.sessionId}:${request.nonce}`,
        request,
        useWorkspaces,
        t,
        onClose: closeMoveDialog,
        onMoved,
        pickDirectory,
        createWorkspace,
      })
    }

    /**
     * One move request's dialog: pick a target Workspace, confirm, report a
     * failure inline. Escape and the backdrop close it while idle. A folder
     * can be registered as a new Workspace from here through the composed
     * directory picker.
     * @param props - request, Workspaces Hook, locale, close, success hop, and
     *   the directory-pick/create callbacks.
     * @returns the dialog.
     */
    function MoveDialog({ request, useWorkspaces, t, onClose, onMoved, pickDirectory, createWorkspace }) {
      const workspaces = useWorkspaces((snapshot) => snapshot.items)
      const options = workspaces.filter((workspace) => !workspace.sessionIds.includes(request.sessionId))
      const [selected, setSelected] = React.useState(options[0]?.workspaceId ?? null)
      const [busy, setBusy] = React.useState(false)
      const [creating, setCreating] = React.useState(false)
      const [error, setError] = React.useState(null)
      const cardRef = React.useRef(null)
      const restoreFocusRef = React.useRef(null)
      const optionKey = options.map((workspace) => workspace.workspaceId).join('|')

      React.useEffect(() => {
        setSelected((current) => {
          if (current !== null && options.some((workspace) => workspace.workspaceId === current)) return current
          return options[0]?.workspaceId ?? null
        })
      }, [optionKey])

      React.useEffect(() => {
        restoreFocusRef.current = typeof document === 'undefined' ? null : document.activeElement
        const card = cardRef.current
        const initial = card?.querySelector('[data-autofocus]') ?? card?.querySelector('button')
        initial?.focus()
        return () => {
          const previous = restoreFocusRef.current
          if (previous !== null && typeof previous.focus === 'function') {
            try {
              previous.focus()
            } catch {
              // The row that opened the menu may have moved or unmounted.
            }
          }
        }
      }, [])

      React.useEffect(() => {
        if (busy || typeof document === 'undefined') return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [busy, creating, onClose])

      const close = () => {
        if (busy || creating) return
        onClose()
      }

      const confirm = async () => {
        if (busy || creating || selected === null) return
        setBusy(true)
        setError(null)
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: request.sessionId, workspaceId: selected }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) {
            setBusy(false)
            setError(describeFailure(payload, t))
            return
          }
          setBusy(false)
          onMoved(payload)
        } catch (reason) {
          setBusy(false)
          setError(t('error.network'))
        }
      }

      const createAndSelect = async () => {
        if (busy || creating) return
        if (typeof pickDirectory !== 'function' || typeof createWorkspace !== 'function') {
          setError(t('error.noPicker'))
          return
        }
        setCreating(true)
        setError(null)
        try {
          const path = await pickDirectory()
          if (typeof path !== 'string' || path === '') {
            setCreating(false)
            return
          }
          const workspace = await createWorkspace({ path })
          setCreating(false)
          if (workspace === undefined || workspace === null || typeof workspace.workspaceId !== 'string') {
            setError(t('error.createWorkspace'))
            return
          }
          if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(request.sessionId)) {
            setError(t('error.newWorkspaceIsCurrent'))
            return
          }
          setSelected(workspace.workspaceId)
        } catch (reason) {
          setCreating(false)
          setError(t('error.createWorkspace'))
        }
      }

      const trapTab = (event) => {
        if (event.key !== 'Tab') return
        const card = cardRef.current
        if (card === null) return
        const focusable = [...card.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }

      const titleText = request.displayTitle === '' ? t('dialog.untitled') : request.displayTitle
      const idle = !busy && !creating
      const blocked = !idle || selected === null

      return h(
        'div',
        {
          style: BACKDROP_STYLE,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        h(
          'div',
          {
            ref: cardRef,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'move-to-workspace-title',
            'aria-describedby': 'move-to-workspace-description',
            style: CARD_STYLE,
            onKeyDown: trapTab,
          },
          h('h2', { id: 'move-to-workspace-title', style: TITLE_STYLE }, t('dialog.title')),
          h(
            'p',
            { id: 'move-to-workspace-description', style: DESCRIPTION_STYLE },
            t('dialog.description').replace('{title}', titleText),
          ),
          h(
            'div',
            { role: 'radiogroup', 'aria-label': t('dialog.target'), style: LIST_STYLE },
            options.length === 0
              ? h('p', { style: EMPTY_STYLE }, t('dialog.empty'))
              : options.map((workspace, index) =>
                  h(
                    'label',
                    {
                      key: workspace.workspaceId,
                      style:
                        selected === workspace.workspaceId
                          ? { ...OPTION_STYLE, ...OPTION_SELECTED_STYLE }
                          : OPTION_STYLE,
                    },
                    h('input', {
                      type: 'radio',
                      name: 'move-to-workspace-target',
                      value: workspace.workspaceId,
                      checked: selected === workspace.workspaceId,
                      disabled: busy || creating,
                      ...(index === 0 ? { 'data-autofocus': true } : {}),
                      onChange: () => setSelected(workspace.workspaceId),
                      style: { flex: 'none', accentColor: 'var(--dsw-alias-brand-primary)' },
                    }),
                    h(
                      'span',
                      { style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 } },
                      h('span', { style: OPTION_TITLE_STYLE }, workspace.title),
                      h('span', { style: OPTION_PATH_STYLE }, workspace.path),
                    ),
                  ),
                ),
          ),
          h(
            'button',
            {
              type: 'button',
              style: busy || creating ? { ...CREATE_BUTTON_STYLE, ...BUTTON_DISABLED } : CREATE_BUTTON_STYLE,
              disabled: busy || creating,
              onClick: createAndSelect,
            },
            h(PlusIcon),
            h('span', null, creating ? t('dialog.createBusy') : t('dialog.create')),
          ),
          error === null ? null : h('div', { role: 'alert', style: ERROR_STYLE }, error),
          h('p', { style: NOTE_STYLE }, t('dialog.copyNote')),
          h(
            'div',
            { style: FOOTER_STYLE },
            h(
              'button',
              {
                type: 'button',
                style: { ...BUTTON_SECONDARY, ...(busy || creating ? BUTTON_DISABLED : {}) },
                disabled: busy || creating,
                onClick: close,
              },
              t('cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...BUTTON_PRIMARY, ...(blocked ? BUTTON_DISABLED : {}) },
                disabled: blocked,
                onClick: confirm,
              },
              busy ? t('moving') : t('confirm'),
            ),
          ),
        ),
      )
    }

    /** One failure response as localized text. */
    function describeFailure(payload, t) {
      const code = typeof payload?.code === 'string' ? payload.code : ''
      if (code === 'session-active') {
        const activity = describeActivity(payload?.activity, t)
        return activity === '' ? t('error.sessionActivePlain') : t('error.sessionActive').replace('{activity}', activity)
      }
      const key = ERROR_KEYS[code]
      if (key !== undefined) return t(key)
      if (typeof payload?.message === 'string' && payload.message !== '') return payload.message
      return t('error.unknown')
    }

    /** Name the work a refused move reported, when the Host supplied it. */
    function describeActivity(activity, t) {
      if (!Array.isArray(activity) || activity.length === 0) return ''
      const parts = []
      for (const entry of activity) {
        const kind = typeof entry?.kind === 'string' ? entry.kind : ''
        const kindKey = ACTIVITY_KEYS[kind]
        const label = kindKey === undefined ? kind : t(kindKey)
        const items = Array.isArray(entry?.items) ? entry.items : []
        const names = items
          .map((item) => (typeof item?.label === 'string' && item.label !== '' ? item.label : typeof item?.id === 'string' ? item.id : ''))
          .filter((name) => name !== '')
        parts.push(names.length === 0 ? label : `${label} (${names.slice(0, 3).join(', ')})`)
      }
      return parts.join(', ')
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES))
        const uiWorkspace = ctx.get('uiWorkspace')
        const workspacesService = ctx.get('workspaces')
        const pickDirectory =
          uiWorkspace !== undefined && typeof uiWorkspace.pickDirectory === 'function'
            ? () => uiWorkspace.pickDirectory()
            : null
        const createWorkspace =
          workspacesService !== undefined && typeof workspacesService.create === 'function'
            ? (input) => workspacesService.create(input)
            : null
        const onMoved = (payload) => {
          closeMoveDialog()
          if (uiWorkspace === undefined || typeof payload?.sessionId !== 'string') return
          try {
            uiWorkspace.openSession(payload.sessionId)
          } catch {
            // The sidebar still shows the moved row; navigation is a convenience.
          }
        }

        ctx.slots.inject(MENU_SLOT, () =>
          ctx.slots.register(
            {
              name: MENU_SLOT,
              id: 'move-to-workspace',
              order: MENU_ORDER,
              locale: NS,
            },
            MoveToWorkspaceMenuItem,
          ),
        )

        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register(
            {
              name: OVERLAY_SLOT,
              id: 'move-to-workspace.dialog',
              locale: NS,
            },
            (slotProps) => h(MoveDialogEntry, { ...slotProps, onMoved, pickDirectory, createWorkspace }),
          ),
        )
      },
    }
  },
})
