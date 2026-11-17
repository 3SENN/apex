/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import {
  AppWindow, BookOpen, CalendarDays, ChartLine, Clock, Compass, Globe, Import, Lightbulb, ListChecks, AudioLines, Mail, Mic, Palette, PenLine, Plug, Search, Shapes, ShoppingCart, Sparkles,
  type LucideIcon,
} from 'lucide-react'
import type { FirstWeekGlyph } from '@shared/firstWeek'

const ICONS: Record<FirstWeekGlyph, LucideIcon> = {
  compass: Compass,
  pen: PenLine,
  search: Search,
  calendar: CalendarDays,
  list: ListChecks,
  lightbulb: Lightbulb,
  mail: Mail,
  cart: ShoppingCart,
  book: BookOpen,
  chart: ChartLine,
  globe: Globe,
  sparkles: Sparkles,
  import: Import,
  browser: AppWindow,
  plug: Plug,
  palette: Palette,
  clock: Clock,
  mic: Mic,
  wave: AudioLines,
  shapes: Shapes,
}

export function Glyph({ glyph, size = 22 }: { glyph: FirstWeekGlyph; size?: number }): ReactElement {
  const Icon = ICONS[glyph] ?? Sparkles
  return <Icon size={size} strokeWidth={2} aria-hidden />
}
