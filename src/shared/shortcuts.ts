/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Every keyboard-table row (feature-spec "Keyboard shortcuts"), in one
// table that the ShortcutRouter, the native menus, tooltips, the ⌘/ sheet
// and the main menu all read. Keys are Electron accelerator strings per
// platform; `accelerator` is what the menu shows.
// Context keys (inside the address field, the composer, a seam) live with
// their surface, not here. Labels are i18n keys.
import type { MessageKey } from './i18n/en'

export type ShortcutGroup = 'tabs' | 'windows' | 'navigation' | 'address' | 'find' | 'zoom' | 'view' | 'chat' | 'bookmarks' | 'edit' | 'tools' | 'help'

export interface ShortcutDef {
  id: ShortcutId
  keys: { mac: string; other: string }
  accelerator: string
  /** Shown through t; runtime shortcuts bring their own text in `title`. */
  label: MessageKey
  group: ShortcutGroup
  /** Always goes to the browser, even when a page would handle the key. */
  overridesPage: boolean
  when: 'any' | 'website' | 'apex-page'
  /** On an agent-controlled tab, waits and shows a take-over-first toast. */
  waitsForTakeOver?: boolean
}

/** A row the router never registers as an accelerator: a hold or a key sequence the key-state machine handles. */
export const HOLD_PREFIX = 'Hold+'

const row = (
  id: ShortcutId,
  accelerator: string,
  label: MessageKey,
  group: ShortcutGroup,
  opts: { other?: string; overridesPage?: boolean; when?: ShortcutDef['when']; waitsForTakeOver?: boolean } = {},
): ShortcutDef => ({
  id,
  keys: { mac: accelerator.replace(/CmdOrCtrl/g, 'Cmd'), other: opts.other ?? accelerator.replace(/CmdOrCtrl/g, 'Ctrl') },
  accelerator,
  label,
  group,
  overridesPage: opts.overridesPage ?? false,
  when: opts.when ?? 'any',
  ...(opts.waitsForTakeOver ? { waitsForTakeOver: true } : {}),
})

export const SHORTCUT_IDS = [
  // tabs
  'new-tab',
  'new-tab-in-group',
  'close-tab',
  'reopen-closed',
  'next-tab',
  'previous-tab',
  'next-entry',
  'previous-entry',
  'next-entry-bracket',
  'previous-entry-bracket',
  'select-1',
  'select-2',
  'select-3',
  'select-4',
  'select-5',
  'select-6',
  'select-7',
  'select-8',
  'select-last',
  'move-tab-up',
  'move-tab-down',
  'number-hints',
  // windows
  'new-window',
  'new-private-window',
  'close-window',
  'minimize',
  'minimize-all',
  'toggle-fullscreen',
  'quit',
  // navigation
  'reload',
  'hard-reload',
  'stop',
  'back',
  'forward',
  'back-arrow',
  'forward-arrow',
  // address
  'focus-address',
  'search-tabs-chats',
  // find
  'find',
  'find-next',
  'find-previous',
  // zoom
  'zoom-in',
  'zoom-in-equal',
  'zoom-out',
  'zoom-reset',
  // view
  'toggle-sidebar',
  'switch-layout',
  'toggle-split',
  'toggle-bookmarks-bar',
  'focus-mode',
  // chat
  'toggle-panel',
  'new-chat',
  // bookmarks
  'bookmark-page',
  'bookmark-all-tabs',
  'open-bookmarks',
  // edit
  'copy-url',
  'copy-markdown-link',
  'paste-match-style',
  // tools
  'open-history',
  'open-downloads',
  'open-settings',
  'open-library',
  'print',
  'devtools',
  'console',
  'view-source',
  'clear-data',
  // help
  'shortcuts-sheet',
  'voice-hold-to-talk',
  'voice-read-aloud',
  'report-problem',
  // ── reader shortcut id ── (RD-04)
  'toggle-reader',
] as const

export type ShortcutId = (typeof SHORTCUT_IDS)[number]

