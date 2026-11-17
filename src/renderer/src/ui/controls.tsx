/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cx } from './logic/format'
import { rovingIndex } from './logic/keys'

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
  /** Tooltip, and the accessible name when the label is only an icon. */
  title?: string
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentOption<T>[]
  value: T
  onChange(value: T): void
  /** Accessible name for the group, e.g. "Theme". */
  label: string
  /** 'lg' is the destination pages' pill track (DS-100): 40 px, a 32 px pill, a 4 px inset. */
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  disabled?: boolean
  className?: string
}

/** A radio group drawn as segments, with a highlight that slides to the choice. */
export function SegmentedControl<T extends string>({ options, value, onChange, label, size = 'md', fullWidth = false, disabled = false, className }: SegmentedControlProps<T>): ReactElement {
  const group = useRef<HTMLDivElement>(null)
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const [thumb, setThumb] = useState<{ x: number; width: number } | null>(null)
  const selected = options.findIndex((o) => o.value === value)
  const focusable = selected >= 0 ? selected : options.findIndex((o) => !o.disabled)

  // The highlight follows the selected segment, including when labels reflow.
  useLayoutEffect(() => {
    const measure = (): void => {
      const el = buttons.current[selected]
      setThumb(el ? { x: el.offsetLeft, width: el.offsetWidth } : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (group.current) observer.observe(group.current)
    return () => observer.disconnect()
  }, [selected, options.length])

  return (
    <div ref={group} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={cx('ui-segmented', `ui-segmented--${size}`, fullWidth && 'ui-segmented--full', className)}>
      {thumb && <span className="ui-segmented__thumb" aria-hidden style={{ width: thumb.width, transform: `translateX(${thumb.x}px)` }} />}
      {options.map((option, i) => (
        <button
          key={option.value}
          ref={(el) => {
            buttons.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={i === selected}
          aria-label={option.title && !hasText(option.label) ? option.title : undefined}
          title={option.title}
          tabIndex={i === focusable ? 0 : -1}
          disabled={disabled || option.disabled}
          className="ui-segmented__option"
          onClick={() => onChange(option.value)}
          onKeyDown={(e) => {
            const next = rovingIndex(e.key, i, options.length, { orientation: 'both', disabled: (j) => !!options[j]?.disabled })
            if (next === null) return
            e.preventDefault()
            const target = options[next]
            if (!target) return
            buttons.current[next]?.focus()
            // Radio semantics: moving selects.
            onChange(target.value)
          }}
        >
          {option.icon}
          {hasText(option.label) && <span>{option.label}</span>}
        </button>
      ))}
    </div>
  )
}

function hasText(node: ReactNode): boolean {
  return node !== null && node !== undefined && node !== false && node !== ''
}

export interface SwitchProps {
  checked: boolean
  onChange(checked: boolean): void
  /** Visible label; without one, pass aria-label. */
  label?: ReactNode
  description?: ReactNode
  'aria-label'?: string
  disabled?: boolean
  id?: string
  size?: 'sm' | 'md'
  className?: string
}

/** An on/off switch. With a label it renders as a full settings row. */
export interface CheckRowProps {
  label: string
  checked: boolean
  onChange(checked: boolean): void
  /** A 16 px glyph between the check and the label. */
  icon?: ReactNode
  disabled?: boolean
  className?: string
}

/**
 * A 36 px row with a round check (DS-91): an ink disc with a paper tick when
 * on, a thin grey ring when off, then an optional glyph and a muted label.
 */
export function CheckRow({ label, checked, onChange, icon, disabled = false, className }: CheckRowProps): ReactElement {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} className={cx('ui-check-row', checked && 'ui-check-row--on', className)} onClick={() => onChange(!checked)}>
      <span className="ui-check-row__mark" aria-hidden="true">
        {checked && <Check />}
      </span>
      {icon && (
        <span className="ui-check-row__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="ui-check-row__label">{label}</span>
    </button>
  )
}

export function Switch({ checked, onChange, label, description, 'aria-label': ariaLabel, disabled = false, id, size = 'md', className }: SwitchProps): ReactElement {
  const auto = useId()
  const switchId = id ?? auto
  const descId = `${switchId}-description`
  const control = (
    <button
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-describedby={description ? descId : undefined}
      disabled={disabled}
      className={cx('ui-switch', `ui-switch--${size}`, !label && className)}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch__thumb" aria-hidden />
    </button>
  )
  if (!label) return control
  return (
    <div className={cx('ui-switch-row', disabled && 'ui-switch-row--disabled', className)}>
      <div className="ui-switch-row__text">
        <label htmlFor={switchId} className="ui-switch-row__label">
          {label}
        </label>
        {description && (
          <span id={descId} className="ui-switch-row__description">
            {description}
          </span>
        )}
      </div>
      {control}
    </div>
  )
}

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

export interface SelectGroup<T extends string> {
  label: string
  options: readonly SelectOption<T>[]
}

export interface SelectProps<T extends string> {
  value: T
  options: readonly (SelectOption<T> | SelectGroup<T>)[]
  onChange(value: T): void
  'aria-label'?: string
  id?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  fullWidth?: boolean
  className?: string
}

/** A styled native select; its list is a native popup, so it draws above page views. */
export function Select<T extends string>({ value, options, onChange, 'aria-label': ariaLabel, id, disabled = false, size = 'md', fullWidth = false, className }: SelectProps<T>): ReactElement {
  const renderOption = (o: SelectOption<T>): ReactElement => (
    <option key={o.value} value={o.value} disabled={o.disabled}>
      {o.label}
    </option>
  )
  return (
    <span className={cx('ui-select', `ui-select--${size}`, fullWidth && 'ui-select--full', className)}>
      <select id={id} aria-label={ariaLabel} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) =>
          'options' in o ? (
            <optgroup key={o.label} label={o.label}>
              {o.options.map(renderOption)}
            </optgroup>
          ) : (
            renderOption(o)
          ),
        )}
      </select>
      <ChevronDown className="ui-select__chevron" aria-hidden />
    </span>
  )
}
