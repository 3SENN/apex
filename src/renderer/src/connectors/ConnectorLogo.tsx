/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import { Briefcase, CalendarDays, Code, Database, Globe, Headphones, PenTool, Plug, Server, Terminal, Wallet, type LucideIcon } from 'lucide-react'
import type { ConnectorCategory } from '@shared/connectors'
import { call } from '../api'
import { cx } from '../ui'

// A connector's logo tile: your own logo, else the site's favicon
// fetched at runtime by main (through the default profile and cached), else
// Apex's generic icon for the category. No brand logo ships with Apex.

const CATEGORY_ICONS: Record<ConnectorCategory, LucideIcon> = {
  work: Briefcase,
  'mail-calendar': CalendarDays,
  code: Code,
  design: PenTool,
  'sales-support': Headphones,
  finance: Wallet,
  data: Database,
  web: Globe,
}

const favicons = new Map<string, Promise<string | null>>()

/** The site's favicon as a data URL, asked once per site per session. */
export function faviconFor(site: string): Promise<string | null> {
  const key = site.toLowerCase()
  let hit = favicons.get(key)
  if (!hit) {
    hit = call('connectors', 'favicon', key).catch(() => null)
    favicons.set(key, hit)
  }
  return hit
}

export interface ConnectorLogoProps {
  name: string
  logo?: string | null
  site?: string | null
  category?: string | null
  local?: boolean
  size?: 'lg' | 'md' | 'sm'
  className?: string
}

export function ConnectorLogo({ name, logo = null, site = null, category = null, local = false, size = 'lg', className }: ConnectorLogoProps): ReactElement {
  const [icon, setIcon] = useState<string | null>(logo)
  useEffect(() => {
    setIcon(logo)
    if (logo || !site) return
    let live = true
    void faviconFor(site).then((url) => {
      if (live && url) setIcon(url)
    })
    return () => {
      live = false
    }
  }, [logo, site])
  const Generic = (category && CATEGORY_ICONS[category as ConnectorCategory]) || (local ? Terminal : site ? Server : Plug)
  return (
    <span className={cx('cx-logo', `cx-logo--${size}`, className)} data-name={name} aria-hidden>
      {icon ? <img src={icon} alt="" draggable={false} onError={() => setIcon(null)} /> : <Generic className="cx-logo__generic" />}
    </span>
  )
}