export const SHORTCUTS: readonly ShortcutDef[] = [
  row('new-tab', 'CmdOrCtrl+T', 'core.shortcut.newTab', 'tabs', { overridesPage: true }),
  row('new-tab-in-group', 'Alt+CmdOrCtrl+T', 'core.shortcut.newTabInGroup', 'tabs'),
  row('close-tab', 'CmdOrCtrl+W', 'core.shortcut.closeTab', 'tabs', { overridesPage: true, waitsForTakeOver: true }),
  row('reopen-closed', 'CmdOrCtrl+Shift+T', 'core.shortcut.reopenClosed', 'tabs'),
  row('next-tab', 'Ctrl+Tab', 'core.shortcut.nextTab', 'tabs', { overridesPage: true }),
  row('previous-tab', 'Ctrl+Shift+Tab', 'core.shortcut.previousTab', 'tabs', { overridesPage: true }),
  row('next-entry', 'Alt+CmdOrCtrl+Right', 'core.shortcut.nextEntry', 'tabs'),
  row('previous-entry', 'Alt+CmdOrCtrl+Left', 'core.shortcut.previousEntry', 'tabs'),
  row('next-entry-bracket', 'CmdOrCtrl+Shift+]', 'core.shortcut.nextEntryBracket', 'tabs'),
  row('previous-entry-bracket', 'CmdOrCtrl+Shift+[', 'core.shortcut.previousEntryBracket', 'tabs'),
  row('select-1', 'CmdOrCtrl+1', 'core.shortcut.select1', 'tabs'),
  row('select-2', 'CmdOrCtrl+2', 'core.shortcut.select2', 'tabs'),
  row('select-3', 'CmdOrCtrl+3', 'core.shortcut.select3', 'tabs'),
  row('select-4', 'CmdOrCtrl+4', 'core.shortcut.select4', 'tabs'),
  row('select-5', 'CmdOrCtrl+5', 'core.shortcut.select5', 'tabs'),
  row('select-6', 'CmdOrCtrl+6', 'core.shortcut.select6', 'tabs'),
  row('select-7', 'CmdOrCtrl+7', 'core.shortcut.select7', 'tabs'),
  row('select-8', 'CmdOrCtrl+8', 'core.shortcut.select8', 'tabs'),
  row('select-last', 'CmdOrCtrl+9', 'core.shortcut.selectLast', 'tabs'),
  row('move-tab-up', 'Ctrl+Shift+PageUp', 'core.shortcut.moveTabUp', 'tabs'),
  row('move-tab-down', 'Ctrl+Shift+PageDown', 'core.shortcut.moveTabDown', 'tabs'),
  row('number-hints', `${HOLD_PREFIX}CmdOrCtrl`, 'core.shortcut.numberHints', 'tabs'),
  row('new-window', 'CmdOrCtrl+N', 'core.shortcut.newWindow', 'windows'),
  row('new-private-window', 'CmdOrCtrl+Shift+N', 'core.shortcut.newPrivateWindow', 'windows'),
  row('close-window', 'CmdOrCtrl+Shift+W', 'core.shortcut.closeWindow', 'windows'),
  row('minimize', 'CmdOrCtrl+M', 'core.shortcut.minimize', 'windows'),
  row('minimize-all', 'Alt+CmdOrCtrl+M', 'core.shortcut.minimizeAll', 'windows'),
  row('toggle-fullscreen', 'Ctrl+Cmd+F', 'core.shortcut.toggleFullscreen', 'windows', { other: 'F11' }),
  row('quit', 'CmdOrCtrl+Q', 'core.shortcut.quit', 'windows'),
  row('reload', 'CmdOrCtrl+R', 'core.shortcut.reload', 'navigation', { waitsForTakeOver: true }),
  row('hard-reload', 'CmdOrCtrl+Shift+R', 'core.shortcut.hardReload', 'navigation', { waitsForTakeOver: true }),
  row('stop', 'CmdOrCtrl+.', 'core.shortcut.stop', 'navigation', { other: 'Escape' }),
  row('back', 'CmdOrCtrl+[', 'core.shortcut.back', 'navigation', { other: 'Alt+Left', waitsForTakeOver: true }),
  row('forward', 'CmdOrCtrl+]', 'core.shortcut.forward', 'navigation', { other: 'Alt+Right', waitsForTakeOver: true }),
  row('back-arrow', 'CmdOrCtrl+Left', 'core.shortcut.backArrow', 'navigation', { when: 'website', waitsForTakeOver: true }),
  row('forward-arrow', 'CmdOrCtrl+Right', 'core.shortcut.forwardArrow', 'navigation', { when: 'website', waitsForTakeOver: true }),
  row('focus-address', 'CmdOrCtrl+L', 'core.shortcut.focusAddress', 'address', { overridesPage: true }),
  row('search-tabs-chats', 'CmdOrCtrl+Shift+A', 'core.shortcut.searchTabsChats', 'address'),
  row('find', 'CmdOrCtrl+F', 'core.shortcut.find', 'find'),
  row('find-next', 'CmdOrCtrl+G', 'core.shortcut.findNext', 'find'),
  row('find-previous', 'CmdOrCtrl+Shift+G', 'core.shortcut.findPrevious', 'find'),
  row('zoom-in', 'CmdOrCtrl+Plus', 'core.shortcut.zoomIn', 'zoom', { overridesPage: true }),
  row('zoom-in-equal', 'CmdOrCtrl+=', 'core.shortcut.zoomInEqual', 'zoom', { overridesPage: true }),
  row('zoom-out', 'CmdOrCtrl+-', 'core.shortcut.zoomOut', 'zoom', { overridesPage: true }),
  row('zoom-reset', 'CmdOrCtrl+0', 'core.shortcut.zoomReset', 'zoom', { overridesPage: true }),
  row('toggle-sidebar', 'CmdOrCtrl+S', 'core.shortcut.toggleSidebar', 'view'),
  row('switch-layout', 'CmdOrCtrl+Shift+S', 'core.shortcut.switchLayout', 'view'),
  row('toggle-split', 'CmdOrCtrl+\\', 'core.shortcut.toggleSplit', 'view'),
  row('toggle-bookmarks-bar', 'CmdOrCtrl+Shift+B', 'core.shortcut.toggleBookmarksBar', 'view'),
  // A chord unused by the table, browsers and the page editing keys.
  row('focus-mode', 'CmdOrCtrl+Shift+F', 'core.shortcut.focusMode', 'view'),
  row('toggle-panel', 'CmdOrCtrl+J', 'core.shortcut.togglePanel', 'chat', { overridesPage: true }),
  row('new-chat', 'CmdOrCtrl+Shift+E', 'core.shortcut.newChat', 'chat'),
  row('bookmark-page', 'CmdOrCtrl+D', 'core.shortcut.bookmarkPage', 'bookmarks'),
  row('bookmark-all-tabs', 'CmdOrCtrl+Shift+D', 'core.shortcut.bookmarkAllTabs', 'bookmarks'),
  row('open-bookmarks', 'Alt+CmdOrCtrl+B', 'core.shortcut.openBookmarks', 'bookmarks'),
  row('copy-url', 'CmdOrCtrl+Shift+C', 'core.shortcut.copyUrl', 'edit'),
  row('copy-markdown-link', 'Alt+CmdOrCtrl+Shift+C', 'core.shortcut.copyMarkdownLink', 'edit'),
  row('paste-match-style', 'CmdOrCtrl+Shift+V', 'core.shortcut.pasteMatchStyle', 'edit'),
  row('open-history', 'CmdOrCtrl+Y', 'core.shortcut.openHistory', 'tools', { other: 'Ctrl+H' }),
  row('open-downloads', 'CmdOrCtrl+Shift+J', 'core.shortcut.openDownloads', 'tools'),
  row('open-settings', 'CmdOrCtrl+,', 'core.shortcut.openSettings', 'tools'),
  row('open-library', 'CmdOrCtrl+Shift+L', 'core.shortcut.openLibrary', 'tools'),
  row('print', 'CmdOrCtrl+P', 'core.shortcut.print', 'tools'),
  row('devtools', 'Alt+CmdOrCtrl+I', 'core.shortcut.devtools', 'tools', { other: 'Ctrl+Shift+I' }),
  row('console', 'Alt+CmdOrCtrl+J', 'core.shortcut.console', 'tools', { other: 'Ctrl+Shift+K' }),
  row('view-source', 'Alt+CmdOrCtrl+U', 'core.shortcut.viewSource', 'tools', { other: 'Ctrl+U' }),
  row('clear-data', 'CmdOrCtrl+Shift+Backspace', 'core.shortcut.clearData', 'tools'),
  row('shortcuts-sheet', 'CmdOrCtrl+/', 'core.shortcut.shortcutsSheet', 'help'),
  // Holds, never accelerators: the voice input interceptor sees them. The chord follows settings.voice.chord.
  row('voice-hold-to-talk', `${HOLD_PREFIX}Alt+Space`, 'voice.shortcut.holdToTalk', 'chat'),
  row('voice-read-aloud', `${HOLD_PREFIX}Alt+Shift+Space`, 'voice.shortcut.readAloud', 'chat'),
  // KS-SHIFT-CMD-H: Help › Report a Problem….
  row('report-problem', 'CmdOrCtrl+Shift+H', 'diagnostics.menu.reportProblem', 'help', { overridesPage: true }),
  // ── reader shortcut ── (RD-04: ⇧⌘R is Force Reload, so the reader takes ⌥⌘R)
  row('toggle-reader', 'Alt+CmdOrCtrl+R', 'reader.shortcut.toggle', 'view', { other: 'Ctrl+Alt+R' }),
]

