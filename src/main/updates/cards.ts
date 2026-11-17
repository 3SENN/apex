/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { dialog } from 'electron'
import type { OverlayResult, SurfaceAnchor, SurfaceProps } from '@shared/overlay'
import type { UpdatesSurfaceProps, UpdatesSurfaceResults } from '@shared/overlay/updates'
import type { UpdateRestartRunning } from '@shared/updates'
import type { WindowContext } from '../features/types'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import type { WhatsNewCard } from './whatsNew'

// The update cards on a window's overlay host: the restart card and the
// unsupported prompt open on the focused window, so several windows never
// show the same question; what's new opens on the window it is given. Until
// the overlay host can open surfaces, the two questions fall back to a native
// message box (never in smoke, where a modal would hang the run).

export interface UpdateCards {
  askRestart(running: UpdateRestartRunning, version: string | null): Promise<'now' | 'when-idle' | null>
  askUnsupported(below: string, message: string | null): Promise<'update' | 'later' | null>
  /** True once the person closed the card (✕, Got it or Esc); false when it couldn't open or Atelier took it away (its window closed, a quit). */
  showWhatsNew(card: WhatsNewCard, win?: WindowContext | null): Promise<boolean>
}

/** The whole window as the anchor: each card places itself inside it. */
function windowAnchor(win: WindowContext): SurfaceAnchor {
  const { width, height } = win.window.getContentBounds()
  return { kind: 'window', rect: { x: 0, y: 0, width, height } }
}

function valueOf<S extends keyof UpdatesSurfaceResults>(result: OverlayResult, allowed: readonly UpdatesSurfaceResults[S][]): UpdatesSurfaceResults[S] | null {
  if (!('value' in result)) return null
  return allowed.find((a) => a === result.value) ?? null
}

export function restartLines(running: UpdateRestartRunning): string[] {
  const lines: string[] = []
  if (running.chats > 0) lines.push(mainT('updates.restart.chats', { count: running.chats }))
  if (running.routines > 0) lines.push(mainT('updates.restart.routines', { count: running.routines }))
  if (running.meeting) lines.push(mainT('updates.restart.meeting'))
  return lines
}

export function createUpdateCards(deps: { focused(): WindowContext | null; smoke: boolean }): UpdateCards {
  const usable = (win: WindowContext | null): win is WindowContext => Boolean(win && !win.window.isDestroyed())

  async function open<S extends keyof UpdatesSurfaceProps>(win: WindowContext, surface: S, props: UpdatesSurfaceProps[S]): Promise<OverlayResult | null> {
    try {
      return await win.overlay.open(surface, windowAnchor(win), props as SurfaceProps<S>)
    } catch (err) {
      log.warn('updates', "Couldn't open an update card", { surface, error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  return {
    async askRestart(running, version) {
      const win = deps.focused()
      if (!usable(win)) return null
      const result = await open(win, 'update-restart', { version, running })
      if (result) return valueOf<'update-restart'>(result, ['now', 'when-idle'])
      if (deps.smoke) return null
      const { response } = await dialog.showMessageBox(win.window, {
        type: 'question',
        message: mainT('updates.restart.title'),
        detail: [...restartLines(running), '', mainT('updates.restart.body')].join('\n'),
        buttons: [mainT('updates.restart.now'), mainT('updates.restart.whenDone'), mainT('updates.restart.cancel')],
        defaultId: 1,
        cancelId: 2,
      })
      return response === 0 ? 'now' : response === 1 ? 'when-idle' : null
    },

    async askUnsupported(below, message) {
      const win = deps.focused()
      if (!usable(win)) return null
      const result = await open(win, 'update-unsupported', { below, message })
      if (result) return valueOf<'update-unsupported'>(result, ['update', 'later'])
      if (deps.smoke) return null
      const { response } = await dialog.showMessageBox(win.window, {
        type: 'warning',
        message: mainT('updates.unsupported.title'),
        detail: message ?? mainT('updates.unsupported.body', { below }),
        buttons: [mainT('updates.unsupported.updateNow'), mainT('updates.unsupported.remindLater')],
        defaultId: 0,
        cancelId: 1,
      })
      return response === 0 ? 'update' : 'later'
    },

    async showWhatsNew(card, win = deps.focused()) {
      if (!usable(win)) return false
      const result = await open(win, 'whats-new', { entry: card.entry, since: card.since })
      if (!result) return false
      // The card's buttons resolve 'done'; Esc outside them is the overlay's 'escape'. Any other dismissal was Atelier's.
      return 'value' in result ? valueOf<'whats-new'>(result, ['done']) === 'done' : result.dismissed === 'escape'
    },
  }
}
