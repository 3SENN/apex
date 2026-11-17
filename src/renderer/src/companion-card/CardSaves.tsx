/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { Check, CircleAlert } from 'lucide-react'
import { cx, Spinner } from '../ui'
import { createSaveRegistry, type SaveRegistry, type SaveState } from './logic/saves'
import { useT } from '../i18n/useT'

// One floating save pill for the whole card. Fields report their autosave
// state with useReportSave; the pill under the header shows the most urgent
// one and fades out after "Saved".

const CardSavesContext = createContext<SaveRegistry | null>(null)

export const CardSavesProvider = CardSavesContext.Provider

export function useCardSaveRegistry(): SaveRegistry {
  const [registry] = useState(createSaveRegistry)
  return registry
}

let keys = 0

/** Reports one field's save state (and how to flush it) to the card's pill. */
export function useReportSave(state: SaveState, retry?: () => void, flush?: () => Promise<void>): void {
  const registry = useContext(CardSavesContext)
  const [key] = useState(() => `field-${++keys}`)
  useEffect(() => {
    registry?.report(key, { state, retry, flush })
  })
  useEffect(() => () => registry?.report(key, null), [registry, key])
}

/** "Saving…", "Saved", "Couldn't save · Retry", or a long action, centred under the header. */
export function FloatingSave(): ReactElement | null {
  const t = useT()
  const registry = useContext(CardSavesContext)
  const subscribe = useCallback((l: () => void) => registry?.subscribe(l) ?? (() => undefined), [registry])
  const summary = useSyncExternalStore(subscribe, () => registry?.summary() ?? null)
  // The last state with something to say stays drawn while the pill fades out.
  const [shown, setShown] = useState<{ state: SaveState; busy: string | null }>({ state: 'idle', busy: null })
  const state = summary?.state ?? 'idle'
  const busy = summary?.busy ?? null
  const visible = busy !== null || state !== 'idle'
  useEffect(() => {
    if (visible) setShown({ state, busy })
  }, [visible, state, busy])
  return (
    <div className={cx('co-save-pill', visible && 'co-save-pill--shown', `co-save-pill--${shown.busy ? 'busy' : shown.state}`)} aria-live="polite" role="status">
      {shown.busy ? (
        <>
          <Spinner size={11} /> {shown.busy}
        </>
      ) : shown.state === 'saving' ? (
        <>
          <Spinner size={11} /> {t('coCard.cardSaves.saving')}
        </>
      ) : shown.state === 'error' ? (
        <>
          <CircleAlert aria-hidden /> {t('coCard.cardSaves.couldnTSave')}
          {summary?.retry && (
            <button type="button" className="co-save-pill__retry" onClick={summary.retry}>
              {t('coCard.cardSaves.retry')}
            </button>
          )}
        </>
      ) : shown.state === 'saved' ? (
        <>
          <Check aria-hidden /> {t('coCard.cardSaves.saved')}
        </>
      ) : null}
    </div>
  )
}
