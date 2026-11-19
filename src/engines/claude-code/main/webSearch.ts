/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sourcesOf } from '../../../../src/main/agent/sessionAgentTools'

/** Claude Code's WebSearch result text lists its links as `Links: [{"title","url"}…]`. */
export function webSearchSources(text: string): Array<{ url: string; title: string }> {
  const match = /Links:\s*(\[[\s\S]*?\])\s*(?:\n|$)/.exec(text)
  if (!match?.[1]) return []
  try {
    const links = JSON.parse(match[1]) as unknown
    return Array.isArray(links) ? sourcesOf([{ type: 'web_search_tool_result', content: links.map((l) => ({ type: 'web_search_result', ...(l as object) })) }]) : []
  } catch {
    return []
  }
}

