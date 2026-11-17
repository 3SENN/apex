/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { forwardRef, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, LoaderCircle } from 'lucide-react'
import { accentTokens } from '@shared/accent'
import type { Companion } from '@shared/companion'
import { useT } from '../../i18n/useT'

export interface StartComposerProps {
  companion: Companion | null
  value: string
  placeholder: string
  label: string
  /** The short opening status after a send (DS-74). */
  opening: string | null
  /** While a companion is dragged: its colour, and whether it is over the composer. */
  drop: { tint: string; over: boolean } | null
  /** The send button's label and icon, e.g. "Add" on the add entry. */
  action?: { label: string; icon?: ReactNode; enabled: boolean }
  onChange(value: string, field: HTMLTextAreaElement): void
  onCaret(field: HTMLTextAreaElement): void
  onBlur(): void
  onSubmit(): void
  /** Keys the composer does not handle itself (the ←/→ companion choice). */
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void
  /** Below the card: the tray and ideas mount here (DS-108, DS-109). */
  children?: ReactNode
  // ── NT-01 new tab search ──
  /** The left of the action row: the ask-or-search switch. */
  lead?: ReactNode
  /** Drawn just under the card, over the tray: the actions and suggestions while typing. */
  popup?: ReactNode
  /** Sees each key first; returning true means it was handled (Enter, ⌥Enter, ↑/↓, Esc while there is text). */
  onKeyFirst?(event: KeyboardEvent<HTMLTextAreaElement>): boolean
  onFocus?(): void
  /** The field as a combobox over the popup's list. */
  combobox?: { expanded: boolean; controls: string; active: string | undefined }
}

const LINE_PX = 26
const MAX_LINES = 5

/**
 * The new tab's composer, laid out as the start variant (DS-74): a 640 px
 * card with the text on top and the action row below, the send button in
 * the companion's fill. Enter sends and Shift+Enter starts a new line.
 * When the shared start composer lands (chat/Composer.tsx), it replaces this.
 */
export const StartComposer = forwardRef<HTMLFormElement, StartComposerProps>(function StartComposer(
  { companion, value, placeholder, label, opening, drop, action, onChange, onCaret, onBlur, onSubmit, onKeyDown, children, lead, popup, onKeyFirst, onFocus, combobox },
  ref,
) {
  const t = useT()
  const field = useRef<HTMLTextAreaElement>(null)
  // Fills stay the same in both modes (DS-139); the text on them is chosen for contrast.
  const fill = companion ? accentTokens(companion.look.colors.skin, 'light') : null
  const style = {
    ...(fill ? { ['--send-fill' as string]: fill.accent, ['--send-text' as string]: fill.text } : {}),
    ...(drop ? { ['--drop-tint' as string]: drop.tint } : {}),
  } as CSSProperties

  // Grows with its text, up to a few lines.
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = `${LINE_PX}px`
    el.style.height = `${Math.min(LINE_PX * MAX_LINES, Math.max(LINE_PX, el.scrollHeight))}px`
  }, [value])

  const enabled = action ? action.enabled : value.trim() !== '' && !opening
  return (
    <form
      ref={ref}
      className="nt-composer"
      data-drop={drop ? (drop.over ? 'over' : 'near') : undefined}
      style={style}
      onSubmit={(e) => {
        e.preventDefault()
        if (enabled) onSubmit()
      }}
    >
      <div className="nt-composer__card" data-pond-anchor>
        <textarea
          ref={field}
          className="nt-composer__field"
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-label={label}
          disabled={opening !== null}
          {...(combobox ? { role: 'combobox', 'aria-expanded': combobox.expanded, 'aria-controls': combobox.controls, 'aria-autocomplete': 'list' as const, 'aria-activedescendant': combobox.active } : {})}
          onChange={(e) => onChange(e.target.value, e.target)}
          onSelect={(e) => onCaret(e.currentTarget)}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (onKeyFirst?.(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (enabled) onSubmit()
              return
            }
            onKeyDown(e)
          }}
        />
        {opening && (
          <span className="nt-composer__opening" role="status">
            <LoaderCircle aria-hidden />
            {opening}
          </span>
        )}
        <div className="nt-composer__actions">
          {lead}
          <button type="submit" className="nt-composer__send" disabled={!enabled} aria-label={action?.label ?? t('tabs.newTabStartComposer.send')} title={action?.label ?? t('tabs.newTabStartComposer.send')}>
            {opening ? <LoaderCircle className="nt-composer__spin" aria-hidden /> : (action?.icon ?? <ArrowUp aria-hidden />)}
          </button>
        </div>
        {popup}
      </div>
      {children}
    </form>
  )
})
