/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Component, useEffect, useId, useLayoutEffect, useRef, useState, type ErrorInfo, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { Info, Lock, OctagonAlert, TriangleAlert } from 'lucide-react'
import type { DialogButton, DialogButtonStyle, DialogIcon, DialogResult, DialogSpec } from '@shared/dialogs'
import { buttonRows, escapeButton, initialFocus, initialValues, keyAction, resultFor } from '@shared/dialogLogic'
import { useT } from '../../../../i18n/useT'
import { tabbables } from '../../../../ui/layers'
import { cx } from '../../../../ui/logic/format'
import { trapFocusIndex } from '../../../../ui/logic/keys'
import './dialog.css'

// One dialog, built from a DialogSpec's parts (OV-07): icon, title,
// description, a callout, inputs, a checkbox and styled buttons, each with
// its Enter or Esc role. The overlay's `dialog` surface and the chrome's
// fallback both draw this, so they look and answer alike. Focus is trapped
// inside; a part that fails to draw falls back to a plain version.

const ICONS: Record<DialogIcon, ReactNode> = {
  info: <Info />,
  warning: <TriangleAlert />,
  danger: <OctagonAlert />,
  lock: <Lock />,
}

export interface DialogViewProps {
  spec: DialogSpec
  /** The site a page dialog came from, shown under the title. */
  origin?: string | null
  onAnswer(result: DialogResult): void
  /** Plays the exit; the dialog no longer reacts. */
  exiting?: boolean
}

// The kit's buttons, so dialogs match every other surface; outline and link are dialog-only.
const KIT_VARIANT: Record<DialogButtonStyle, string> = {
  primary: 'ui-btn--primary',
  secondary: 'ui-btn--secondary',
  outline: 'dlg-btn--outline',
  ghost: 'ui-btn--ghost',
  destructive: 'ui-btn--danger',
  link: 'dlg-btn--link',
}

function buttonClass(style: DialogButtonStyle): string {
  return cx('ui-btn', 'ui-btn--md', KIT_VARIANT[style], 'dlg-btn')
}

