/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type CSSProperties, type ReactElement } from 'react'
import { accentTokens } from '@shared/accent'
import type { Companion } from '@shared/companion'
import type { TabInfo } from '@shared/ipc'
import { isBlankUrl, parseInternalUrl } from '@shared/url'
import {
  AppWindow,
  Bookmark,
  CalendarClock,
  Clock,
  Download,
  Globe,
  ListChecks,
  MessageSquare,
  MessagesSquare,
  Plug,
  Settings,
  Smile,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react'
import { Spinner } from '../../ui'
import { BrandMark } from '../../brand/BrandLogo'

/** CSS custom properties for a style prop. */
export function cssVars(vars: Record<`--${string}`, string | number>): CSSProperties {
  return vars as CSSProperties
}

/**
 * The companion's colour for glows on rows it controls (both modes, readable
 * on the sidebar), as --agent-color. Neutral when the companion is gone.
 */
export function agentColorVars(companion: Companion | null): CSSProperties {
  if (!companion) return {}
  const color = companion.look.colors.accent
  return cssVars({ '--agent-color': `light-dark(${accentTokens(color, 'light').accent}, ${accentTokens(color, 'dark').accent})` })
}

/** Icons for Apex pages, by apex://<page>. The welcome page, and any Apex page without its own icon, shows Apex's logo (Pip's head). */
export const PAGE_ICONS: Record<string, LucideIcon> = {
  chats: MessagesSquare,
  chat: MessageSquare,
  routines: CalendarClock,
  skills: WandSparkles,
  connectors: Plug,
  companion: Smile,
  history: Clock,
  bookmarks: Bookmark,
  downloads: Download,
  settings: Settings,
  'first-week': ListChecks,
}

/** A tab's icon: a spinner while loading, the page icon (or Apex's logo) for Apex pages, else the site's favicon. */
export function TabIcon({ tab, size = 16 }: { tab: TabInfo; size?: number }): ReactElement {
  const [broken, setBroken] = useState<string | null>(null)
  if (tab.loading && !parseInternalUrl(tab.url)) return <Spinner size={size - 2} />
  const page = parseInternalUrl(tab.url)?.page
  if (page) {
    const Icon = PAGE_ICONS[page]
    return Icon ? <Icon size={size - 1} aria-hidden /> : <BrandMark size={size} />
  }
  // Not a plus: that would read as the New Tab button beside it.
  if (isBlankUrl(tab.url)) return <AppWindow size={size - 1} aria-hidden />
  if (tab.favicon && broken !== tab.favicon) {
    const src = tab.favicon
    return <img src={src} alt="" width={size} height={size} draggable={false} onError={() => setBroken(src)} />
  }
  return <Globe size={size - 1} aria-hidden />
}

/** Whether keyboard focus is in a text field (so shell shortcuts leave the key alone). */
export function isTextTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

/** Copies text, ignoring a denied clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export async function readClipboard(): Promise<string> {
  try {
    return (await navigator.clipboard.readText()).trim()
  } catch {
    return ''
  }
}
