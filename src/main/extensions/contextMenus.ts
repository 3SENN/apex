/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// chrome.contextMenus: an extension's items in the page's context
// menu. Items are kept per extension (Chrome keeps them across restarts for
// Manifest V3 workers) and drawn in the page menu's extensions section: one
// item stands on its own, several sit in a submenu named after the
// extension, as in Chrome. A click reaches the extension as
// contextMenus.onClicked with Chrome's OnClickData and the tab.

export const MENU_CONTEXTS = ['all', 'page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio', 'launcher', 'browser_action', 'page_action', 'action'] as const
export type MenuContext = (typeof MENU_CONTEXTS)[number]
export type MenuItemType = 'normal' | 'checkbox' | 'radio' | 'separator'

export interface MenuItem {
  /** Chrome allows string or integer ids; integers are kept as their decimal string with `numeric` set. */
  id: string
  numeric: boolean
  title: string
  type: MenuItemType
  contexts: MenuContext[]
  parentId: string | null
  enabled: boolean
  visible: boolean
  checked: boolean
  documentUrlPatterns: string[] | null
  targetUrlPatterns: string[] | null
}

export const MENU_ITEMS_MAX = 1000

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function idOf(v: unknown): { id: string; numeric: boolean } | null {
  if (typeof v === 'string' && v.length > 0 && v.length <= 512) return { id: v, numeric: false }
  if (typeof v === 'number' && Number.isInteger(v)) return { id: String(v), numeric: true }
  return null
}

function patterns(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string').slice(0, 64) : null
}

function contextsOf(v: unknown): MenuContext[] {
  const list = Array.isArray(v) ? v.filter((c): c is MenuContext => (MENU_CONTEXTS as readonly string[]).includes(c as string)) : []
  return list.length ? [...new Set(list)] : ['page']
}

/** contextMenus.create: Chrome's checks (a duplicate id, a parent that isn't there, a missing title). */
export function createItem(items: readonly MenuItem[], props: unknown): MenuItem[] {
  if (!isObject(props)) throw new Error('Invalid menu item.')
  const key = idOf(props.id)
  if (!key) throw new Error('Extensions using event pages or Service Workers must pass an id parameter to chrome.contextMenus.create')
  if (items.some((i) => i.id === key.id)) throw new Error(`Cannot create item with duplicate id ${key.id}`)
  const type: MenuItemType = props.type === 'checkbox' || props.type === 'radio' || props.type === 'separator' ? props.type : 'normal'
  const title = typeof props.title === 'string' ? props.title.slice(0, 300) : ''
  if (type !== 'separator' && !title) throw new Error('Title missing.')
  const parent = props.parentId === undefined ? null : idOf(props.parentId)
  if (props.parentId !== undefined && (!parent || !items.some((i) => i.id === parent.id))) throw new Error(`Cannot find menu item with id ${String(props.parentId)}`)
  if (items.length >= MENU_ITEMS_MAX) throw new Error('Too many menu items.')
  const item: MenuItem = {
    id: key.id,
    numeric: key.numeric,
    title,
    type,
    contexts: contextsOf(props.contexts),
    parentId: parent?.id ?? null,
    enabled: props.enabled !== false,
    visible: props.visible !== false,
    checked: props.checked === true,
    documentUrlPatterns: patterns(props.documentUrlPatterns),
    targetUrlPatterns: patterns(props.targetUrlPatterns),
  }
  return [...items, item]
}

export function updateItem(items: readonly MenuItem[], rawId: unknown, props: unknown): MenuItem[] {
  const key = idOf(rawId)
  const at = key ? items.findIndex((i) => i.id === key.id) : -1
  if (at < 0 || !isObject(props)) throw new Error(`Cannot find menu item with id ${String(rawId)}`)
  const was = items[at] as MenuItem
  const next: MenuItem = { ...was }
  if (typeof props.title === 'string') next.title = props.title.slice(0, 300)
  if (props.type === 'normal' || props.type === 'checkbox' || props.type === 'radio' || props.type === 'separator') next.type = props.type
  if (props.contexts !== undefined) next.contexts = contextsOf(props.contexts)
  if (typeof props.enabled === 'boolean') next.enabled = props.enabled
  if (typeof props.visible === 'boolean') next.visible = props.visible
  if (typeof props.checked === 'boolean') next.checked = props.checked
  if (props.documentUrlPatterns !== undefined) next.documentUrlPatterns = patterns(props.documentUrlPatterns)
  if (props.targetUrlPatterns !== undefined) next.targetUrlPatterns = patterns(props.targetUrlPatterns)
  if (props.parentId !== undefined) {
    const parent = idOf(props.parentId)
    // A parent can't be the item itself or one of its own children.
    if (!parent || !items.some((i) => i.id === parent.id) || descendants(items, was.id).has(parent.id) || parent.id === was.id) throw new Error(`Cannot find menu item with id ${String(props.parentId)}`)
    next.parentId = parent.id
  }
  const out = [...items]
  out[at] = next
  return out
}

