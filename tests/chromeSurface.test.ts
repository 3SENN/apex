/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { runInContext, createContext, type Context } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ contextBridge: {} }))

import { installChromeSurface } from '../src/preload/chromeSurfaceWorld'
import { CHROME_SURFACE_PRELOAD_ID, installChromeSurface as registerChromeSurface } from '../src/main/chromeSurface'

// The chrome surface (preload/chromeSurfaceWorld.ts): window.chrome as stock
// desktop Chrome 156 gives a web page. Each test runs the function the way
// contextBridge.executeInMainWorld does, serialised into a realm of its own,
// so it can't reach anything outside itself and this process's
// Function.prototype.toString stays untouched.

const SOURCE = installChromeSurface.toString()

/** A fresh realm with the given globals, the surface installed in it. */
function realm(globals: Record<string, unknown> = {}, install = true): Context {
  const ctx = createContext({ setTimeout, ...globals })
  if (install) expect(runInContext(`(${SOURCE})()`, ctx)).toBe(true)
  return ctx
}
const run = <T = unknown>(ctx: Context, code: string): T => runInContext(code, ctx) as T
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

const RUNTIME_ENUMS = {
  ContextType: { BACKGROUND: 'BACKGROUND', DEVELOPER_TOOLS: 'DEVELOPER_TOOLS', OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT', POPUP: 'POPUP', SIDE_PANEL: 'SIDE_PANEL', TAB: 'TAB' },
  OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
  OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
  PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', RISCV64: 'riscv64', X86_32: 'x86-32', X86_64: 'x86-64' },
  PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
  PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
  RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
}
const VALID_ID = 'abcdefghijklmnopabcdefghijklmnop'

describe('the chrome surface: shape', () => {
  it('is one self-contained, strict function', () => {
    expect(SOURCE).toMatch(/^function installChromeSurface\(/)
    expect(SOURCE).toMatch(/["']use strict["']/)
  })

  it('fills window.chrome with loadTimes, csi, app and runtime, in Chrome’s order', () => {
    const ctx = realm()
    expect(run(ctx, 'Object.keys(chrome)')).toEqual(['loadTimes', 'csi', 'app', 'runtime'])
    expect(run(ctx, 'Object.keys(chrome.app)')).toEqual(['isInstalled', 'getDetails', 'getIsInstalled', 'installState', 'runningState', 'InstallState', 'RunningState'])
    expect(run(ctx, 'Object.keys(chrome.runtime)')).toEqual(['connect', 'sendMessage', ...Object.keys(RUNTIME_ENUMS)])
    // runtime.id and lastError are not a web page's (until a callback runs with an error).
    expect(run(ctx, "'id' in chrome.runtime || 'lastError' in chrome.runtime")).toBe(false)
    expect(run(ctx, "JSON.stringify(Object.getOwnPropertyDescriptor(globalThis, 'chrome'), ['writable', 'enumerable', 'configurable'])")).toBe('{"writable":true,"enumerable":true,"configurable":true}')
  })

  it('has Chrome’s enums', () => {
    const ctx = realm()
    expect(JSON.parse(run(ctx, 'JSON.stringify({ InstallState: chrome.app.InstallState, RunningState: chrome.app.RunningState })'))).toEqual({
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    })
    const runtime = JSON.parse(run(ctx, 'JSON.stringify(chrome.runtime)'))
    expect(runtime).toEqual(RUNTIME_ENUMS)
    // Key order inside each enum is Chrome's too (sorted by value).
    for (const [name, values] of Object.entries(RUNTIME_ENUMS)) expect(Object.keys(runtime[name])).toEqual(Object.keys(values))
  })

  it('reads as native code: toString, name, length, no prototype on API methods', () => {
    const ctx = realm()
    const fns: [string, string, number][] = [
      ['chrome.loadTimes', '', 0],
      ['chrome.csi', '', 0],
      ['chrome.app.getDetails', 'getDetails', 0],
      ['chrome.app.getIsInstalled', 'getIsInstalled', 0],
      ['chrome.app.installState', 'installState', 0],
      ['chrome.app.runningState', 'runningState', 0],
      ['chrome.runtime.connect', 'connect', 0],
      ['chrome.runtime.sendMessage', 'sendMessage', 0],
    ]
    for (const [path, name, length] of fns) {
      expect(run(ctx, `Function.prototype.toString.call(${path})`), path).toBe(`function ${name}() { [native code] }`)
      expect(run(ctx, `String(${path})`), path).toBe(`function ${name}() { [native code] }`)
      expect(run(ctx, `[${path}.name, ${path}.length]`), path).toEqual([name, length])
      expect(run(ctx, `Object.getPrototypeOf(${path}) === Function.prototype`), path).toBe(true)
    }
    // The bindings' methods (FunctionTemplate, kThrow): no prototype, not constructors, no caller/arguments.
    expect(run(ctx, 'Object.getOwnPropertyNames(chrome.app.getDetails)')).toEqual(['length', 'name'])
    expect(() => run(ctx, 'new chrome.runtime.sendMessage()')).toThrow(/not a constructor/)
    // loadTimes and csi (v8::Function::New): anonymous and constructible, as in Chrome.
    expect(run(ctx, 'Object.getOwnPropertyNames(chrome.loadTimes)')).toEqual(['length', 'name', 'prototype'])
    // Function.prototype.toString itself, however it is reached.
    expect(run(ctx, 'Function.prototype.toString.toString()')).toBe('function toString() { [native code] }')
    expect(run(ctx, 'Function.prototype.toString.call(Function.prototype.toString)')).toBe('function toString() { [native code] }')
    expect(run(ctx, '[Function.prototype.toString.name, Function.prototype.toString.length]')).toEqual(['toString', 0])
    expect(run(ctx, "JSON.stringify(Object.getOwnPropertyDescriptor(Function.prototype, 'toString'), ['writable', 'enumerable', 'configurable'])")).toBe('{"writable":true,"enumerable":false,"configurable":true}')
    // Everything else is untouched.
    expect(run(ctx, 'String(function page(a, b) { return a + b })')).toBe('function page(a, b) { return a + b }')
    expect(run(ctx, 'String(Math.max)')).toBe('function max() { [native code] }')
  })

  it('keeps the native toString’s error, with no frame of its own in the stack', () => {
    const ctx = realm()
    const [name, message, stack] = run<[string, string, string]>(ctx, `(function caller() { try { Function.prototype.toString.call({}) } catch (e) { return [e.name, e.message, e.stack] } })()`)
    expect(name).toBe('TypeError')
    expect(message).toBe("Function.prototype.toString requires that 'this' be a Function")
    expect(stack.split('\n')[1]).toMatch(/\(<anonymous>\)$/)
    expect(stack.split('\n')[2]).toMatch(/at caller /)
    expect(stack).not.toMatch(/at (Object\.)?apply/)
  })

  it('is made of plain data properties of the page’s own realm', () => {
    const ctx = realm()
    const report = run<string[]>(
      ctx,
      `(() => {
        const bad = []
        const walk = (o, path) => {
          if (Object.getPrototypeOf(o) !== (typeof o === 'function' ? Function.prototype : Object.prototype)) bad.push(path + ': prototype')
          if (typeof o === 'function') return
          for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(o))) {
            if (d.get || d.set || !d.writable || !d.enumerable || !d.configurable) bad.push(path + '.' + k)
            if (d.value && (typeof d.value === 'object' || typeof d.value === 'function')) walk(d.value, path + '.' + k)
          }
        }
        walk(chrome, 'chrome')
        walk(chrome.loadTimes(), 'loadTimes()')
        walk(chrome.csi(), 'csi()')
        return bad
      })()`,
    )
    expect(report).toEqual([])
  })
})

describe('the chrome surface: behaviour', () => {
  it('answers chrome.app as a page that is no installed app', async () => {
    const ctx = realm()
    expect(run(ctx, '[chrome.app.isInstalled, chrome.app.getDetails(), chrome.app.getIsInstalled(), chrome.app.runningState()]')).toEqual([false, null, false, 'cannot_run'])
    run(ctx, 'globalThis.states = []; chrome.app.installState((s) => states.push(s))')
    expect(run(ctx, 'states.length')).toBe(0)
    await tick()
    expect(run(ctx, 'states')).toEqual(['not_installed'])
  })

  it('throws the bindings’ invocation errors for chrome.app', () => {
    const ctx = realm()
    const err = (code: string): [string, string] => run(ctx, `(() => { try { ${code}; return ['', 'no error'] } catch (e) { return [e.constructor === TypeError ? 'TypeError' : 'other', e.message] } })()`)
    expect(err('chrome.app.getDetails(1)')).toEqual(['TypeError', 'Error in invocation of app.getDetails(): '])
    expect(err('chrome.app.getIsInstalled(undefined)')).toEqual(['TypeError', 'Error in invocation of app.getIsInstalled(): '])
    expect(err('chrome.app.runningState(1)')).toEqual(['TypeError', 'Error in invocation of app.runningState(): '])
    expect(err('chrome.app.installState()')).toEqual(['TypeError', 'Error in invocation of app.installState(function callback): '])
    expect(err('chrome.app.installState(1)')).toEqual(['TypeError', 'Error in invocation of app.installState(function callback): '])
    // The stack starts at the page's call, as for a native function.
    expect(run(ctx, `(function page() { try { chrome.app.getDetails(1) } catch (e) { return e.stack.split('\\n')[1] } })()`)).toMatch(/at page /)
  })

  it('validates runtime.sendMessage and runtime.connect as Chrome does for a web page', () => {
    const ctx = realm()
    const msg = (code: string): string => run(ctx, `(() => { try { ${code}; return 'no error' } catch (e) { return (e instanceof TypeError ? '' : 'not a TypeError: ') + e.message } })()`)
    const send = 'Error in invocation of runtime.sendMessage(optional string extensionId, any message, optional object options, optional function callback): '
    const connect = 'Error in invocation of runtime.connect(optional string extensionId, optional object connectInfo): '
    expect(msg('chrome.runtime.sendMessage()')).toBe(`${send}No matching signature.`)
    expect(msg('chrome.runtime.sendMessage(1, 2, 3, 4, 5)')).toBe(`${send}No matching signature.`)
    expect(msg("chrome.runtime.sendMessage('hello')")).toBe(`${send}chrome.runtime.sendMessage() called from a webpage must specify an Extension ID (string) for its first argument.`)
    expect(msg("chrome.runtime.sendMessage({ a: 1 }, () => {})")).toBe(`${send}chrome.runtime.sendMessage() called from a webpage must specify an Extension ID (string) for its first argument.`)
    expect(msg("chrome.runtime.sendMessage('abc', 'hello')")).toBe(`${send}Invalid extension id: 'abc'`)
    expect(msg(`chrome.runtime.sendMessage('${VALID_ID}', 'hi', { nope: 1 })`)).toBe(`${send}Error at parameter 'options': Unexpected property: 'nope'.`)
    expect(msg(`chrome.runtime.sendMessage('${VALID_ID}', () => 1, {})`)).toBe(`${send}Could not serialize message.`)
    expect(msg(`chrome.runtime.sendMessage('${VALID_ID}', 'hi')`)).toBe('no error')
    expect(msg(`chrome.runtime.sendMessage('${VALID_ID.toUpperCase()}', { a: 1 }, {}, () => {})`)).toBe('no error')
    expect(msg('chrome.runtime.connect()')).toBe(`${connect}chrome.runtime.connect() called from a webpage must specify an Extension ID (string) for its first argument.`)
    expect(msg("chrome.runtime.connect('')")).toBe(`${connect}chrome.runtime.connect() called from a webpage must specify an Extension ID (string) for its first argument.`)
    expect(msg('chrome.runtime.connect({})')).toBe(`${connect}chrome.runtime.connect() called from a webpage must specify an Extension ID (string) for its first argument.`)
    expect(msg("chrome.runtime.connect('abc')")).toBe(`${connect}Invalid extension id: 'abc'`)
    expect(msg('chrome.runtime.connect(1)')).toBe(`${connect}No matching signature.`)
    expect(msg("chrome.runtime.connect('a', 'b')")).toBe(`${connect}No matching signature.`)
    expect(msg('chrome.runtime.connect({ name: 1 })')).toBe(`${connect}Error at parameter 'connectInfo': Error at property 'name': Invalid type: expected string, found integer.`)
    expect(msg('chrome.runtime.connect({ other: true })')).toBe(`${connect}Error at parameter 'connectInfo': Unexpected property: 'other'.`)
  })

  it('finds no receiver behind a well-formed id: the callback and onDisconnect see lastError', async () => {
    const ctx = realm()
    run(ctx, `globalThis.seen = []; chrome.runtime.sendMessage('${VALID_ID}', 'hi', (r) => seen.push(['send', r, chrome.runtime.lastError && chrome.runtime.lastError.message]))`)
    run(ctx, `globalThis.port = chrome.runtime.connect('${VALID_ID}', { name: 'p' }); port.onDisconnect.addListener((p) => seen.push(['port', p === port, chrome.runtime.lastError && chrome.runtime.lastError.message]))`)
    expect(run(ctx, '[port.name, typeof port.postMessage, port.onDisconnect.hasListeners(), seen.length]')).toEqual(['p', 'function', true, 0])
    await tick()
    const none = 'Could not establish connection. Receiving end does not exist.'
    expect(run(ctx, 'seen')).toEqual([
      ['send', undefined, none],
      ['port', true, none],
    ])
    expect(run(ctx, "'lastError' in chrome.runtime")).toBe(false)
    expect(() => run(ctx, 'port.postMessage(1)')).toThrow('Attempting to use a disconnected port object')
  })
})

/** A page's performance object: the legacy timing, the navigation entry and first paint. */
function fakePerformance(opts: { start: number; type?: string; protocol?: string; loaded?: boolean; paint?: number | null }): Record<string, unknown> {
  const start = opts.start
  const legacy = {
    navigationStart: start,
    responseStart: start + 120,
    domContentLoadedEventEnd: opts.loaded === false ? 0 : start + 400,
    loadEventEnd: opts.loaded === false ? 0 : start + 650,
  }
  class Performance {
    get timing(): typeof legacy {
      return legacy
    }
    get timeOrigin(): number {
      return start + 0.4
    }
    now(): number {
      return 1234.5
    }
    getEntriesByType(type: string): unknown[] {
      if (type === 'navigation') return [{ type: opts.type ?? 'navigate', nextHopProtocol: opts.protocol ?? 'h2' }]
      if (type === 'paint') return opts.paint === null ? [] : [{ name: 'first-paint', startTime: opts.paint ?? 300.2 }]
      return []
    }
  }
  return { Performance, performance: new Performance() }
}

describe('the chrome surface: loadTimes() and csi()', () => {
  const start = 1_761_800_000_123

  it('gives Chrome’s fields, in order, from the page’s own timing', () => {
    const ctx = realm({ ...fakePerformance({ start }), location: { protocol: 'https:' } })
    const lt = run<Record<string, unknown>>(ctx, 'chrome.loadTimes()')
    expect(Object.keys(lt)).toEqual([
      'requestTime',
      'startLoadTime',
      'commitLoadTime',
      'finishDocumentLoadTime',
      'finishLoadTime',
      'firstPaintTime',
      'firstPaintAfterLoadTime',
      'navigationType',
      'wasFetchedViaSpdy',
      'wasNpnNegotiated',
      'npnNegotiatedProtocol',
      'wasAlternateProtocolAvailable',
      'connectionInfo',
    ])
    expect(lt).toEqual({
      requestTime: start / 1000,
      startLoadTime: start / 1000,
      commitLoadTime: (start + 120) / 1000,
      finishDocumentLoadTime: (start + 400) / 1000,
      finishLoadTime: (start + 650) / 1000,
      firstPaintTime: Math.floor(start + 0.4 + 300.2) / 1000,
      firstPaintAfterLoadTime: 0,
      navigationType: 'Other',
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true,
      npnNegotiatedProtocol: 'h2',
      wasAlternateProtocolAvailable: false,
      connectionInfo: 'h2',
    })
    const csi = run<Record<string, number>>(ctx, 'chrome.csi()')
    expect(Object.keys(csi)).toEqual(['startE', 'onloadT', 'pageT', 'tran'])
    expect(csi.startE).toBe(start)
    expect(csi.onloadT).toBe(start + 400)
    expect(csi.pageT).toBeCloseTo(1234.9, 3)
    expect(csi.tran).toBe(15)
  })

  it('says 0 for what hasn’t happened, and follows the navigation type and protocol', () => {
    const early = realm({ ...fakePerformance({ start, loaded: false, paint: null, type: 'reload', protocol: 'http/1.1' }), location: { protocol: 'http:' } })
    expect(run(early, 'chrome.loadTimes()')).toMatchObject({ finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintTime: 0, navigationType: 'Reload', wasFetchedViaSpdy: false, wasNpnNegotiated: false, npnNegotiatedProtocol: 'unknown', connectionInfo: 'http/1.1' })
    expect(run(early, 'chrome.csi()')).toMatchObject({ onloadT: 0, tran: 16 })
    const back = realm({ ...fakePerformance({ start, type: 'back_forward', protocol: 'h3' }), location: { protocol: 'https:' } })
    expect(run(back, 'chrome.loadTimes()')).toMatchObject({ navigationType: 'BackForward', wasFetchedViaSpdy: true, npnNegotiatedProtocol: 'h3', connectionInfo: 'h3' })
    expect(run(back, 'chrome.csi().tran')).toBe(6)
  })
})

describe('the chrome surface: filling only what is missing', () => {
  it('keeps what Chromium (or an extension) already put on window.chrome', () => {
    const ctx = realm({}, false)
    run(ctx, "globalThis.chrome = { runtime: { id: 'x' }, loadTimes: function own() {} }; globalThis.before = [chrome.runtime, chrome.loadTimes]")
    run(ctx, `(${SOURCE})()`)
    expect(run(ctx, 'chrome.runtime === before[0] && chrome.loadTimes === before[1]')).toBe(true)
    expect(run(ctx, 'Object.keys(chrome)')).toEqual(['runtime', 'loadTimes', 'csi', 'app'])
    expect(run(ctx, 'String(chrome.loadTimes)')).toBe('function own() {}')
  })

  it('installs once per realm', () => {
    const ctx = realm()
    run(ctx, 'globalThis.first = [Function.prototype.toString, chrome.app]')
    run(ctx, `(${SOURCE})()`)
    expect(run(ctx, 'Function.prototype.toString === first[0] && chrome.app === first[1]')).toBe(true)
    expect(run(ctx, 'String(chrome.app.getDetails)')).toBe('function getDetails() { [native code] }')
  })

  it('reads as native across a page’s same-origin realms', () => {
    const top = realm()
    const frame = realm({ parent: run(top, 'globalThis') })
    expect(run(frame, 'globalThis.parent === globalThis')).toBe(false)
    const parentChrome = run(top, 'chrome')
    const frameToString = run<(this: unknown) => string>(frame, 'Function.prototype.toString')
    expect(frameToString.call((parentChrome as { app: { getDetails: unknown } }).app.getDetails)).toBe('function getDetails() { [native code] }')
    const topToString = run<(this: unknown) => string>(top, 'Function.prototype.toString')
    expect(topToString.call(run(frame, 'chrome.csi'))).toBe('function () { [native code] }')
  })

  it('fills an about:blank iframe the page reaches, in that frame’s own realm', () => {
    const child = realm({}, false)
    const childGlobal = run(child, 'globalThis')
    const page = realm({}, false)
    // A DOM's iframe element, as far as the surface uses it.
    run(page, `
      class Element { getAttribute(name) { return this.attrs[name] ?? null } }
      class HTMLIFrameElement extends Element {}
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { get: function () { return this.win }, enumerable: true, configurable: true })
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', { get: function () { return this.win ? {} : null }, enumerable: true, configurable: true })
      globalThis.Element = Element
      globalThis.HTMLIFrameElement = HTMLIFrameElement
    `)
    run(page, `(${SOURCE})()`)
    const make = run<(win: unknown, attrs: Record<string, string>) => unknown>(page, '(win, attrs) => Object.assign(new HTMLIFrameElement(), { win, attrs })')
    // An iframe with a real src: its own preload fills it, so the page's getter leaves it alone.
    const elsewhere = make(childGlobal, { src: 'https://example.com/' }) as { contentWindow: unknown }
    expect(elsewhere.contentWindow).toBe(childGlobal)
    expect(run(child, 'typeof globalThis.chrome')).toBe('undefined')
    // A srcless one is about:blank: filled on first reach.
    const blank = make(childGlobal, {}) as { contentWindow: unknown }
    expect(blank.contentWindow).toBe(childGlobal)
    expect(run(child, 'Object.keys(chrome)')).toEqual(['loadTimes', 'csi', 'app', 'runtime'])
    expect(run(child, 'Object.getPrototypeOf(chrome.app) === Object.prototype && Object.getPrototypeOf(chrome.loadTimes) === Function.prototype')).toBe(true)
    expect(run(child, 'String(chrome.app.getDetails)')).toBe('function getDetails() { [native code] }')
    expect(() => run(child, 'chrome.app.getDetails(1)')).toThrow(run(child, 'TypeError') as ErrorConstructor)
    // The getter itself still reads as Chrome's.
    expect(run(page, "String(Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow').get)")).toBe('function get contentWindow() { [native code] }')
  })
})

describe('the chrome surface preload registration', () => {
  it('registers one frame preload per session', () => {
    const scripts: { id: string; type: string; filePath: string }[] = []
    const session = { getPreloadScripts: () => scripts, registerPreloadScript: (s: { id: string; type: string; filePath: string }) => void scripts.push(s) }
    expect(registerChromeSurface(session as never, '/out/preload/chromeSurface.js')).toBe(true)
    expect(registerChromeSurface(session as never, '/out/preload/chromeSurface.js')).toBe(true)
    expect(scripts).toEqual([{ id: CHROME_SURFACE_PRELOAD_ID, type: 'frame', filePath: '/out/preload/chromeSurface.js' }])
    expect(registerChromeSurface({} as never, '/x.js')).toBe(false)
  })
})
