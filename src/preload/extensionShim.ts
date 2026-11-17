/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chrome.* gaps Electron leaves, filled in an extension's own world
//: action (badges, titles, popups), commands, native messaging,
// permissions, tabs.create/query and their events, windows and their events,
// contextMenus, privacy (browser settings), declarativeContent and
// webNavigation (the last three only for extensions whose manifest asks for
// them, as in Chrome), and the `browser` alias.
// chrome.storage.sync comes from installStorageSync
// (src/shared/extensionStorageSync.ts). Both extension preloads run
// `installShim` in the main world through contextBridge.executeInMainWorld,
// after exposing `__atelierExtensionShim` (invoke and on). The function is
// serialized into that world, so it must not reference anything outside
// itself.

export interface ShimBridge {
  invoke(op: string, payload: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>
  on(listener: (name: string, args: unknown[]) => void): void
}

export function installShim(): void {
  type Fn = (...args: unknown[]) => unknown
  const g = globalThis as unknown as { __atelierExtensionShim?: ShimBridge; chrome?: Record<string, Record<string, unknown>>; browser?: unknown; window?: { close: () => void } }
  const bridge = g.__atelierExtensionShim
  const chrome = g.chrome
  if (!bridge || !chrome || !chrome.runtime || !(chrome.runtime as { id?: string }).id) return

  const listeners = new Map<string, Set<Fn>>()
  bridge.on((name, args) => {
    for (const fn of [...(listeners.get(name) ?? [])]) {
      try {
        fn(...args)
      } catch (err) {
        console.error(err)
      }
    }
  })
  const event = (name: string): Record<string, Fn> => {
    const set = (): Set<Fn> => {
      let s = listeners.get(name)
      if (!s) listeners.set(name, (s = new Set()))
      return s
    }
    return {
      addListener: (fn) => void set().add(fn as Fn),
      removeListener: (fn) => void set().delete(fn as Fn),
      hasListener: (fn) => set().has(fn as Fn),
      hasListeners: () => set().size > 0,
    }
  }

  // chrome.runtime.lastError is set only while a callback runs, as in Chrome.
  let lastError: { message: string } | undefined
  try {
    const runtime = chrome.runtime
    const native = Object.getOwnPropertyDescriptor(runtime, 'lastError')
    Object.defineProperty(runtime, 'lastError', { configurable: true, get: () => lastError ?? (native?.get ? native.get.call(runtime) : native?.value) })
  } catch {
    // Not redefinable here: callbacks then see the native value.
  }
  const withLastError = (message: string | null, fn: () => void): void => {
    lastError = message ? { message } : undefined
    try {
      fn()
    } finally {
      lastError = undefined
    }
  }

  const call = async (op: string, payload: unknown): Promise<unknown> => {
    const r = await bridge.invoke(op, payload ?? {})
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
  /** Chrome's dual style: a trailing callback, or a promise. */
  const api =
    (op: string, toPayload?: (...args: unknown[]) => unknown): Fn =>
    (...args: unknown[]) => {
      const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as Fn) : null
      const promise = call(op, toPayload ? toPayload(...args) : (args[0] ?? {}))
      if (!cb) return promise
      promise.then(
        (value) => cb(value),
        (err: unknown) => withLastError(err instanceof Error ? err.message : String(err), () => cb()),
      )
      return undefined
    }
  const define = (target: object | undefined, key: string, value: unknown): void => {
    if (!target) return
    try {
      Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value })
    } catch {
      // A frozen namespace: that API stays Electron's.
    }
  }

  define(chrome, 'action', {
    setBadgeText: api('action.setBadgeText'),
    getBadgeText: api('action.getBadgeText'),
    setBadgeBackgroundColor: api('action.setBadgeBackgroundColor'),
    getBadgeBackgroundColor: api('action.getBadgeBackgroundColor'),
    // Atelier picks the badge's text colour for contrast; the call succeeds and changes nothing.
    setBadgeTextColor: (...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as Fn | undefined
      if (!cb) return Promise.resolve()
      setTimeout(cb, 0)
      return undefined
    },
    setTitle: api('action.setTitle'),
    getTitle: api('action.getTitle'),
    setPopup: api('action.setPopup'),
    getPopup: api('action.getPopup'),
    enable: api('action.enable', (tabId) => ({ tabId })),
    disable: api('action.disable', (tabId) => ({ tabId })),
    isEnabled: api('action.isEnabled', (tabId) => ({ tabId })),
    setIcon: api('action.setIcon'),
    openPopup: api('action.openPopup'),
    getUserSettings: async () => ({ isOnToolbar: true }),
    onClicked: event('action.onClicked'),
  })
  define(chrome, 'commands', { getAll: api('commands.getAll'), onCommand: event('commands.onCommand') })
  define(chrome, 'permissions', {
    getAll: api('permissions.getAll'),
    contains: api('permissions.contains'),
    request: api('permissions.request'),
    remove: api('permissions.remove'),
    onAdded: event('permissions.onAdded'),
    onRemoved: event('permissions.onRemoved'),
  })
  // Main sends a listened event (tabs, webNavigation, windows, privacy, menus) only to a context that
  // listens for it, so the first listener registers.
  const registered = new Set<string>()
  const register = (name: string): void => {
    if (registered.has(name)) return
    registered.add(name)
    bridge.invoke('tabs.listen', { event: name }).then(
      (r) => {
        if (!r.ok) registered.delete(name)
      },
      () => registered.delete(name),
    )
  }
  const tabEvent = (name: string): Record<string, Fn> => {
    const base = event(name)
    return {
      ...base,
      addListener: (fn) => {
        base.addListener?.(fn)
        register(name)
      },
    }
  }
  const manifest = (() => {
    try {
      return ((chrome.runtime as { getManifest?: () => { permissions?: unknown; optional_permissions?: unknown } }).getManifest?.() ?? {}) as { permissions?: unknown; optional_permissions?: unknown }
    } catch {
      return {}
    }
  })()
  const asks = (permission: string): boolean => [manifest.permissions, manifest.optional_permissions].some((l) => Array.isArray(l) && l.includes(permission))
  if (chrome.tabs) {
    define(chrome.tabs, 'create', api('tabs.create'))
    define(chrome.tabs, 'query', api('tabs.query'))
    define(chrome.tabs, 'onCreated', tabEvent('tabs.onCreated'))
    define(chrome.tabs, 'onActivated', tabEvent('tabs.onActivated'))
    define(chrome.tabs, 'onUpdated', tabEvent('tabs.onUpdated'))
    define(chrome.tabs, 'onRemoved', tabEvent('tabs.onRemoved'))
  }
  const windowsAll = api('windows.getAll')
  const focusedWindow = async (): Promise<unknown> => ((await windowsAll()) as { focused: boolean }[]).find((w) => w.focused) ?? null
  const withCallback =
    (fn: () => Promise<unknown>): Fn =>
    (...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? (args[args.length - 1] as Fn) : null
      const p = fn()
      if (!cb) return p
      p.then((v) => cb(v), (err: unknown) => withLastError(String(err), () => cb()))
      return undefined
    }
  if (!chrome.windows) {
    define(chrome, 'windows', {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      WindowType: { NORMAL: 'normal', POPUP: 'popup', PANEL: 'panel', APP: 'app', DEVTOOLS: 'devtools' },
      WindowState: { NORMAL: 'normal', MINIMIZED: 'minimized', MAXIMIZED: 'maximized', FULLSCREEN: 'fullscreen', LOCKED_FULLSCREEN: 'locked-fullscreen' },
      getAll: windowsAll,
      getCurrent: withCallback(focusedWindow),
      getLastFocused: withCallback(focusedWindow),
      get: (id: unknown, ...rest: unknown[]) => withCallback(async () => ((await windowsAll()) as { id: number }[]).find((w) => w.id === id) ?? null)(...rest),
      onCreated: tabEvent('windows.onCreated'),
      onRemoved: tabEvent('windows.onRemoved'),
      onFocusChanged: tabEvent('windows.onFocusChanged'),
      onBoundsChanged: event('windows.onBoundsChanged'),
    })
  }

  // contextMenus: items show in the page's context menu; Atelier keeps them, clicks come back as onClicked.
  if (!chrome.contextMenus && asks('contextMenus')) {
    let n = 0
    const clickHandlers = new Map<string, Fn>()
    const clicked = tabEvent('contextMenus.onClicked')
    // An onclick passed to create() (pages only, as in Chrome) runs for its own item.
    bridge.on((name, args) => {
      if (name !== 'contextMenus.onClicked') return
      const info = args[0] as { menuItemId?: unknown } | undefined
      const handler = clickHandlers.get(String(info?.menuItemId))
      if (handler) handler(...args)
    })
    const strip = (props: unknown): { props: Record<string, unknown>; onclick: Fn | null } => {
      const p = { ...((props as Record<string, unknown>) ?? {}) }
      const onclick = typeof p.onclick === 'function' ? (p.onclick as Fn) : null
      delete p.onclick
      return { props: p, onclick }
    }
    const withCb = (promise: Promise<unknown>, cb: Fn | null): void => {
      promise.then(
        () => cb && cb(),
        (err: unknown) => {
          if (cb) withLastError(err instanceof Error ? err.message : String(err), () => cb())
          else console.error(`Unchecked runtime.lastError: ${err instanceof Error ? err.message : String(err)}`)
        },
      )
    }
    define(chrome, 'contextMenus', {
      ACTION_MENU_TOP_LEVEL_LIMIT: 6,
      ContextType: { ALL: 'all', PAGE: 'page', FRAME: 'frame', SELECTION: 'selection', LINK: 'link', EDITABLE: 'editable', IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', LAUNCHER: 'launcher', BROWSER_ACTION: 'browser_action', PAGE_ACTION: 'page_action', ACTION: 'action' },
      ItemType: { NORMAL: 'normal', CHECKBOX: 'checkbox', RADIO: 'radio', SEPARATOR: 'separator' },
      // create() answers with the id at once, as Chrome does; a failure reaches the callback as lastError.
      create: (raw: unknown, cb?: Fn) => {
        const { props, onclick } = strip(raw)
        const id = props.id ?? ++n
        props.id = id
        if (onclick) clickHandlers.set(String(id), onclick)
        withCb(call('contextMenus.create', { props }), typeof cb === 'function' ? cb : null)
        return id
      },
      update: (id: unknown, raw: unknown, cb?: Fn) => {
        const { props, onclick } = strip(raw)
        if (onclick) clickHandlers.set(String(id), onclick)
        const p = call('contextMenus.update', { id, props })
        if (typeof cb !== 'function') return p.then(() => undefined)
        withCb(p, cb)
        return undefined
      },
      remove: (id: unknown, cb?: Fn) => {
        clickHandlers.delete(String(id))
        const p = call('contextMenus.remove', { id })
        if (typeof cb !== 'function') return p.then(() => undefined)
        withCb(p, cb)
        return undefined
      },
      removeAll: (cb?: Fn) => {
        clickHandlers.clear()
        const p = call('contextMenus.removeAll', {})
        if (typeof cb !== 'function') return p.then(() => undefined)
        withCb(p, cb)
        return undefined
      },
      onClicked: clicked,
    })
  }

  // chrome.privacy: browser settings as ChromeSettings (get/set/clear/onChange). Atelier lets an extension
  // hold password saving; address and card autofill answer "not_controllable".
  if (!chrome.privacy && asks('privacy')) {
    const settingListeners = new Map<string, Set<Fn>>()
    bridge.on((name, args) => {
      if (name !== 'privacy.onChange') return
      for (const fn of [...(settingListeners.get(String(args[0])) ?? [])]) {
        try {
          fn(args[1])
        } catch (err) {
          console.error(err)
        }
      }
    })
    const setting = (key: string): Record<string, unknown> => {
      const set = new Set<Fn>()
      settingListeners.set(key, set)
      return {
        get: api('privacy.get', (details) => ({ key, details: details ?? {} })),
        set: api('privacy.set', (details) => ({ key, details: details ?? {} })),
        clear: api('privacy.clear', (details) => ({ key, details: details ?? {} })),
        onChange: {
          addListener: (fn: unknown) => {
            if (typeof fn !== 'function') return
            set.add(fn as Fn)
            register('privacy.onChange')
          },
          removeListener: (fn: unknown) => void set.delete(fn as Fn),
          hasListener: (fn: unknown) => set.has(fn as Fn),
          hasListeners: () => set.size > 0,
        },
      }
    }
    define(chrome, 'privacy', {
      services: {
        passwordSavingEnabled: setting('services.passwordSavingEnabled'),
        autofillAddressEnabled: setting('services.autofillAddressEnabled'),
        autofillCreditCardEnabled: setting('services.autofillCreditCardEnabled'),
        autofillEnabled: setting('services.autofillEnabled'),
      },
    })
  }

  // chrome.declarativeContent: rules kept by Atelier; URL conditions decide where ShowAction turns the action on.
  if (!chrome.declarativeContent && asks('declarativeContent')) {
    const instance = (type: string): unknown =>
      function (this: Record<string, unknown>, opts?: Record<string, unknown>) {
        Object.assign(this, opts ?? {})
        this.instanceType = `declarativeContent.${type}`
      }
    const plain = (rules: unknown): unknown => JSON.parse(JSON.stringify(rules ?? []))
    const rulesCall = (op: string, payload: unknown, cb: unknown): unknown => {
      const p = call(op, payload)
      if (typeof cb !== 'function') return p
      p.then(
        (v) => (cb as Fn)(v),
        (err: unknown) => withLastError(err instanceof Error ? err.message : String(err), () => (cb as Fn)()),
      )
      return undefined
    }
    const ids = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined)
    define(chrome, 'declarativeContent', {
      PageStateMatcher: instance('PageStateMatcher'),
      ShowAction: instance('ShowAction'),
      ShowPageAction: instance('ShowPageAction'),
      SetIcon: instance('SetIcon'),
      RequestContentScript: instance('RequestContentScript'),
      PageStateMatcherInstanceType: { DECLARATIVE_CONTENT_PAGE_STATE_MATCHER: 'declarativeContent.PageStateMatcher' },
      ShowActionInstanceType: { DECLARATIVE_CONTENT_SHOW_ACTION: 'declarativeContent.ShowAction' },
      ShowPageActionInstanceType: { DECLARATIVE_CONTENT_SHOW_PAGE_ACTION: 'declarativeContent.ShowPageAction' },
      SetIconInstanceType: { DECLARATIVE_CONTENT_SET_ICON: 'declarativeContent.SetIcon' },
      RequestContentScriptInstanceType: { DECLARATIVE_CONTENT_REQUEST_CONTENT_SCRIPT: 'declarativeContent.RequestContentScript' },
      onPageChanged: {
        addRules: (rules: unknown, cb?: unknown) => rulesCall('declarativeContent.addRules', { rules: plain(rules) }, cb),
        removeRules: (a?: unknown, cb?: unknown) => (typeof a === 'function' ? rulesCall('declarativeContent.removeRules', {}, a) : rulesCall('declarativeContent.removeRules', { ids: ids(a) }, cb)),
        getRules: (a?: unknown, cb?: unknown) => (typeof a === 'function' ? rulesCall('declarativeContent.getRules', {}, a) : rulesCall('declarativeContent.getRules', { ids: ids(a) }, cb)),
        // A declarative event has rules, not listeners.
        addListener: () => {
          throw new Error('This event does not support listeners.')
        },
        removeListener: () => {},
        hasListener: () => false,
        hasListeners: () => false,
      },
    })
  }

  // chrome.webNavigation: frames with Chromium's own frame ids, and navigation events (with url filters).
  if (!chrome.webNavigation && asks('webNavigation')) {
    const filterMatches = (filter: Record<string, unknown>, url: string): boolean => {
      let u: URL
      try {
        u = new URL(url)
      } catch {
        return false
      }
      const host = u.hostname
      const noFragment = url.split('#')[0] ?? url
      const tests: Record<string, (v: string) => boolean> = {
        hostEquals: (v) => host === v.toLowerCase(),
        hostContains: (v) => `.${host}`.includes(v.toLowerCase()),
        hostPrefix: (v) => host.startsWith(v.toLowerCase()),
        hostSuffix: (v) => host.endsWith(v.toLowerCase()),
        pathEquals: (v) => u.pathname === v,
        pathContains: (v) => u.pathname.includes(v),
        pathPrefix: (v) => u.pathname.startsWith(v),
        pathSuffix: (v) => u.pathname.endsWith(v),
        queryEquals: (v) => u.search.replace(/^\?/, '') === v,
        queryContains: (v) => u.search.includes(v),
        urlEquals: (v) => noFragment === v,
        urlContains: (v) => noFragment.includes(v),
        urlPrefix: (v) => noFragment.startsWith(v),
        urlSuffix: (v) => noFragment.endsWith(v),
        urlMatches: (v) => {
          try {
            return new RegExp(v).test(noFragment)
          } catch {
            return false
          }
        },
      }
      for (const [k, test] of Object.entries(tests)) if (typeof filter[k] === 'string' && !test(filter[k] as string)) return false
      if (Array.isArray(filter.schemes) && !filter.schemes.includes(u.protocol.replace(/:$/, ''))) return false
      return true
    }
    const navEvent = (name: string): Record<string, Fn> => {
      const filters = new Map<Fn, Record<string, unknown>[] | null>()
      bridge.on((n, args) => {
        if (n !== name) return
        const details = args[0] as { url?: string } | undefined
        for (const [fn, list] of [...filters]) {
          if (list && !list.some((f) => filterMatches(f, details?.url ?? ''))) continue
          try {
            fn(...args)
          } catch (err) {
            console.error(err)
          }
        }
      })
      return {
        addListener: (fn: unknown, filter?: unknown) => {
          if (typeof fn !== 'function') return
          const urls = (filter as { url?: unknown } | undefined)?.url
          filters.set(fn as Fn, Array.isArray(urls) ? (urls as Record<string, unknown>[]) : null)
          register(name)
        },
        removeListener: (fn: unknown) => void filters.delete(fn as Fn),
        hasListener: (fn: unknown) => filters.has(fn as Fn),
        hasListeners: () => filters.size > 0,
      }
    }
    define(chrome, 'webNavigation', {
      TransitionType: { LINK: 'link', TYPED: 'typed', AUTO_BOOKMARK: 'auto_bookmark', AUTO_SUBFRAME: 'auto_subframe', MANUAL_SUBFRAME: 'manual_subframe', GENERATED: 'generated', START_PAGE: 'start_page', FORM_SUBMIT: 'form_submit', RELOAD: 'reload', KEYWORD: 'keyword', KEYWORD_GENERATED: 'keyword_generated' },
      getFrame: api('webNavigation.getFrame'),
      getAllFrames: api('webNavigation.getAllFrames'),
      onBeforeNavigate: navEvent('webNavigation.onBeforeNavigate'),
      onCommitted: navEvent('webNavigation.onCommitted'),
      onDOMContentLoaded: navEvent('webNavigation.onDOMContentLoaded'),
      onCompleted: navEvent('webNavigation.onCompleted'),
      onErrorOccurred: navEvent('webNavigation.onErrorOccurred'),
      onHistoryStateUpdated: navEvent('webNavigation.onHistoryStateUpdated'),
      onReferenceFragmentUpdated: navEvent('webNavigation.onReferenceFragmentUpdated'),
      onTabReplaced: tabEvent('webNavigation.onTabReplaced'),
      onCreatedNavigationTarget: event('webNavigation.onCreatedNavigationTarget'),
    })
  }

  // Native messaging: ports talk to main, which runs the host after asking the person.
  type PortRecord = { onMessage: Set<Fn>; onDisconnect: Set<Fn>; open: boolean; ready: boolean; queue: unknown[]; port: Record<string, unknown> }
  const ports = new Map<string, PortRecord>()
  let seq = 0
  const portEvent = (set: Set<Fn>): Record<string, Fn> => ({
    addListener: (fn) => void set.add(fn as Fn),
    removeListener: (fn) => void set.delete(fn as Fn),
    hasListener: (fn) => set.has(fn as Fn),
    hasListeners: () => set.size > 0,
  })
  const closePort = (portId: string, error: string | null): void => {
    const rec = ports.get(portId)
    if (!rec || !rec.open) return
    rec.open = false
    ports.delete(portId)
    withLastError(error, () => {
      for (const fn of [...rec.onDisconnect]) fn(rec.port)
    })
  }
  bridge.on((name, args) => {
    if (name === 'native.message') {
      const rec = ports.get(String(args[0]))
      if (rec?.open) for (const fn of [...rec.onMessage]) fn(args[1], rec.port)
    } else if (name === 'native.disconnect') {
      closePort(String(args[0]), args[1] ? String(args[1]) : null)
    }
  })
  const connectNative = (host: string): Record<string, unknown> => {
    const portId = `p${Date.now().toString(36)}${(seq++).toString(36)}`
    const rec: PortRecord = { onMessage: new Set(), onDisconnect: new Set(), open: true, ready: false, queue: [], port: {} }
    rec.port = {
      name: '',
      onMessage: portEvent(rec.onMessage),
      onDisconnect: portEvent(rec.onDisconnect),
      postMessage: (message: unknown) => {
        if (!rec.open) throw new Error('Attempting to use a disconnected port object')
        // Messages wait while the person decides whether this host may run.
        if (!rec.ready) return void rec.queue.push(message)
        call('native.post', { portId, message }).catch((err: unknown) => closePort(portId, String(err)))
      },
      disconnect: () => {
        if (!rec.open) return
        rec.open = false
        ports.delete(portId)
        call('native.disconnect', { portId }).catch(() => {})
      },
    }
    ports.set(portId, rec)
    call('native.connect', { portId, host }).then(
      (r) => {
        const result = r as { ok: boolean; error?: string }
        if (!result.ok) return closePort(portId, result.error ?? 'Native host has exited.')
        rec.ready = true
        for (const message of rec.queue.splice(0)) call('native.post', { portId, message }).catch((err: unknown) => closePort(portId, String(err)))
      },
      (err: unknown) => closePort(portId, err instanceof Error ? err.message : String(err)),
    )
    return rec.port
  }
  define(chrome.runtime, 'connectNative', connectNative)
  define(chrome.runtime, 'sendNativeMessage', api('native.send', (host, message) => ({ host, message })))
  define(chrome.runtime, 'openOptionsPage', api('runtime.openOptionsPage', () => ({})))

  // A popup's window.close() closes Atelier's popup view; elsewhere it does what it always did.
  const win = g.window
  if (win && typeof win.close === 'function') {
    const original = win.close.bind(win)
    win.close = () => {
      call('window.close', {}).then(
        (closed) => {
          if (!closed) original()
        },
        () => original(),
      )
    }
  }

  // `browser` is the same object as `chrome` in Chrome's extension worlds.
  try {
    Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: chrome })
  } catch {
    // Already defined by the page.
  }
}
