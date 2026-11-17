/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The protocol between Apex's extension preloads (src/preload/extensionWorker.ts
// and extensionFrame.ts) and main's shim router (src/main/extensions/shim.ts).
// Calls go one way as invoke(op, payload); events come back on one
// channel as (name, ...args). Main validates every payload with zod and
// checks which extension the sender belongs to.

/** Extension service workers and pages → main. */
export const EXT_SHIM_INVOKE = 'apex-ext:invoke'
/** Main → extension service workers and pages. */
export const EXT_SHIM_EVENT = 'apex-ext:event'
/** The Chrome Web Store page → main (exact origin, main frame only). */
export const WEB_STORE_INVOKE = 'apex-webstore:invoke'

export const EXT_SHIM_OPS = [
  'action.setBadgeText',
  'action.getBadgeText',
  'action.setBadgeBackgroundColor',
  'action.getBadgeBackgroundColor',
  'action.setTitle',
  'action.getTitle',
  'action.setPopup',
  'action.getPopup',
  'action.enable',
  'action.disable',
  'action.isEnabled',
  'action.setIcon',
  'action.openPopup',
  'commands.getAll',
  'contextMenus.create',
  'contextMenus.update',
  'contextMenus.remove',
  'contextMenus.removeAll',
  'declarativeContent.addRules',
  'declarativeContent.removeRules',
  'declarativeContent.getRules',
  'native.connect',
  'native.post',
  'native.disconnect',
  'native.send',
  'permissions.getAll',
  'permissions.contains',
  'permissions.request',
  'permissions.remove',
  'privacy.get',
  'privacy.set',
  'privacy.clear',
  'tabs.create',
  'tabs.query',
  'tabs.listen',
  'webNavigation.getFrame',
  'webNavigation.getAllFrames',
  'windows.getAll',
  'runtime.openOptionsPage',
  'window.close',
] as const

export type ExtShimOp = (typeof EXT_SHIM_OPS)[number]

/** The chrome.tabs events main sends: an extension hears one once its shim adds a listener for it. */
export const EXT_TAB_EVENTS = ['tabs.onCreated', 'tabs.onActivated', 'tabs.onUpdated', 'tabs.onRemoved'] as const

export type ExtTabEvent = (typeof EXT_TAB_EVENTS)[number]

/** chrome.webNavigation's events, from each tab's frames. */
export const EXT_NAV_EVENTS = [
  'webNavigation.onBeforeNavigate',
  'webNavigation.onCommitted',
  'webNavigation.onDOMContentLoaded',
  'webNavigation.onCompleted',
  'webNavigation.onErrorOccurred',
  'webNavigation.onHistoryStateUpdated',
  'webNavigation.onReferenceFragmentUpdated',
  'webNavigation.onTabReplaced',
] as const

export type ExtNavEvent = (typeof EXT_NAV_EVENTS)[number]

export const EXT_WINDOW_EVENTS = ['windows.onCreated', 'windows.onRemoved', 'windows.onFocusChanged'] as const

/**
 * Every event a context hears only once its shim adds a listener (the
 * 'tabs.listen' op registers any of them): tabs, webNavigation, windows, a
 * browser setting's onChange and context-menu clicks.
 */
export const EXT_LISTEN_EVENTS = [...EXT_TAB_EVENTS, ...EXT_NAV_EVENTS, ...EXT_WINDOW_EVENTS, 'privacy.onChange', 'contextMenus.onClicked'] as const

export type ExtListenEvent = (typeof EXT_LISTEN_EVENTS)[number]

export const EXT_SHIM_EVENTS = ['action.onClicked', 'commands.onCommand', 'native.message', 'native.disconnect', 'permissions.onAdded', 'permissions.onRemoved', ...EXT_LISTEN_EVENTS] as const

export type ExtShimEvent = (typeof EXT_SHIM_EVENTS)[number]

export const WEB_STORE_OPS = [
  'beginInstall',
  'completeInstall',
  'getExtensionStatus',
  'getFullChromeVersion',
  'getBrowserLogin',
  'getStoreLogin',
  'setStoreLogin',
  'isInIncognitoMode',
  'getIsLauncherEnabled',
  'enableAppLauncher',
  'getMV2DeprecationStatus',
  'getWebGLStatus',
  'isPendingCustodianApproval',
  'getReferrerChain',
  'install',
  'management.getAll',
  'management.setEnabled',
  'management.uninstall',
] as const

export type WebStoreOp = (typeof WEB_STORE_OPS)[number]
