/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Search } from 'lucide-react'
import type { DeviceChooserAnswer, DeviceChooserProps } from '@shared/overlay/sites'
import type { DeviceEntry } from '@shared/sites'
import { useT } from '../../../i18n/useT'
import { Button, EmptyState, Spinner, useRovingFocus } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { filterDevices, validPin } from './logic'
import { PermIcon, useSiteRequest } from './parts'

// The device chooser (OV-15): a modal over the asking tab for HID, USB,
// serial and Bluetooth requests. Main keeps the list live (a Bluetooth scan
// keeps reporting); search narrows it. A click selects, a double-click or
// Enter connects; Cancel or Esc refuses. "Remember for this site" keeps the
// device granted (never in a private window). Bluetooth pairing steps on
// Windows and Linux reuse this surface: confirm, compare a PIN, or enter one.

export function DeviceChooser(surface: SurfaceComponentProps<DeviceChooserProps>): ReactElement {
  return surface.props.pairing ? <Pairing {...surface} /> : <Chooser {...surface} />
}

function Chooser({ props, resolve, close }: SurfaceComponentProps<DeviceChooserProps>): ReactElement {
  const t = useT()
  const titleId = useId()
  const [devices, setDevices] = useState<DeviceEntry[]>(props.devices)
  const [scanning, setScanning] = useState(props.scanning)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [remember, setRemember] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  useSiteRequest(props.requestId, {
    onClosed: close,
    onChange: (e) => {
      if (e.devices) setDevices(e.devices)
      if (e.scanning !== undefined) setScanning(e.scanning)
    },
  })

  const shown = filterDevices(devices, query)
  // A device that went away can't be chosen.
  const chosen = devices.find((d) => d.id === selected) ?? null
  const connect = (device: DeviceEntry | null): void => {
    if (!device) return
    const answer: DeviceChooserAnswer = { deviceId: device.id, remember: props.canRemember && remember }
    resolve(answer)
  }
  const onListKey = useRovingFocus(list, { selector: '[role="option"]', orientation: 'vertical', onMove: (el) => setSelected(el.dataset.deviceId ?? null) })
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' || !chosen || (e.target as HTMLElement).closest('button, input')) return
    e.preventDefault()
    connect(chosen)
  }

  return (
    <div className="st-scrim">
      <div className="st-card st-modal st-chooser" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <header className="st-modal__head">
          <span className="st-prompt__glyph" aria-hidden>
            <PermIcon perm={props.kind} />
          </span>
          <h2 id={titleId} className="st-modal__title">
            {t(`sites.device.title.${props.kind}`, { host: props.host })}
          </h2>
        </header>

        {devices.length > 0 && (
          <label className="st-search">
            <Search size={14} aria-hidden />
            <input type="search" value={query} placeholder={t('sites.device.search')} aria-label={t('sites.device.search')} onChange={(e) => setQuery(e.target.value)} data-autofocus />
          </label>
        )}

        <div className="st-chooser__body" aria-live="polite">
          {shown.length > 0 ? (
            <div ref={list} className="st-devices" role="listbox" aria-labelledby={titleId} onKeyDown={onListKey}>
              {shown.map((device, i) => {
                const isSelected = device.id === selected
                const focusable = isSelected || (!shown.some((d) => d.id === selected) && i === 0)
                return (
                  <div
                    key={device.id}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={focusable ? 0 : -1}
                    data-device-id={device.id}
                    className="st-device"
                    onClick={() => setSelected(device.id)}
                    onDoubleClick={() => connect(device)}
                  >
                    <span className="st-row__glyph" aria-hidden>
                      <PermIcon perm={props.kind} size={15} />
                    </span>
                    <span className="st-row__text st-row__grow">
                      <span className="st-row__title">{device.name}</span>
                      {device.detail && <span className="st-row__desc">{device.detail}</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : devices.length > 0 ? (
            <EmptyState compact title={t('sites.device.noMatch', { query: query.trim() })} />
          ) : scanning ? (
            <p className="st-scanning" role="status">
              <Spinner size={12} />
              {t('sites.device.scanning')}
            </p>
          ) : (
            <EmptyState compact icon={<PermIcon perm={props.kind} size={20} />} title={t('sites.device.none')} description={t('sites.device.noneHint')} />
          )}
          {scanning && shown.length > 0 && (
            <p className="st-scanning st-small" role="status">
              <Spinner size={12} />
              {t('sites.device.scanning')}
            </p>
          )}
        </div>

        <footer className="st-actions st-modal__foot">
          {props.canRemember && (
            <label className="st-check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>{t('sites.device.remember')}</span>
            </label>
          )}
          <span className="st-row__grow" />
          <Button variant="secondary" size="sm" onClick={close}>
            {t('sites.device.cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={!chosen} onClick={() => connect(chosen)}>
            {t('sites.device.connect')}
          </Button>
        </footer>
      </div>
    </div>
  )
}

function Pairing({ props, resolve, close }: SurfaceComponentProps<DeviceChooserProps>): ReactElement {
  const t = useT()
  const titleId = useId()
  const [pin, setPin] = useState('')
  useSiteRequest(props.requestId, { onClosed: close })
  const step = props.pairing!
  const name = props.pairingName ?? t('sites.device.unnamed')
  const ready = step.kind !== 'provide-pin' || validPin(pin)
  const answer = (confirmed: boolean): void => {
    if (confirmed && !ready) return
    const value: DeviceChooserAnswer = step.kind === 'provide-pin' && confirmed ? { confirmed, pin: pin.trim() } : { confirmed }
    resolve(value)
  }
  const title = step.kind === 'confirm' ? t('sites.device.pairTitle', { name }) : step.kind === 'confirm-pin' ? t('sites.device.pinCheck', { name }) : t('sites.device.pinEnter', { name })

  return (
    <div className="st-scrim">
      <form
        className="st-card st-modal st-pairing"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => {
          e.preventDefault()
          answer(true)
        }}
      >
        <header className="st-modal__head">
          <span className="st-prompt__glyph" aria-hidden>
            <PermIcon perm="bluetooth" />
          </span>
          <h2 id={titleId} className="st-modal__title">
            {title}
          </h2>
        </header>
        {step.kind === 'confirm-pin' && (
          <p className="st-pin" aria-label={t('sites.device.pinLabel')}>
            {step.pin}
          </p>
        )}
        {step.kind === 'provide-pin' && (
          <label className="st-field">
            <span>{t('sites.device.pinLabel')}</span>
            <input className="st-input st-mono" inputMode="text" autoComplete="off" maxLength={16} value={pin} onChange={(e) => setPin(e.target.value)} data-autofocus />
          </label>
        )}
        <footer className="st-actions st-modal__foot">
          <span className="st-row__grow" />
          <Button variant="secondary" size="sm" onClick={() => answer(false)}>
            {t('sites.device.cancel')}
          </Button>
          <Button variant="primary" size="sm" type="submit" disabled={!ready} data-autofocus={step.kind === 'provide-pin' ? undefined : true}>
            {t('sites.device.pair')}
          </Button>
        </footer>
      </form>
    </div>
  )
}
