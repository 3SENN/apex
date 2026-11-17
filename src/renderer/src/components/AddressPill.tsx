/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactElement } from 'react'
import type { TabInfo } from '@shared/ipc'
import type { CommandBarResult } from '@shared/overlay/address'
import { flattenGroups, type UniversalFilter } from '@shared/omnibox'
import { chatUrl, isBlankUrl } from '@shared/url'
import { Lock, Search, Star, TriangleAlert } from 'lucide-react'
import { apex, call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { anchorFromElement, openSurface } from '../overlay/useSurface'
import { openSiteInfo } from '../overlay/surfaces/sites/open'
import { Spinner, cx, showContextMenu, toast } from '../ui'
import { droppedText, fullAddress, paletteAnchor, pillParts, stillLoading, STILL_LOADING_MS } from './address'
import { useCompanions, useShell } from './shellContext'
import { addressMenu } from './sidebar/logic/menus'
import { copyText, readClipboard } from './sidebar/util'
import { TranslateButton } from '../translate/TranslateButton' // translate (TR-01)
import { ReaderButton } from '../reader/ReaderButton' // reader (RD-03)
import { PermissionChips } from './PermissionChips' // permissions pass: refused and held-back requests

export interface AddressPillHandle {
  /** ⌘L, ⌘T, a click or Enter: the command bar over the pill, with the full address selected. */
  edit(): void
  /** ⌘D and the star: add the page if needed, then edit it in the bookmark editor. */
  bookmark(): void
}

interface AddressPillProps {
  tab: TabInfo | null
  bookmarked: boolean
  showFullUrls: boolean
}

/** Text dropped on the page's ask field after Tab on an empty new tab (DS-110); NewTabPage listens. */
export const FOCUS_ASK_EVENT = 'apex:focus-ask'

/** The mounted pill's ⌘D flow, for the bookmarks bar's "Add current page". */
let currentPillBookmark: (() => void) | null = null
export function bookmarkCurrentPage(): void {
  currentPillBookmark?.()
}

/**
 * Universal search: the centred palette, from ⇧⌘A or the sidebar's
 * Search button. The chats header's search opens it filtered to chats (DS-90).
 */
export function openUniversalSearch(filter: UniversalFilter = 'all'): void {
  const rect = paletteAnchor({ width: window.innerWidth, height: window.innerHeight })
  void openSurface('universal-search', { kind: 'window', rect }, { filter }).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
}

/** The command bar sits over the pill, its ring 2 px outside it (DS-23). */
function barAnchor(el: HTMLElement): { kind: 'window'; rect: { x: number; y: number; width: number; height: number } } {
  const r = el.getBoundingClientRect()
  return { kind: 'window', rect: { x: r.left, y: r.top - 2, width: r.width, height: 0 } }
}

/**
 * The address pill, centred on the sheet: a flat neutral field. At rest it
 * shows the host (and the page title when there is a path) or an Apex
 * breadcrumb. A click, Enter or ⌘L opens the command bar over it in the
 * interactive overlay, so the field turns solid in place and suggestions
 * grow down without hiding the page (SH-35, DS-23). It also carries the
 * zoom chip (SH-45), "Still loading" with Stop after 8 s (SS-01), the star
 * (SH-49) and drops of text or links.
 */
export const AddressPill = forwardRef<AddressPillHandle, AddressPillProps>(function AddressPill({ tab, bookmarked, showFullUrls }, ref) {
  const t = useT()
  const shell = useShell()
  const companions = useCompanions()
  const root = useRef<HTMLDivElement>(null)
  const star = useRef<HTMLButtonElement>(null)
  const zoomChip = useRef<HTMLButtonElement>(null)
  const [editing, setEditing] = useState(false)
  const [fallback, setFallback] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [, setTick] = useState(0)
  const url = tab?.url ?? ''
  const parts = pillParts(url, tab?.title ?? '', tab?.crumbs ?? null)
  const address = parts.kind === 'apex' ? url : fullAddress(url)
  const companion = companions.list.find((c) => c.id === companions.activeId) ?? companions.list[0] ?? null
  const companionName = companion?.name ?? BRAND_NAME
  const web = parts.kind === 'web'
  const slow = tab ? stillLoading(tab.loadStage, tab.loadStartedAt, Date.now()) : false

  // One timer to the 8 s mark, so "Still loading" appears without anything ticking at rest (DS-28).
  useEffect(() => {
    if (!tab?.loadStartedAt || slow) return
    const wait = tab.loadStartedAt + STILL_LOADING_MS - Date.now()
    if (wait <= 0) return
    const timer = setTimeout(() => setTick((n) => n + 1), wait + 20)
    return () => clearTimeout(timer)
  }, [tab?.loadStartedAt, slow])

  const latestTab = useRef(tab)
  latestTab.current = tab
  const ask = (text: string, blank: boolean): void => {
    const tab = latestTab.current
    if (!tab) return
    void apex.agent.start(text, { companionId: companion?.id || undefined }).then(
      (chatId) => {
        if (blank) void apex.nav.go(tab.id, chatUrl(chatId))
        else shell.openPanel(chatId)
      },
      (err: unknown) => toast.show({ message: errorText(err), tone: 'error' }),
    )
  }

  // ⌘T sends focus-omnibox right after the new tab's snapshot. A render of
  // the pill's own, queued at the same priority, commits together with that
  // snapshot, so once it has committed the pill holds the new tab. One animation
  // frame was not always enough on a busy machine: the bar opened on the
  // previous tab's address.
  const [settleTick, setSettleTick] = useState(0)
  const settled = useRef<Array<() => void>>([])
  useLayoutEffect(() => {
    for (const done of settled.current.splice(0)) done()
  }, [settleTick])
  const opening = useRef(false)
  const edit = async (submit?: string): Promise<void> => {
    if (opening.current || editing) return
    opening.current = true
    await new Promise<void>((resolve) => {
      settled.current.push(resolve)
      setSettleTick((n) => n + 1)
    })
    opening.current = false
    const tab = latestTab.current
    const el = root.current
    if (!tab || !el) return
    const url = tab.url
    const parts = pillParts(url, tab.title, tab.crumbs ?? null)
    const address = parts.kind === 'apex' ? url : fullAddress(url)
    const blank = isBlankUrl(url)
    const draft = submit === undefined ? await call('omnibox', 'draft', tab.id).catch(() => null) : null
    setEditing(true)
    try {
      const result = await openSurface('command-bar', barAnchor(el), {
        tabId: tab.id,
        text: submit ?? draft ?? address,
        url: address,
        selectAll: submit === undefined && draft === null,
        blank,
        companion: companionName,
        ...(submit !== undefined ? { submit: true } : {}),
      })
      if (!('value' in result)) return
      const value = result.value as CommandBarResult
      if (value.kind === 'ask') ask(value.text, blank)
      else if (value.kind === 'focus-ask') window.dispatchEvent(new CustomEvent(FOCUS_ASK_EVENT, { detail: { tabId: tab.id, text: value.text } }))
    } catch {
      // No overlay host (a chrome-hosted fallback): a plain field in place.
      setFallback(draft ?? address)
    } finally {
      setEditing(false)
    }
  }

  const bookmark = async (): Promise<void> => {
    if (!tab || !web) return
    try {
      const existing = await call('bookmarks', 'forUrl', tab.url)
      const link = existing ?? (await call('bookmarks', 'add', { url: tab.url, title: tab.title }))
      const anchor = star.current ? anchorFromElement(star.current) : root.current ? anchorFromElement(root.current) : null
      if (!anchor) return
      await openSurface('bookmark-editor', anchor, { id: link.id, created: existing === null })
    } catch (err) {
      toast.show({ message: t('address.editor.saveFailed', { error: errorText(err) }), tone: 'error' })
    }
  }

  useImperativeHandle(ref, () => ({ edit: () => void edit(), bookmark: () => void bookmark() }))
  const latestBookmark = useRef(bookmark)
  latestBookmark.current = bookmark
  useEffect(() => {
    const run = (): void => void latestBookmark.current()
    currentPillBookmark = run
    return () => {
      if (currentPillBookmark === run) currentPillBookmark = null
    }
  }, [])

  const go = (target: string): void => {
    if (!tab || !target.trim()) return
    void apex.nav.go(tab.id, target)
  }

  // A dropped link opens, dropped text searches; both through the command bar's own rules.
  const onDrop = (e: DragEvent): void => {
    setDropping(false)
    const text = droppedText(e.dataTransfer)
    if (!text || !tab) return
    e.preventDefault()
    void call('omnibox', 'query', text).then(async (groups) => {
      const action = flattenGroups(groups)[0]?.action
      if (!action) return
      const result = await call('omnibox', 'commit', tab.id, text, action)
      if (!result.ok) toast.show({ message: result.error, tone: 'error' })
      else if (result.ask) ask(result.ask, isBlankUrl(url))
    }, (err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
  }
  const onDragOver = (e: DragEvent): void => {
    const types = e.dataTransfer.types
    if (!types.includes('text/uri-list') && !types.includes('text/plain')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'link'
    if (!dropping) setDropping(true)
  }

  const onMenu = async (event: MouseEvent): Promise<void> => {
    const id = await showContextMenu(event, addressMenu({ url, showFullUrls, canPaste: tab !== null }))
    if (id === 'copy') {
      if (await copyText(url)) toast.show({ message: t('address.pill.copied') })
    } else if (id === 'paste-go') {
      // Read only when chosen, so opening the menu never touches the clipboard.
      const pasted = await readClipboard()
      if (pasted) void edit(pasted)
      else toast.show({ message: t('address.bar.empty') })
    } else if (id === 'edit') void edit()
    else if (id === 'full-urls') void apex.settings.set({ showFullUrls: !showFullUrls })
  }

  // Site info opens under the pill's site button.
  const siteInfo = (anchor: HTMLElement): void => {
    if (tab) openSiteInfo(anchor, tab.id)
  }

  const openZoom = (): void => {
    const el = zoomChip.current
    if (!tab || !el) return
    void openSurface('zoom-popover', anchorFromElement(el), { tabId: tab.id, percent: tab.zoomPercent }).catch(() => undefined)
  }

  if (fallback !== null) {
    return (
      <div className="pill pill--editing">
        <Search size={16} className="pill__lead" aria-hidden />
        <input
          className="pill__input"
          autoFocus
          defaultValue={fallback}
          placeholder={t('address.pill.placeholder')}
          aria-label={t('address.pill.label')}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setFallback(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              go(e.currentTarget.value)
              setFallback(null)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setFallback(null)
            }
          }}
        />
      </div>
    )
  }

  let text: ReactElement
  if (parts.kind === 'blank') text = <span className="pill__placeholder">{t('address.pill.placeholder')}</span>
  else if (parts.kind === 'apex') {
    text = (
      <span className="pill__crumbs">
        {(parts.crumbs ?? []).map((crumb, i) => (
          <span key={i} className={cx('pill__crumb', i === (parts.crumbs?.length ?? 0) - 1 && 'pill__crumb--last')}>
            {i > 0 && (
              <span className="pill__sep" aria-hidden>
                /
              </span>
            )}
            {crumb}
          </span>
        ))}
      </span>
    )
  } else if (showFullUrls || parts.kind === 'other') text = <span className="pill__full">{address}</span>
  else {
    text = (
      <span className="pill__compact">
        {parts.insecure && <span className="pill__insecure">{t('address.pill.notSecure')}</span>}
        <span className={cx('pill__host', parts.lookalike && 'pill__host--warn')}>{parts.host}</span>
        {parts.detail && (
          <>
            <span className="pill__sep" aria-hidden>
              /
            </span>
            <span className="pill__detail">{parts.detail}</span>
          </>
        )}
      </span>
    )
  }

  const zoomed = web && tab !== null && tab.zoomPercent !== 100
  return (
    <div
      ref={root}
      className={cx('pill', parts.insecure && 'pill--insecure', editing && 'pill--covered', dropping && 'pill--drop', parts.kind === 'blank' && 'pill--blank')}
      onContextMenu={(e) => void onMenu(e)}
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {web && (
        <button
          type="button"
          className="pill__info"
          aria-label={parts.insecure ? `${t('address.pill.siteInfo')}: ${t('address.pill.notSecure')}` : t('address.pill.siteInfo')}
          title={parts.insecure ? t('address.pill.notSecure') : t('address.pill.siteInfo')}
          onClick={(e) => siteInfo(e.currentTarget)}
        >
          {tab?.loading ? <Spinner size={13} label={t('address.load.progress')} /> : parts.insecure ? <TriangleAlert size={14} aria-hidden /> : <Lock size={13} aria-hidden />}
        </button>
      )}
      {/* permissions pass: beside site info, which is where a refused permission is changed */}
      {web && tab && <PermissionChips tabId={tab.id} activity={tab.permissionActivity ?? []} />}
      <button
        type="button"
        className="pill__text"
        aria-label={parts.kind === 'blank' ? t('address.pill.placeholder') : `${t('address.pill.label')}: ${parts.kind === 'apex' ? (parts.crumbs ?? []).join(', ') : address}`}
        aria-haspopup="listbox"
        title={web ? address : undefined}
        onClick={() => void edit()}
      >
        {text}
      </button>
      {slow && tab && (
        <span className="pill__slow" role="status">
          {t('address.pill.stillLoading')}
          <button type="button" className="pill__stop" onClick={() => void apex.nav.stop(tab.id)}>
            {t('address.pill.stop')}
          </button>
        </span>
      )}
      {/* translate (TR-01): the offer, progress and translated state; the popover opens from it */}
      {web && tab?.translate && <TranslateButton tabId={tab.id} state={tab.translate} companion={companionName} />}
      {web && tab?.reader && <ReaderButton tab={tab} />}
      {zoomed && tab && (
        <button ref={zoomChip} type="button" className="pill__zoom" aria-label={t('address.pill.zoom', { percent: tab.zoomPercent })} aria-haspopup="dialog" onClick={openZoom}>
          <span key={tab.zoomPercent} className="pill__zoom-value">
            {t('address.zoom.percent', { percent: tab.zoomPercent })}
          </span>
        </button>
      )}
      {web && tab && (
        <button
          ref={star}
          type="button"
          className={cx('pill__star', bookmarked && 'pill__star--on')}
          aria-label={bookmarked ? t('address.pill.bookmarked') : t('address.pill.bookmark')}
          aria-haspopup="dialog"
          title={bookmarked ? t('address.pill.bookmarked') : `${t('address.pill.bookmark')} (⌘D)`}
          onClick={() => void bookmark()}
        >
          <Star size={14} aria-hidden />
        </button>
      )}
    </div>
  )
})
