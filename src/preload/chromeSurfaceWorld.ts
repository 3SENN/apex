/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chrome surface (docs/architecture.md, "Sign-in compatibility"): the
// window.chrome stock desktop Chrome gives ordinary web pages. Electron leaves
// it an empty object, and Google's sign-in, among other risk checks, reads that
// as an embedded browser. Shapes follow Chromium 156's own sources:
// - chrome.loadTimes() and chrome.csi(): chrome/renderer/loadtimes_bindings.cc;
// - chrome.app: chrome/common/extensions/api/app.json and app_hooks_delegate.cc;
// - chrome.runtime as a web page sees it (connect and sendMessage, the enums):
//   extensions/common/api/runtime.json, _api_features.json, messaging_util.cc;
// - argument errors in the extension bindings' wording (api_invocation_errors.cc).
// Every function reads as native code from Function.prototype.toString, with
// Chrome's name and length; every property is a plain data property, as the
// bindings make them. Only what is missing is filled in.
//
// installChromeSurface runs in the page's own world, serialised by
// contextBridge.executeInMainWorld (preload/chromeSurface.ts), so it uses
// nothing from outside itself. It also fills a same-origin about:blank iframe
// the page reaches through contentWindow or contentDocument: Electron runs no
// preload there.

/** What one page's realms share: the functions that read as native, and their source text. */
interface Shared {
  natives: WeakMap<object, string>
}

/**
 * Fills in window.chrome on `target` (a window; the page's own by default).
 * Returns false when there is no window object to fill.
 */