/** Commands that only menus run (no chord). */
export const MENU_ONLY_COMMANDS = [
  'about',
  'check-default-browser',
  'save-page',
  'save-as-pdf',
  'share',
  'qr-code',
  'task-manager',
  'import-data',
  'bookmark-manager',
  'show-all-history',
  'close-other-tabs',
  // DC-18: Group tabs, from the command bar and the tab menus.
  'group-tabs',
  'actual-size',
  'help',
  'open-passwords',
  'open-meetings',
  // The update and what's-new items; the feedback and logs items.
  'check-for-updates',
  'whats-new',
  'send-feedback',
  'show-logs',
] as const

export type CommandId = ShortcutId | (typeof MENU_ONLY_COMMANDS)[number]

const COMMAND_IDS = new Set<string>([...SHORTCUT_IDS, ...MENU_ONLY_COMMANDS])

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && COMMAND_IDS.has(value)
}

export function shortcutById(id: ShortcutId): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id)
}

const MAC_CAPS: Record<string, string> = {
  cmd: '⌘', command: '⌘', ctrl: '⌃', control: '⌃', alt: '⌥', option: '⌥', shift: '⇧',
  left: '←', right: '→', up: '↑', down: '↓', enter: '↩', return: '↩', backspace: '⌫', delete: '⌦',
  tab: '⇥', escape: 'Esc', space: 'Space', plus: '+', pageup: 'Page Up', pagedown: 'Page Down',
}
const OTHER_CAPS: Record<string, string> = {
  cmd: 'Win', command: 'Win', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift',
  left: '←', right: '→', up: '↑', down: '↓', enter: 'Enter', return: 'Enter', backspace: 'Backspace', delete: 'Del',
  tab: 'Tab', escape: 'Esc', space: 'Space', plus: '+', pageup: 'PgUp', pagedown: 'PgDn',
}
// macOS lists modifiers in this order (⌃⌥⇧⌘); others read Ctrl+Alt+Shift.
const MODIFIER_ORDER = ['ctrl', 'control', 'alt', 'option', 'shift', 'cmd', 'command']

/** The key caps for a row on a platform: ['⇧', '⌘', 'T'] on macOS, ['Ctrl', 'Shift', 'T'] elsewhere; a hold row starts with 'Hold'. */
export function formatKeys(def: Pick<ShortcutDef, 'keys'>, platform: string): string[] {
  const mac = platform === 'darwin'
  let keys = mac ? def.keys.mac : def.keys.other
  const caps: string[] = []
  if (keys.startsWith(HOLD_PREFIX)) {
    caps.push('Hold')
    keys = keys.slice(HOLD_PREFIX.length)
  }
  const tokens = keys.endsWith('++') ? [...keys.slice(0, -2).split('+'), '+'] : keys.split('+')
  const table = mac ? MAC_CAPS : OTHER_CAPS
  const modifiers = tokens.filter((t) => MODIFIER_ORDER.includes(t.toLowerCase()))
  const rest = tokens.filter((t) => t !== '' && !MODIFIER_ORDER.includes(t.toLowerCase()))
  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a.toLowerCase()) - MODIFIER_ORDER.indexOf(b.toLowerCase()))
  for (const t of [...modifiers, ...rest]) caps.push(table[t.toLowerCase()] ?? (t.length === 1 ? t.toUpperCase() : t))
  return caps
}
