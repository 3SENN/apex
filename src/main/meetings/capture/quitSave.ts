/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Quitting mid-recording (index.ts installs it as the first 'before-quit'
// listener after the private-chat question): the recording is stopped first,
// so what was recorded is saved (for an audio-only meeting the audio is the
// meeting; cancelling would throw it away), then Apex quits again. A quit
// asked again while it saves waits for the same save; a quit someone else
// holds, or an update's (it stops the recording itself), goes by untouched.

export interface QuitSaveDeps {
  /** A recording is starting, running, paused or stopping. */
  live(): boolean
  /** Stops it and saves what was recorded. */
  stop(): Promise<void>
  /** An update is quitting to install. */
  updating(): boolean
  /** Quits again, once saved (or the wait ran out). */
  quit(): void
  /** The longest a quit waits for the save. */
  timeoutMs: number
  warn?(message: string, data: Record<string, string>): void
  setTimer?(fn: () => void, ms: number): unknown
}

export function quitSaver(deps: QuitSaveDeps): (event: { defaultPrevented: boolean; preventDefault(): void }) => void {
  let phase: 'idle' | 'saving' | 'saved' = 'idle'
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  return (event) => {
    if (event.defaultPrevented || phase === 'saved' || deps.updating()) return
    if (phase === 'idle' && !deps.live()) return
    event.preventDefault()
    if (phase === 'saving') return
    phase = 'saving'
    const cap = new Promise<void>((resolve) => setTimer(resolve, deps.timeoutMs))
    void Promise.race([deps.stop(), cap])
      .catch((err: unknown) => deps.warn?.('Saving the recording before quitting failed', { error: String(err) }))
      .finally(() => {
        phase = 'saved'
        deps.quit()
      })
  }
}