export function installChromeSurface(target?: object, given?: unknown): boolean {
  // Strict, as Chrome's own functions are: no own `caller` or `arguments` on them. (No default
  // parameters above: a function with them can't carry the directive.)
  'use strict'
  type Fn = (...args: unknown[]) => unknown
  type Bag = Record<PropertyKey, any>
  const W = (target ?? globalThis) as Bag
  if (!W || typeof W.Object !== 'function' || typeof W.Function !== 'function') return false

  // ---- the realm's own intrinsics, taken before any page script runs ----
  const apply = W.Reflect.apply as typeof Reflect.apply
  const defineProperty = W.Object.defineProperty as typeof Object.defineProperty
  const getOwnPropertyDescriptor = W.Object.getOwnPropertyDescriptor as typeof Object.getOwnPropertyDescriptor
  const getPrototypeOf = W.Object.getPrototypeOf as typeof Object.getPrototypeOf
  const setPrototypeOf = W.Object.setPrototypeOf as typeof Object.setPrototypeOf
  const objectKeys = W.Object.keys as typeof Object.keys
  const deleteProperty = W.Reflect.deleteProperty as typeof Reflect.deleteProperty
  const ObjectProto = W.Object.prototype as object
  const FunctionProto = W.Function.prototype as Bag
  const ProxyCtor = W.Proxy as ProxyConstructor
  const WeakMapCtor = W.WeakMap as WeakMapConstructor
  const wmGet = W.WeakMap.prototype.get as WeakMap<object, string>['get']
  const wmSet = W.WeakMap.prototype.set as WeakMap<object, string>['set']
  const TypeErrorCtor = W.TypeError as TypeErrorConstructor
  const ErrorCtor = W.Error as ErrorConstructor & { captureStackTrace?(o: object, f?: unknown): void; prepareStackTrace?: unknown }
  const captureStackTrace = ErrorCtor.captureStackTrace
  const isArray = W.Array.isArray as typeof Array.isArray
  const arraySlice = W.Array.prototype.slice as unknown[]['slice']
  const arrayJoin = W.Array.prototype.join as unknown[]['join']
  const arrayPush = W.Array.prototype.push as unknown[]['push']
  const arrayIndexOf = W.Array.prototype.indexOf as unknown[]['indexOf']
  const arraySplice = W.Array.prototype.splice as unknown[]['splice']
  const stringSplit = W.String.prototype.split as string['split']
  const stringSlice = W.String.prototype.slice as string['slice']
  const stringTrim = W.String.prototype.trim as string['trim']
  const stringLower = W.String.prototype.toLowerCase as string['toLowerCase']
  const isInteger = W.Number.isInteger as typeof Number.isInteger
  const mathFloor = W.Math.floor as typeof Math.floor
  const stringify = W.JSON.stringify as typeof JSON.stringify
  const setTimer = W.setTimeout as (cb: () => void, ms: number) => unknown
  const perf = W.performance as Bag | undefined
  const PerfProto = (W.Performance?.prototype ?? null) as Bag | null
  const perfNow = PerfProto?.now as (() => number) | undefined
  const perfEntries = PerfProto?.getEntriesByType as ((type: string) => Bag[]) | undefined
  const perfTiming = PerfProto ? getOwnPropertyDescriptor(PerfProto, 'timing')?.get : undefined
  const perfOrigin = PerfProto ? getOwnPropertyDescriptor(PerfProto, 'timeOrigin')?.get : undefined
  const IFrameProto = (W.HTMLIFrameElement?.prototype ?? null) as Bag | null
  const getAttribute = W.Element?.prototype?.getAttribute as ((name: string) => string | null) | undefined
  const channel = W.Symbol.for('v8.function.source') as symbol

  // ---- native-looking functions ----

  /** The registry another realm of this page already keeps (its toString answers the channel), or null. */
  const registryOf = (w: unknown): Shared | null => {
    try {
      const found = apply((w as Bag).Function.prototype.toString, channel, []) as unknown
      return found && typeof found === 'object' && (found as Shared).natives ? (found as Shared) : null
    } catch {
      return null
    }
  }
  const here = registryOf(W)
  let shared = here ?? (given as Shared | undefined) ?? null
  if (!shared) {
    const near = ['parent', 'top', 'opener']
    for (let i = 0; i < near.length && !shared; i++) {
      let other: unknown = null
      try {
        other = W[near[i]!]
      } catch {
        other = null
      }
      if (other && other !== W) shared = registryOf(other)
    }
  }
  const state: Shared = shared ?? { natives: new WeakMapCtor<object, string>() }

  const own = <T extends object>(o: T, proto: object): T => {
    if (getPrototypeOf(o) !== proto) setPrototypeOf(o, proto)
    return o
  }
  /** A plain object of this realm. */
  const plain = <T extends object>(o: T): T => own(o, ObjectProto)
  /** Registers `fn` as native code named `name` ('' for Chrome's anonymous ones). */
  const native = <T extends object>(fn: T, name: string): T => {
    own(fn, FunctionProto)
    const proto = (fn as Bag).prototype
    if (proto && typeof proto === 'object') own(proto, ObjectProto)
    apply(wmSet, state.natives, [fn, `function ${name}() { [native code] }`])
    return fn
  }
  /** A data property as the bindings make them: writable, enumerable, configurable. */
  const put = (o: object, key: string, value: unknown): void => {
    defineProperty(o, key, { value, writable: true, enumerable: true, configurable: true })
  }

  /** A TypeError whose stack starts at the page's call, as a native function's does. */
  const typeError = (fn: unknown, message: string): Error => {
    const err = new TypeErrorCtor(message)
    try {
      captureStackTrace?.(err, fn)
    } catch {
      // The stack stays as it is.
    }
    return err
  }

  /**
   * An error thrown by the native toString, its stack without the wrapper's
   * frame: the message, the native frame, then the page's own frames.
   */
  const tidy = (err: unknown, wrapper: unknown): unknown => {
    try {
      if (!err || typeof err !== 'object' || typeof ErrorCtor.prepareStackTrace === 'function' || !captureStackTrace) return err
      const stack = (err as Bag).stack as unknown
      if (typeof stack !== 'string') return err
      const holder: Bag = {}
      captureStackTrace(holder, wrapper)
      if (typeof holder.stack !== 'string') return err
      const lines = apply(stringSplit, stack, ['\n']) as string[]
      const callers = apply(arraySlice, apply(stringSplit, holder.stack, ['\n']), [1]) as string[]
      const out: string[] = [lines[0] ?? '']
      // The native function's own frame ("at Function.toString (<anonymous>)") stays; it has no line and column.
      const frame = lines[1] ?? ''
      if (apply(stringSlice, frame, [-13]) === '(<anonymous>)') apply(arrayPush, out, [frame])
      for (let i = 0; i < callers.length; i++) apply(arrayPush, out, [callers[i]])
      ;(err as Bag).stack = apply(arrayJoin, out, ['\n'])
    } catch {
      // Left as thrown.
    }
    return err
  }

  if (!here) {
    const desc = getOwnPropertyDescriptor(FunctionProto, 'toString')
    const nativeToString = desc?.value as Fn | undefined
    if (desc && typeof nativeToString === 'function' && desc.configurable) {
      const handler = {
        apply(original: Fn, self: unknown, args: unknown[]): unknown {
          if (self === channel) return state
          const text = apply(wmGet, state.natives, [self as object])
          if (text !== undefined) return text
          try {
            return apply(original, self, args)
          } catch (err) {
            throw tidy(err, handler.apply)
          }
        },
      }
      const toString = new ProxyCtor(nativeToString, handler)
      apply(wmSet, state.natives, [toString, 'function toString() { [native code] }'])
      defineProperty(FunctionProto, 'toString', { ...desc, value: toString })
    }
  }

  // ---- window.chrome ----

  let chrome = W.chrome as unknown
  if (chrome === undefined || chrome === null) {
    // Chromium makes it with every context; a world without one gets Chrome's plain property.
    try {
      put(W, 'chrome', plain({}))
      chrome = W.chrome
    } catch {
      return false
    }
  }
  if (!chrome || typeof chrome !== 'object') return false
  const has = (key: string): boolean => key in (chrome as object)
  const later = (cb: () => void): void => {
    apply(setTimer, W, [cb, 0])
  }

  // ---- chrome.loadTimes() and chrome.csi() ----
  // Seconds (loadTimes) and milliseconds (csi) since the epoch, from the page's own timing.

  interface Timing {
    start: number
    response: number
    domReady: number
    loaded: number
    paint: number
    type: string
    protocol: string
  }
  const timing = (): Timing => {
    const t: Timing = { start: 0, response: 0, domReady: 0, loaded: 0, paint: 0, type: 'navigate', protocol: '' }
    if (!perf) return t
    try {
      const legacy = perfTiming ? (apply(perfTiming, perf, []) as Bag) : null
      if (legacy) {
        t.start = Number(legacy.navigationStart) || 0
        t.response = Number(legacy.responseStart) || 0
        t.domReady = Number(legacy.domContentLoadedEventEnd) || 0
        t.loaded = Number(legacy.loadEventEnd) || 0
      }
      if (!t.start && perfOrigin) t.start = mathFloor(Number(apply(perfOrigin, perf, [])) || 0)
      const nav = perfEntries ? (apply(perfEntries, perf, ['navigation']) as Bag[])[0] : undefined
      if (nav) {
        t.type = String(nav.type ?? 'navigate')
        t.protocol = String(nav.nextHopProtocol ?? '')
      }
      const paints = perfEntries ? (apply(perfEntries, perf, ['paint']) as Bag[]) : []
      for (let i = 0; i < paints.length; i++) {
        const p = paints[i]
        if (p && p.name === 'first-paint' && perfOrigin) t.paint = mathFloor(Number(apply(perfOrigin, perf, [])) + Number(p.startTime))
      }
    } catch {
      // A partial reading; the rest stays 0, as before the page has loaded.
    }
    return t
  }
  const navigationType = (type: string): string => (type === 'reload' ? 'Reload' : type === 'back_forward' ? 'BackForward' : 'Other')
  // chrome/renderer/loadtimes_bindings.cc: link 0, back/forward 6, other 15, reload 16.
  const transition = (type: string): number => (type === 'reload' ? 16 : type === 'back_forward' ? 6 : 15)

  // Anonymous, constructible, length 0: the C++ functions loadtimes_bindings.cc makes with v8::Function::New.
  // (Array elements, so no name is inferred, and read by index: no iterator a page could have replaced.)
  const timers = [
    function () {
      const t = timing()
      let secure = false
      try {
        secure = W.location.protocol === 'https:'
      } catch {
        secure = false
      }
      const p = t.protocol
      const negotiated = secure && p !== ''
      return plain({
        requestTime: t.start / 1000,
        startLoadTime: t.start / 1000,
        commitLoadTime: t.response / 1000,
        finishDocumentLoadTime: t.domReady / 1000,
        finishLoadTime: t.loaded / 1000,
        firstPaintTime: t.paint / 1000,
        firstPaintAfterLoadTime: 0,
        navigationType: navigationType(t.type),
        wasFetchedViaSpdy: p === 'h2' || p === 'h3',
        wasNpnNegotiated: negotiated,
        npnNegotiatedProtocol: negotiated ? p : 'unknown',
        wasAlternateProtocolAvailable: false,
        connectionInfo: p || 'unknown',
      })
    },
    function () {
      const t = timing()
      let now = 0
      try {
        now = perf && perfNow && perfOrigin ? Number(apply(perfOrigin, perf, [])) + Number(apply(perfNow, perf, [])) : 0
      } catch {
        now = 0
      }
      return plain({ startE: t.start, onloadT: t.domReady, pageT: now > 0 ? now - t.start : 0, tran: transition(t.type) })
    },
  ]
  const loadTimes = timers[0]!
  const csi = timers[1]!
  if (!has('loadTimes')) put(chrome, 'loadTimes', native(loadTimes, ''))
  if (!has('csi')) put(chrome, 'csi', native(csi, ''))

  // ---- chrome.app ----
  // app_hooks_delegate.cc: a call that doesn't match its signature throws the
  // bindings' invocation error with no reason after the colon.

  const invocation = (fn: unknown, method: string, signature: string, reason: string): Error => typeError(fn, `Error in invocation of ${method}(${signature}): ${reason}`)
  const appFns = {
    getDetails() {
      if (arguments.length > 0) throw invocation(appFns.getDetails, 'app.getDetails', '', '')
      return null
    },
    getIsInstalled() {
      if (arguments.length > 0) throw invocation(appFns.getIsInstalled, 'app.getIsInstalled', '', '')
      return false
    },
    installState() {
      const callback = arguments[0] as unknown
      if (arguments.length !== 1 || typeof callback !== 'function') throw invocation(appFns.installState, 'app.installState', 'function callback', '')
      // The browser answers a page that is no hosted app with not_installed.
      later(() => (callback as Fn)('not_installed'))
    },
    runningState() {
      if (arguments.length > 0) throw invocation(appFns.runningState, 'app.runningState', '', '')
      return 'cannot_run'
    },
  }
  if (!has('app')) {
    // isInstalled (a native data property) comes first, then the methods and enums in schema order; enum entries sorted by value.
    const app = plain({
      isInstalled: false,
      getDetails: native(appFns.getDetails, 'getDetails'),
      getIsInstalled: native(appFns.getIsInstalled, 'getIsInstalled'),
      installState: native(appFns.installState, 'installState'),
      runningState: native(appFns.runningState, 'runningState'),
      InstallState: plain({ DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }),
      RunningState: plain({ CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }),
    })
    put(chrome, 'app', app)
  }

  // ---- chrome.runtime, as a web page has it ----

  const SEND = 'runtime.sendMessage'
  const SEND_SIGNATURE = 'optional string extensionId, any message, optional object options, optional function callback'
  const CONNECT = 'runtime.connect'
  const CONNECT_SIGNATURE = 'optional string extensionId, optional object connectInfo'
  const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'

  /** The binding system's type names, for "Invalid type: expected …, found …". */
  const typeName = (v: unknown): string => {
    if (v === null) return 'null'
    if (isArray(v)) return 'array'
    if (typeof v === 'number') return isInteger(v) ? 'integer' : 'number'
    return typeof v
  }
  interface Spec {
    optional: boolean
    accepts(v: unknown): boolean
  }
  const optional = (accepts: (v: unknown) => boolean): Spec => ({ optional: true, accepts: (v) => v === undefined || v === null || accepts(v) })
  const isString = (v: unknown): boolean => typeof v === 'string'
  const isObject = (v: unknown): boolean => v !== null && typeof v === 'object'
  const isFunction = (v: unknown): boolean => typeof v === 'function'
  /** Matches arguments to a signature the way the bindings do: optional parameters may be left out. Null when nothing fits. */
  const resolve = (args: unknown[], specs: Spec[]): unknown[] | null => {
    const out: unknown[] = []
    const walk = (i: number, j: number): boolean => {
      if (j === specs.length) return i === args.length
      const spec = specs[j]!
      if (i < args.length && spec.accepts(args[i])) {
        out[j] = args[i]
        if (walk(i + 1, j + 1)) return true
      }
      if (spec.optional) {
        out[j] = null
        return walk(i, j + 1)
      }
      return false
    }
    return walk(0, 0) ? out : null
  }
  /** An object argument's properties against the schema's: an error after the colon, or null. */
  const checkProperties = (param: string, value: unknown, allowed: Record<string, string>): string | null => {
    if (!isObject(value)) return null
    const names = objectKeys(value as object)
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!
      const want = name === 'name' || name === 'includeTlsChannelId' ? allowed[name] : undefined
      if (!want) return `Error at parameter '${param}': Unexpected property: '${name}'.`
      const v = (value as Bag)[name] as unknown
      if (v !== undefined && v !== null && typeof v !== want) return `Error at parameter '${param}': Error at property '${name}': Invalid type: expected ${want}, found ${typeName(v)}.`
    }
    return null
  }
  /** crx_file::id_util::IdIsValid: 32 letters from a to p, either case. */
  const validId = (id: string): boolean => {
    if (id.length !== 32) return false
    const lower = apply(stringLower, id, []) as string
    for (let i = 0; i < lower.length; i++) {
      const c = lower.charCodeAt(i)
      if (c < 97 || c > 112) return false
    }
    return true
  }
  /** messaging_util.cc GetTargetExtensionId, for a web page. */
  const targetError = (method: string, id: unknown): string | null => {
    if (id === null || id === undefined || id === '') return `chrome.${method}() called from a webpage must specify an Extension ID (string) for its first argument.`
    return validId(id as string) ? null : `Invalid extension id: '${String(id)}'`
  }
  const withLastError = (runtime: object, run: () => void): void => {
    put(runtime, 'lastError', plain({ message: NO_RECEIVER }))
    try {
      run()
    } finally {
      deleteProperty(runtime, 'lastError')
    }
  }
  /** A chrome Event a page can listen on. */
  const makeEvent = (): { event: object; fire(...args: unknown[]): void } => {
    const listeners: unknown[] = []
    const fns = {
      addListener() {
        const cb = arguments[0] as unknown
        if (typeof cb === 'function' && apply(arrayIndexOf, listeners, [cb]) === -1) apply(arrayPush, listeners, [cb])
      },
      removeListener() {
        const at = apply(arrayIndexOf, listeners, [arguments[0]]) as number
        if (at !== -1) apply(arraySplice, listeners, [at, 1])
      },
      hasListener() {
        return apply(arrayIndexOf, listeners, [arguments[0]]) !== -1
      },
      hasListeners() {
        return listeners.length > 0
      },
    }
    const event = plain({
      addListener: native(fns.addListener, 'addListener'),
      removeListener: native(fns.removeListener, 'removeListener'),
      hasListener: native(fns.hasListener, 'hasListener'),
      hasListeners: native(fns.hasListeners, 'hasListeners'),
    })
    return {
      event,
      fire: (...args) => {
        const list = apply(arraySlice, listeners, []) as Fn[]
        for (let i = 0; i < list.length; i++) apply(list[i]!, undefined, args)
      },
    }
  }

  let runtimeObject: object | null = null
  const runtimeFns = {
    connect() {
      const args = apply(arraySlice, arguments, []) as unknown[]
      const parsed = resolve(args, [optional(isString), optional(isObject)])
      if (!parsed) throw invocation(runtimeFns.connect, CONNECT, CONNECT_SIGNATURE, 'No matching signature.')
      const problem = checkProperties('connectInfo', parsed[1], { name: 'string', includeTlsChannelId: 'boolean' }) ?? targetError(CONNECT, parsed[0])
      if (problem) throw invocation(runtimeFns.connect, CONNECT, CONNECT_SIGNATURE, problem)
      // A well-formed id with nothing behind it: the port opens, then disconnects with lastError set.
      const info = parsed[1] as Bag | null
      const name = info && typeof info.name === 'string' ? (info.name as string) : ''
      const onDisconnect = makeEvent()
      const onMessage = makeEvent()
      let open = true
      const portFns = {
        disconnect() {
          open = false
        },
        postMessage() {
          if (!open) throw typeError(portFns.postMessage, 'Attempting to use a disconnected port object')
        },
      }
      const port = plain({
        name,
        disconnect: native(portFns.disconnect, 'disconnect'),
        postMessage: native(portFns.postMessage, 'postMessage'),
        onDisconnect: onDisconnect.event,
        onMessage: onMessage.event,
      })
      later(() => {
        if (!open) return
        open = false
        if (runtimeObject) withLastError(runtimeObject, () => onDisconnect.fire(port))
      })
      return port
    },
    sendMessage() {
      let args = apply(arraySlice, arguments, []) as unknown[]
      // messaging_util.cc MassageSendMessageArguments, options allowed: up to four, a trailing callback first.
      if (args.length > 0 && args.length <= 4) {
        let callback: unknown = null
        let rest = args
        if (typeof args[args.length - 1] === 'function') {
          callback = args[args.length - 1]
          rest = apply(arraySlice, args, [0, -1]) as unknown[]
        }
        if (rest.length === 1) args = [null, rest[0], null, callback]
        else if (rest.length === 2) args = typeof rest[0] === 'string' || rest[0] === null || rest[0] === undefined ? [rest[0], rest[1], null, callback] : [null, rest[0], rest[1], callback]
        else if (rest.length === 3) args = [rest[0], rest[1], rest[2], callback]
      }
      const parsed = resolve(args, [optional(isString), { optional: false, accepts: (v) => v !== undefined }, optional(isObject), optional(isFunction)])
      if (!parsed) throw invocation(runtimeFns.sendMessage, SEND, SEND_SIGNATURE, 'No matching signature.')
      let problem = checkProperties('options', parsed[2], { includeTlsChannelId: 'boolean' }) ?? targetError(SEND, parsed[0])
      if (!problem) {
        try {
          if (stringify(parsed[1]) === undefined) problem = 'Could not serialize message.'
        } catch {
          problem = 'Could not serialize message.'
        }
      }
      if (problem) throw invocation(runtimeFns.sendMessage, SEND, SEND_SIGNATURE, problem)
      const callback = parsed[3] as Fn | null
      if (callback) {
        later(() => {
          if (runtimeObject) withLastError(runtimeObject, () => apply(callback, undefined, []))
        })
      }
      return undefined
    },
  }
  if (!has('runtime')) {
    // Methods, then the enum types by name; each enum's entries sorted by value. runtime.id isn't a web page's.
    runtimeObject = plain({
      connect: native(runtimeFns.connect, 'connect'),
      sendMessage: native(runtimeFns.sendMessage, 'sendMessage'),
      ContextType: plain({ BACKGROUND: 'BACKGROUND', DEVELOPER_TOOLS: 'DEVELOPER_TOOLS', OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT', POPUP: 'POPUP', SIDE_PANEL: 'SIDE_PANEL', TAB: 'TAB' }),
      OnInstalledReason: plain({ CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' }),
      OnRestartRequiredReason: plain({ APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' }),
      PlatformArch: plain({ ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', RISCV64: 'riscv64', X86_32: 'x86-32', X86_64: 'x86-64' }),
      PlatformNaclArch: plain({ ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }),
      PlatformOs: plain({ ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' }),
      RequestUpdateCheckStatus: plain({ NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' }),
    })
    put(chrome, 'runtime', runtimeObject)
  }

  // ---- about:blank frames ----
  // Electron runs no preload in a subframe's about:blank document, so the
  // first page script to reach one (iframe.contentWindow right after it is
  // added) fills it from here; every other frame has its own preload.

  if (!here && IFrameProto && getAttribute) {
    const contentWindow = getOwnPropertyDescriptor(IFrameProto, 'contentWindow')?.get
    const fill = (frame: unknown): void => {
      try {
        const src = apply(getAttribute, frame, ['src'])
        if (src !== null && apply(stringLower, apply(stringTrim, src, []), []) !== 'about:blank' && apply(stringTrim, src, []) !== '') return
        const win = contentWindow ? (apply(contentWindow, frame, []) as Bag | null) : null
        if (!win || win === W) return
        const inner = win.chrome as unknown
        if (inner && typeof inner === 'object' && 'loadTimes' in inner) return
        installChromeSurface(win, state)
      } catch {
        // A frame of another origin: its own preload fills it.
      }
    }
    const getters = ['contentWindow', 'contentDocument']
    for (let i = 0; i < getters.length; i++) {
      const key = getters[i]!
      const desc = getOwnPropertyDescriptor(IFrameProto, key)
      if (!desc || typeof desc.get !== 'function' || !desc.configurable) continue
      const get = new ProxyCtor(desc.get as Fn, {
        apply(original: Fn, self: unknown, args: unknown[]): unknown {
          const value = apply(original, self, args)
          if (value) fill(self)
          return value
        },
      })
      apply(wmSet, state.natives, [get, `function get ${key}() { [native code] }`])
      defineProperty(IFrameProto, key, { ...desc, get })
    }
  }
  return true
}
