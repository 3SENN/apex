/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

// Input schemas for browser_toolset_20260801 members, mirroring the SDK's
// BetaBrowser*Input types. Response tool_use blocks carry `input: unknown`,
// so every call is validated here before it touches a page. The four members
// the toolset disables by default (javascript_exec, file_upload,
// read_console, read_network) are absent on purpose.

const tabId = z.string().nullish()
const coordinate = z.object({ type: z.literal('coordinate'), x: z.number().finite(), y: z.number().finite() })
const ref = z.object({ type: z.literal('ref'), ref: z.string().min(1) })
const target = z.discriminatedUnion('type', [coordinate, ref])
const clickInput = z.object({ target, modifiers: z.string().nullish(), tab_id: tabId })

export const memberSchemas = {
  navigate: z.object({ url: z.string().min(1), tab_id: tabId }),
  screenshot: z.object({ tab_id: tabId }),
  zoom: z.object({ region: z.array(z.number().finite()).length(4), tab_id: tabId }),
  left_click: clickInput,
  right_click: clickInput,
  middle_click: clickInput,
  double_click: clickInput,
  triple_click: clickInput,
  hover: z.object({ target, tab_id: tabId }),
  mouse_move: z.object({ target: coordinate, tab_id: tabId }),
  left_click_drag: z.object({ from: coordinate, target: coordinate, tab_id: tabId }),
  left_mouse_down: z.object({ target: coordinate, tab_id: tabId }),
  left_mouse_up: z.object({ target: coordinate, tab_id: tabId }),
  scroll: z.object({
    target: coordinate,
    scroll_direction: z.enum(['up', 'down', 'left', 'right']),
    scroll_amount: z.number().int().min(1).max(10).nullish(),
    tab_id: tabId,
  }),
  scroll_to: z.object({ target: ref, tab_id: tabId }),
  type: z.object({ text: z.string(), tab_id: tabId }),
  key: z.object({ text: z.string().min(1), repeat: z.number().int().min(1).max(100).nullish(), tab_id: tabId }),
  hold_key: z.object({ text: z.string().min(1), duration: z.number().min(0).max(30), tab_id: tabId }),
  wait: z.object({ duration: z.number().min(0).max(30), tab_id: tabId }),
  read_page: z.object({
    filter: z.enum(['interactive', 'all']).nullish(),
    depth: z.number().int().min(1).nullish(),
    ref: z.string().nullish(),
    tab_id: tabId,
  }),
  find: z.object({ query: z.string().min(1), tab_id: tabId }),
  get_page_text: z.object({ tab_id: tabId }),
  form_input: z.object({ target: ref, value: z.union([z.string(), z.number(), z.boolean()]), tab_id: tabId }),
  new_tab: z.object({}),
  list_tabs: z.object({}),
  switch_tab: z.object({ tab_id: z.string().min(1) }),
  close_tab: z.object({ tab_id: z.string().min(1) }),
} as const

export type MemberName = keyof typeof memberSchemas
export type MemberInput<N extends MemberName> = z.infer<(typeof memberSchemas)[N]>
export type Target = z.infer<typeof target>
export type CoordinateTarget = z.infer<typeof coordinate>

export function isMemberName(name: string): name is MemberName {
  return Object.hasOwn(memberSchemas, name)
}

export const TAB_MANAGEMENT = new Set<MemberName>(['new_tab', 'list_tabs', 'switch_tab', 'close_tab'])
