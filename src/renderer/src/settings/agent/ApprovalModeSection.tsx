/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Agent permissions › Approval mode (ST-12, CH-39): a radio list
// of Standard, Ask for everything and Don't ask until Atelier quits. The last
// one lives in main's memory only, so it asks for a confirmation with a
// warning and never reaches Settings; main's `agent-mode` event keeps this
// list (and the persistent indicator) in step with the effective mode.
import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Check, LockKeyhole, ShieldAlert } from 'lucide-react'
import type { ApprovalMode } from '@shared/agentTools'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { call, errorText } from '../../api'
import { useT } from '../../i18n/useT'
import { Button, confirm, cx, useToast } from '../../ui'
import { useEvent, useResource } from '../data'
import { Card, Notice, Section } from '../kit'

const MODES: ReadonlyArray<{ id: ApprovalMode; title: 'agent.approvalMode.standard' | 'agent.approvalMode.askAll' | 'agent.approvalMode.dontAsk'; hint: 'agent.approvalMode.standardHint' | 'agent.approvalMode.askAllHint' | 'agent.approvalMode.dontAskHint' }> = [
  { id: 'standard', title: 'agent.approvalMode.standard', hint: 'agent.approvalMode.standardHint' },
  { id: 'ask-all', title: 'agent.approvalMode.askAll', hint: 'agent.approvalMode.askAllHint' },
  { id: 'dont-ask', title: 'agent.approvalMode.dontAsk', hint: 'agent.approvalMode.dontAskHint' },
]

export function ApprovalModeSection({ settings, update }: { settings: SettingsView; update(patch: SettingsPatch): void | Promise<void> }): ReactElement {
  const t = useT()
  const toast = useToast()
  const mode = useResource(() => call('agent', 'approvalMode'))
  useEvent('agent-mode', (e) => mode.set(e.mode))
  const [busy, setBusy] = useState(false)
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  // Until main answers, the stored mode is the best guess (Don't ask is never stored).
  const current: ApprovalMode = mode.data ?? settings.approvalMode

  const choose = async (next: ApprovalMode): Promise<void> => {
    if (next === current || busy) return
    if (next === 'dont-ask') {
      const ok = await confirm({
        title: t('agent.approvalMode.confirmTitle'),
        message: t('agent.approvalMode.confirmMessage', { mode: t(settings.approvalMode === 'ask-all' ? 'agent.approvalMode.askAll' : 'agent.approvalMode.standard') }),
        confirmLabel: t('agent.approvalMode.confirm'),
        destructive: true,
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      mode.set(await call('agent', 'setApprovalMode', next))
    } catch (err) {
      toast.show({ tone: 'error', message: `${t('agent.approvalMode.failed')}: ${errorText(err)}` })
    } finally {
      setBusy(false)
    }
  }

  const onKey = (event: KeyboardEvent, index: number): void => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + MODES.length) % MODES.length
    refs.current[next]?.focus()
    // Arrowing onto Don't ask only focuses it; choosing it needs Space or Enter, then the confirmation.
    const choice = MODES[next]
    if (choice && choice.id !== 'dont-ask') void choose(choice.id)
  }

  return (
    <Section title={t('agent.approvalMode.title')} note={t('agent.approvalMode.note')}>
      {current === 'dont-ask' && (
        <Notice tone="warning" action={<Button size="sm" onClick={() => void choose(settings.approvalMode)}>{t('agent.approvalMode.turnBackOn')}</Button>}>
          {t('agent.approvalMode.activeWarning')}
        </Notice>
      )}
      {current !== 'dont-ask' && !settings.confirmConsequentialActions && (
        <Notice tone="warning" action={<Button size="sm" onClick={() => void update({ confirmConsequentialActions: true })}>{t('agent.approvalMode.legacyFix')}</Button>}>
          {t('agent.approvalMode.legacyOff')}
        </Notice>
      )}
      <Card>
        <div className="ag-modes" role="radiogroup" aria-label={t('agent.approvalMode.label')} aria-busy={busy || undefined}>
          {MODES.map((m, i) => {
            const selected = m.id === current
            return (
              <button
                key={m.id}
                ref={(el) => {
                  refs.current[i] = el
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                className={cx('ag-mode', selected && 'ag-mode--selected', m.id === 'dont-ask' && 'ag-mode--risky')}
                onClick={() => void choose(m.id)}
                onKeyDown={(e) => onKey(e, i)}
              >
                <span className={cx('ag-mode__radio', selected && 'ag-mode__radio--on')} aria-hidden>
                  <Check />
                </span>
                <span className="ag-mode__text">
                  <span className="ag-mode__title">
                    {t(m.title)}
                    {m.id === 'dont-ask' && <ShieldAlert className="ag-mode__warn" aria-hidden />}
                  </span>
                  <span className="ag-mode__hint">{t(m.hint)}</span>
                </span>
              </button>
            )
          })}
        </div>
        <div className="sp-row">
          <span className="sp-item__icon" aria-hidden>
            <LockKeyhole />
          </span>
          <div className="sp-row__text">
            <span className="sp-row__title">{t('agent.approvalMode.guardedTitle')}</span>
            <span className="sp-row__description">{t('agent.approvalMode.guardedHint')}</span>
          </div>
        </div>
      </Card>
    </Section>
  )
}