function DialogBody({ spec, origin, onAnswer, exiting = false }: DialogViewProps): ReactElement {
  const t = useT()
  const titleId = useId()
  const descId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [values, setValues] = useState(() => initialValues(spec))
  const [checked, setChecked] = useState(spec.checkbox?.checked ?? false)
  const answered = useRef(false)

  const answer = (button: DialogButton | null): void => {
    if (answered.current || exiting) return
    answered.current = true
    onAnswer(resultFor(spec, button, values, checked))
  }

  // Focus goes in once: the first field, else the safe button (OV-07).
  useLayoutEffect(() => {
    const focus = initialFocus(spec)
    const el = focus ? panel.current?.querySelector<HTMLElement>(`[data-dlg-${focus.kind}="${CSS.escape(focus.id)}"]`) : null
    ;(el ?? panel.current)?.focus({ preventScroll: true })
    if (el instanceof HTMLInputElement) el.select()
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Tab') {
      const items = tabbables(panel.current)
      if (!items.length) return
      const current = items.indexOf(document.activeElement as HTMLElement)
      const atEdge = current === -1 || (e.shiftKey ? current === 0 : current === items.length - 1)
      if (!atEdge) return
      e.preventDefault()
      items[trapFocusIndex(current, items.length, e.shiftKey)]?.focus()
      return
    }
    const target = e.target as HTMLElement
    const action = keyAction(spec, e.key, { tag: target.tagName, type: (target as HTMLInputElement).type })
    if (!action) return
    e.preventDefault()
    e.stopPropagation()
    answer(action.press)
  }

  const rows = buttonRows(spec)
  const danger = spec.icon === 'danger' || spec.icon === 'warning' || spec.buttons.some((b) => b.style === 'destructive')
  const renderButton = (b: DialogButton): ReactElement => (
    <button key={b.id} type="button" className={buttonClass(b.style)} data-dlg-button={b.id} onClick={() => answer(b)} disabled={exiting}>
      {b.label}
    </button>
  )

  return (
    <div
      ref={panel}
      className="dlg"
      role={danger ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={spec.description ? descId : undefined}
      tabIndex={-1}
      data-state={exiting ? 'closing' : 'open'}
      onKeyDown={onKeyDown}
    >
      <header className="dlg__header">
        {spec.icon && <span className={cx('dlg__icon', `dlg__icon--${spec.icon}`)} aria-hidden>{ICONS[spec.icon]}</span>}
        <div className="dlg__heading">
          <h2 id={titleId} className="dlg__title">
            {spec.title}
          </h2>
          {origin && <p className="dlg__origin">{origin}</p>}
        </div>
      </header>
      {spec.description && (
        <p id={descId} className="dlg__description">
          {spec.description}
        </p>
      )}
      {spec.callout && <div className="dlg__callout">{spec.callout}</div>}
      {spec.inputs && spec.inputs.length > 0 && (
        <div className="dlg__fields">
          {spec.inputs.map((input) => (
            <label key={input.id} className="dlg__field">
              <span className="dlg__label">{input.label}</span>
              <input
                className="dlg__input"
                data-dlg-input={input.id}
                type={input.type}
                value={values[input.id] ?? ''}
                autoComplete={input.type === 'password' ? 'current-password' : 'off'}
                spellCheck={false}
                maxLength={10_000}
                onChange={(e) => setValues((v) => ({ ...v, [input.id]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}
      {spec.checkbox && (
        <label className="dlg__check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>{spec.checkbox.label}</span>
        </label>
      )}
      <footer className="dlg__footer">
        <div className="dlg__buttons dlg__buttons--start">{rows.start.map(renderButton)}</div>
        <div className="dlg__buttons dlg__buttons--end">{rows.end.map(renderButton)}</div>
      </footer>
      <span className="dlg__sr">{t('menus.dialog.keysHint')}</span>
    </div>
  )
}

/** The plain fallback: same answers, no styling beyond the basics (OV-07). */
function PlainDialog({ spec, onAnswer }: DialogViewProps): ReactElement {
  const values = useRef(initialValues(spec))
  const checked = useRef(spec.checkbox?.checked ?? false)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onAnswer(resultFor(spec, escapeButton(spec), values.current, checked.current))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="dlg dlg--plain" role="dialog" aria-modal="true" aria-label={spec.title}>
      <h2 className="dlg__title">{spec.title}</h2>
      {spec.description && <p className="dlg__description">{spec.description}</p>}
      {spec.inputs?.map((input) => (
        <label key={input.id} className="dlg__field">
          <span className="dlg__label">{input.label}</span>
          <input className="dlg__input" type={input.type} defaultValue={input.value ?? ''} onChange={(e) => (values.current[input.id] = e.target.value)} />
        </label>
      ))}
      {spec.checkbox && (
        <label className="dlg__check">
          <input type="checkbox" defaultChecked={spec.checkbox.checked} onChange={(e) => (checked.current = e.target.checked)} />
          <span>{spec.checkbox.label}</span>
        </label>
      )}
      <div className="dlg__buttons dlg__buttons--end">
        {spec.buttons.map((b) => (
          <button key={b.id} type="button" className="dlg-btn" onClick={() => onAnswer(resultFor(spec, b, values.current, checked.current))}>
            {b.label}
          </button>
        ))}
      </div>
    </div>
  )
}

class Fallback extends Component<DialogViewProps & { children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('A dialog failed to draw:', error, info.componentStack)
  }

  override render(): ReactNode {
    return this.state.failed ? <PlainDialog {...this.props} /> : this.props.children
  }
}

export function DialogView(props: DialogViewProps): ReactElement {
  return (
    <Fallback {...props}>
      <DialogBody {...props} />
    </Fallback>
  )
}
