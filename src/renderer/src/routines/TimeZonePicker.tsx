/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A searchable time-zone picker (SK-08): a combobox over
// Intl.supportedValuesOf('timeZone'), with "Local time" (null) first.
// Arrow keys move, Enter picks, Escape closes.
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Globe } from 'lucide-react'
import { useT } from '../i18n/useT'
import { cx } from '../ui'
import { localTimeZone, searchTimeZones, timeZoneLabel, timeZoneList } from '../settings/logic/routines'

export interface TimeZonePickerProps {
  value: string | null
  onChange(zone: string | null): void
  id?: string
}

export function TimeZonePicker({ value, onChange, id }: TimeZonePickerProps): ReactElement {
  const t = useT()
  const listId = useId()
  const zones = useMemo(timeZoneList, [])
  const local = localTimeZone()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const options: Array<string | null> = useMemo(() => [...(query ? [] : [null]), ...searchTimeZones(zones, query)], [zones, query])
  const label = (zone: string | null): string => (zone === null ? t('skills.zone.local', { zone: timeZoneLabel(local) }) : timeZoneLabel(zone))

  const pick = (zone: string | null): void => {
    onChange(zone)
    setOpen(false)
    setQuery('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) setOpen(true)
      setActive((i) => Math.max(0, Math.min(options.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter' && open) {
      e.preventDefault()
      const zone = options[active]
      if (zone !== undefined) pick(zone)
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      setQuery('')
    }
  }

  return (
    <div className="rt-zone">
      <Globe aria-hidden className="rt-zone__icon" />
      <input
        ref={input}
        id={id}
        className="sp-input rt-zone__input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] !== undefined ? `${listId}-${active}` : undefined}
        placeholder={open ? t('skills.zone.search') : undefined}
        value={open ? query : label(value)}
        onFocus={() => {
          setOpen(true)
          setActive(0)
        }}
        onBlur={() => {
          setOpen(false)
          setQuery('')
        }}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={onKey}
        spellCheck={false}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label={t('skills.zone.list')} className="rt-zone__list">
          {options.length === 0 && <li className="rt-zone__none">{t('skills.zone.none')}</li>}
          {options.map((zone, i) => (
            <li
              key={zone ?? 'local'}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={zone === value}
              className={cx('rt-zone__option', i === active && 'rt-zone__option--active')}
              // Picks before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault()
                pick(zone)
              }}
              onMouseEnter={() => setActive(i)}
            >
              {label(zone)}
              {zone && <span className="rt-zone__raw">{zone}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