function descendants(items: readonly MenuItem[], id: string): Set<string> {
  const out = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const i of items) {
      if (i.parentId === null || out.has(i.id) || (i.parentId !== id && !out.has(i.parentId))) continue
      out.add(i.id)
      grew = true
    }
  }
  return out
}

/** contextMenus.remove: the item and everything under it. */
export function removeItem(items: readonly MenuItem[], rawId: unknown): MenuItem[] {
  const key = idOf(rawId)
  if (!key || !items.some((i) => i.id === key.id)) throw new Error(`Cannot find menu item with id ${String(rawId)}`)
  const drop = descendants(items, key.id)
  drop.add(key.id)
  return items.filter((i) => !drop.has(i.id))
}

/** What was right-clicked, from Electron's ContextMenuParams. */
export interface MenuTarget {
  pageUrl: string
  frameUrl: string | null
  frameId: number
  linkUrl: string | null
  srcUrl: string | null
  mediaType: 'image' | 'video' | 'audio' | null
  selectionText: string
  editable: boolean
}

export function targetContexts(t: MenuTarget): Set<MenuContext> {
  const out = new Set<MenuContext>(['all'])
  if (t.selectionText) out.add('selection')
  if (t.linkUrl) out.add('link')
  if (t.editable) out.add('editable')
  if (t.mediaType) out.add(t.mediaType)
  if (t.frameUrl && t.frameId !== 0) out.add('frame')
  // "page" is for a click that hit nothing more specific, as in Chrome.
  if (out.size === 1 || (out.size === 2 && out.has('frame'))) out.add('page')
  return out
}

export interface MenuNode {
  item: MenuItem
  title: string
  children: MenuNode[]
}

/** The items to draw for one click, as a tree; `matches` is a match-pattern test. */
export function visibleTree(items: readonly MenuItem[], target: MenuTarget, matches: (pattern: string, url: string) => boolean): MenuNode[] {
  const contexts = targetContexts(target)
  const shows = (i: MenuItem): boolean => {
    if (!i.visible) return false
    if (!i.contexts.some((c) => contexts.has(c))) return false
    if (i.documentUrlPatterns && !i.documentUrlPatterns.some((p) => matches(p, target.frameUrl ?? target.pageUrl))) return false
    const targetUrl = target.linkUrl ?? target.srcUrl
    if (i.targetUrlPatterns && targetUrl && !i.targetUrlPatterns.some((p) => matches(p, targetUrl))) return false
    return true
  }
  const build = (parent: string | null): MenuNode[] =>
    items.filter((i) => i.parentId === parent && shows(i)).map((item) => ({ item, title: menuTitle(item.title, target.selectionText), children: build(item.id) }))
  return build(null)
}

/** Chrome's %s: the selection, shortened to 32 characters. */
export function menuTitle(title: string, selection: string): string {
  const text = selection.length > 32 ? `${selection.slice(0, 32)}…` : selection
  return title.replace(/%s/g, text)
}

/** contextMenus.onClicked's OnClickData. */
export function clickData(item: MenuItem, target: MenuTarget, wasChecked: boolean): Record<string, unknown> {
  const data: Record<string, unknown> = {
    menuItemId: item.numeric ? Number(item.id) : item.id,
    editable: target.editable,
    pageUrl: target.pageUrl,
    frameId: target.frameId,
  }
  if (item.parentId !== null) data.parentMenuItemId = item.parentId
  if (target.frameUrl && target.frameId !== 0) data.frameUrl = target.frameUrl
  if (target.linkUrl) data.linkUrl = target.linkUrl
  if (target.srcUrl) data.srcUrl = target.srcUrl
  if (target.mediaType) data.mediaType = target.mediaType
  if (target.selectionText) data.selectionText = target.selectionText
  if (item.type === 'checkbox' || item.type === 'radio') {
    data.wasChecked = wasChecked
    data.checked = item.type === 'checkbox' ? !wasChecked : true
  }
  return data
}

/** After a click: a checkbox flips, a radio becomes the one checked among its neighbours. */
export function afterClick(items: readonly MenuItem[], id: string): MenuItem[] {
  const hit = items.find((i) => i.id === id)
  if (!hit || (hit.type !== 'checkbox' && hit.type !== 'radio')) return [...items]
  return items.map((i) => {
    if (i.id === id) return { ...i, checked: i.type === 'checkbox' ? !i.checked : true }
    if (hit.type === 'radio' && i.type === 'radio' && i.parentId === hit.parentId) return { ...i, checked: false }
    return i
  })
}

/** Items as the store keeps them; anything malformed is dropped. */
export function restoreItems(raw: unknown): MenuItem[] {
  if (!Array.isArray(raw)) return []
  let out: MenuItem[] = []
  for (const r of raw.slice(0, MENU_ITEMS_MAX)) {
    if (!isObject(r)) continue
    try {
      out = createItem(out, { ...r, id: r.numeric ? Number(r.id) : r.id, parentId: r.parentId ?? undefined })
    } catch {
      // Dropped: a broken item (or one whose parent was dropped).
    }
  }
  return out
}
