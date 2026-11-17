/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'
import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_LOOK, type CompanionLook, type CompanionMood } from '@shared/companion'

vi.mock('../src/renderer/src/companion/images', () => ({ useCompanionImage: () => 'data:image/png;base64,AAAA' }))

// The component is JSX, which the node test project does not compile, so it is loaded by path and typed here.
interface AvatarProps {
  look: CompanionLook
  name: string
  size: number
  mood?: CompanionMood
  mark?: 'working' | 'approval' | 'unread' | 'done' | 'error' | 'routine' | null
  label?: string
}
const avatarModule = '../src/renderer/src/companion/FaceAvatar'
const { FaceAvatar } = (await import(/* @vite-ignore */ avatarModule)) as { FaceAvatar: FunctionComponent<AvatarProps> }

const render = (props: Partial<AvatarProps> & { size: number }): string => renderToStaticMarkup(createElement(FaceAvatar, { look: DEFAULT_LOOK, name: 'Pip', ...props }))

describe('floating heads (CO-18, DS-67)', () => {
  it('draws a 20 px sidebar head and a 16 px tab badge with no disc, ring or mask', () => {
    for (const size of [20, 16]) {
      const html = render({ size, mood: 'working' })
      expect(html).not.toContain('face-avatar__disc')
      expect(html).toContain('class="face-avatar__head"')
      expect(html).not.toMatch(/mask|border-radius/)
    }
  })

  it('puts the state mark beside the head, after it in the flow, never inside it', () => {
    const html = render({ size: 20, mood: 'happy' })
    const head = html.indexOf('face-avatar__head')
    const mark = html.indexOf('face-avatar__mark')
    expect(mark).toBeGreaterThan(head)
    // The head closes before the mark opens: the mark is a sibling, not a child.
    const headClose = html.indexOf('</span>', html.indexOf('<img', head))
    expect(mark).toBeGreaterThan(headClose)
  })

  it('collapses the mark when there is no state, so titles line up', () => {
    expect(render({ size: 20 })).not.toContain('face-avatar__mark')
    expect(render({ size: 20, mood: 'working', mark: null })).not.toContain('face-avatar__mark')
  })

  it('names the state for screen readers, including a routine run', () => {
    expect(render({ size: 20, mood: 'sad' })).toContain('aria-label="Pip, something went wrong"')
    expect(render({ size: 20, mark: 'routine' })).toContain('aria-label="Pip, routine run"')
    expect(render({ size: 20, label: '' })).toContain('aria-hidden="true"')
  })
})
