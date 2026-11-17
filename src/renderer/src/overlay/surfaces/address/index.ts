/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { AddressSurfaceProps } from '@shared/overlay/address'
import { FIND_QUERY_MAX } from '@shared/find'
import { BOOKMARK_URL_MAX } from '@shared/bookmarks'
import { FindBarSurface } from '../../../components/bars/FindBar'
import { PeekFrame } from '../../../components/PeekFrame'
import { CASCADE_MENU_POLICY } from '../../kit'
import { HINT_POLICY, MENU_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'
import { BookmarkEditor } from './BookmarkEditor'
import { BookmarkFolderMenu } from './BookmarkFolder'
import { CommandBar } from './CommandBar'
import { LinkBubble, LinkPreviewCard, PageProgress } from './passive'
import { UniversalSearch } from './UniversalSearch'
import { ZoomPopover } from './ZoomPopover'
import './address.css'

// The address surfaces (command bar, find, zoom, links, peek, bookmarks).
// Each surface is registered here.

const id = z.string().min(1).max(128)
const url = z.string().max(BOOKMARK_URL_MAX)
const text = z.string().max(BOOKMARK_URL_MAX)
const loadStage = z.enum(['idle', 'started', 'response', 'dom-ready', 'finished'])
const findState = z
  .object({ open: z.boolean(), query: z.string().max(FIND_QUERY_MAX), matches: z.number().int().min(0), active: z.number().int().min(0), searching: z.boolean() })
  .strict()
const linkPreview = z
  .object({
    url,
    domain: z.string().max(253),
    title: z.string().max(1000).nullable(),
    description: z.string().max(4000).nullable(),
    siteName: z.string().max(500).nullable(),
    imageUrl: z.string().max(BOOKMARK_URL_MAX).nullable(),
    image: z.string().max(200_000).nullable(),
  })
  .strict()

type Module<S extends keyof AddressSurfaceProps> = SurfaceModule<AddressSurfaceProps[S]>

const commandBar: Module<'command-bar'> = {
  component: CommandBar,
  props: z.object({ tabId: id, text, url, selectAll: z.boolean(), blank: z.boolean(), companion: z.string().max(200), submit: z.boolean().optional() }).strict(),
  // Drawn over the pill: the field turns solid in place and the card grows down from it (DS-23).
  policy: { ...MENU_POLICY, onTabSwitch: 'close' },
  placement: 'below',
  gap: 0,
}

const universalSearch: Module<'universal-search'> = {
  component: UniversalSearch,
  props: z.object({ filter: z.enum(['all', 'tabs', 'chats', 'pages']) }).strict(),
  policy: { ...MENU_POLICY, layer: 'modal', onTabSwitch: 'stay' },
  // DS-90: the anchor's top is already about a quarter down the window (paletteAnchor).
  placement: 'top-center',
  gap: 0,
}

const findBar: Module<'find-bar'> = {
  component: FindBarSurface,
  props: z.object({ tabId: id, focus: z.number().int().min(0), state: findState.optional() }).strict(),
  // Tied to its tab and shown again when the tab returns; clicks in the page leave it open.
  policy: { ...MENU_POLICY, outsideClick: 'ignore', onTabSwitch: 'hide-until-return' },
  // Top right of the page's pane, clear of the content's centre.
  placement: 'top-end',
  gap: 8,
}

const zoomPopover: Module<'zoom-popover'> = {
  component: ZoomPopover,
  props: z.object({ tabId: id, percent: z.number().int().min(1).max(1000) }).strict(),
  policy: MENU_POLICY,
  placement: 'below',
  gap: 6,
}

const linkBubble: Module<'link-bubble'> = {
  component: LinkBubble,
  props: z.object({ text: z.string().max(4096) }).strict(),
  // The pane-sized frame lets the bubble sit at its bottom left; the passive tier never takes input.
  policy: { ...HINT_POLICY, size: 'fill-tab' },
}

const linkPreviewCard: Module<'link-preview'> = {
  component: LinkPreviewCard,
  props: z.object({ url, preview: linkPreview.nullable(), failed: z.boolean() }).strict(),
  policy: { ...HINT_POLICY, onScroll: 'close' },
  placement: 'below',
  gap: 6,
}

const peekFrame: Module<'peek-frame'> = {
  component: PeekFrame,
  props: z.object({ url, title: z.string().max(4096), loading: z.boolean() }).strict(),
  // The backdrop and header under the peeked page's native view (tabs < overlay < peek, so not a modal
  // layer, which would lift the overlay over the page); the page keeps keyboard focus.
  policy: { tier: 'interactive', size: 'fill-window', outsideClick: 'ignore', blocksPage: false, onTabSwitch: 'stay', layer: 'menu', focus: false, exitMs: 140 },
}

const pageProgress: Module<'page-progress'> = {
  component: PageProgress,
  props: z.object({ stage: loadStage, startedAt: z.number().nullable() }).strict(),
  policy: { ...HINT_POLICY, size: 'fill-tab', onTabSwitch: 'hide-until-return' },
}

const bookmarkEditor: Module<'bookmark-editor'> = {
  component: BookmarkEditor,
  props: z.object({ id, created: z.boolean() }).strict(),
  policy: MENU_POLICY,
  placement: 'below',
  gap: 6,
}

const folderProps = z.object({ folderId: id, ids: z.array(id).max(2000).optional() }).strict()

const bookmarkFolder: Module<'bookmark-folder'> = {
  component: BookmarkFolderMenu,
  props: folderProps,
  policy: CASCADE_MENU_POLICY,
}

const bookmarksOverflow: Module<'bookmarks-overflow'> = {
  component: BookmarkFolderMenu,
  props: folderProps,
  policy: CASCADE_MENU_POLICY,
}

export const ADDRESS_SURFACE_MAP: SurfaceMap = {
  'command-bar': commandBar as unknown as SurfaceModule<never>,
  'universal-search': universalSearch as unknown as SurfaceModule<never>,
  'find-bar': findBar as unknown as SurfaceModule<never>,
  'zoom-popover': zoomPopover as unknown as SurfaceModule<never>,
  'link-bubble': linkBubble as unknown as SurfaceModule<never>,
  'link-preview': linkPreviewCard as unknown as SurfaceModule<never>,
  'peek-frame': peekFrame as unknown as SurfaceModule<never>,
  'page-progress': pageProgress as unknown as SurfaceModule<never>,
  'bookmark-editor': bookmarkEditor as unknown as SurfaceModule<never>,
  'bookmark-folder': bookmarkFolder as unknown as SurfaceModule<never>,
  'bookmarks-overflow': bookmarksOverflow as unknown as SurfaceModule<never>,
}
