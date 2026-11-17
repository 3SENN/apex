/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { Maximize2, Minus, Plus, UserRound } from 'lucide-react'
import type { MainMenuModel, MainMenuSurfaceProps } from '@shared/menuBase'
import { ENGINE_LABELS, isEngine } from '@shared/engine'
import { MAIN_MENU_SPECIAL } from '@shared/menuBase'
import { formatUsd, gaugeFraction } from '@shared/pricing'
import { ACCENT_HUES, type AccentChoice, type ThemePreference } from '@shared/theme'
import type { LayoutMode } from '@shared/ipc'
import { atelier, call } from '../../../../api'
import { t } from '../../../../i18n/useT'
import { cx } from '../../../../ui/logic/format'
import { CascadeMenu, MenuScrim, Popover, fromMenuModel, inChromeHost, unionBox, type Box, type KitItem } from '../../../kit'
import type { SurfaceComponentProps } from '../../../types'

// The main menu (SH-54, SH-16, DS-93): a 236 px card above the sidebar
// footer (or under the toolbar's menu button) with a local profile block,
// then 30 px rows that cascade into side cards. Theme, accent, layout, ad
// blocking and zoom change in place; everything else closes the menu and
// runs. No account, plan or upgrade rows.

function anchorBox(anchor: SurfaceComponentProps<unknown>['anchor'], rect: SurfaceComponentProps<unknown>['anchorRect']): Box {
  // The host resolved the anchor to window CSS px; tab anchors need that.
  if (rect) return { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
  if (anchor.kind === 'window') return { left: anchor.rect.x, top: anchor.rect.y, width: anchor.rect.width, height: anchor.rect.height }
  if (anchor.kind === 'point') return { left: anchor.x, top: anchor.y, width: 0, height: 0 }
  return anchor.rect ? { left: anchor.rect.x, top: anchor.rect.y, width: anchor.rect.width, height: anchor.rect.height } : { left: 0, top: 0, width: 0, height: 0 }
}

export function MainMenu({ instanceId, props, anchor, anchorRect, resolve, close, reportBounds }: SurfaceComponentProps<MainMenuSurfaceProps>): ReactElement {
  const [model, setModel] = useState<MainMenuModel>(props.model)
  useEffect(() => setModel(props.model), [props.model])
  const mac = model.platform === 'darwin'

  const refresh = useCallback(() => {
    void call('menus', 'mainMenu').then(setModel, () => undefined)
  }, [])

  /** In place: a settings change shows at once and main's next model confirms it. */
  const setSetting = useCallback((patch: Partial<Pick<MainMenuModel, 'theme' | 'layout' | 'adblock'>> & { accent?: AccentChoice }) => {
    setModel((m) => ({ ...m, ...patch }))
    void atelier.settings.set(patch).then(refresh, refresh)
  }, [refresh])

  const runInPlace = useCallback((id: string) => {
    void call('menus', 'run', id).then(refresh, refresh)
  }, [refresh])

  const items = useMemo<KitItem[]>(
    () =>
      fromMenuModel(model.items, {
        mac,
        override: (item) => {
          if (item.id === MAIN_MENU_SPECIAL.appearance) return { submenu: undefined, panel: () => <AppearancePanel model={model} onSet={setSetting} /> }
          if (item.id === MAIN_MENU_SPECIAL.zoom) return { kind: 'custom', render: () => <ZoomRow percent={model.zoomPercent} mac={mac} onRun={runInPlace} onFullScreen={() => resolve({ id: 'toggle-fullscreen' })} /> }
          if (item.id === 'adblock') return { kind: 'switch', checked: model.adblock }
          return null
        },
      }),
    [model, mac, setSetting, runInPlace, resolve],
  )

  const rootBox = useRef<Box | null>(null)
  const subBox = useRef<Box | null>(null)
  // In the overlay host the surface fills the window, so only the chrome fallback reports its cards (it hides the page under them).
  const chrome = inChromeHost(instanceId)
  const report = (): void => {
    if (!chrome) return
    const box = unionBox([rootBox.current, subBox.current].filter((b): b is Box => !!b))
    if (box) reportBounds({ x: box.left, y: box.top, width: box.width, height: box.height })
  }

  // An engine with its own sign-in needs no key (ST-58).
  const other = props.profile.engine !== 'api-key' && isEngine(props.profile.engine) ? props.profile.engine : null
  const hasKey = props.profile.hasApiKey || other !== null
  const name = props.profile.name.trim()
  return (
    <>
    {!chrome && <MenuScrim onDismiss={close} />}
    <Popover
      anchor={anchorBox(anchor, anchorRect)}
      side={props.placement}
      align="start"
      gap={8}
      width={236}
      rowHeight={30}
      label={t('menus.main.label')}
      className="mm"
      onBounds={(box) => {
        rootBox.current = box
        report()
      }}
    >
      <div className="mm-head">
        <div className="mm-profile">
          <span className="mm-badge" aria-hidden="true">
            {props.profile.avatar ? <img src={props.profile.avatar} alt="" draggable={false} /> : name ? name.charAt(0).toUpperCase() : <UserRound />}
          </span>
          <span className="mm-who">
            <span className="mm-name">{name || t('menus.main.you')}</span>
            <span className="mm-status">{other ? ENGINE_LABELS[other] : props.profile.hasApiKey ? t('menus.main.keyReady') : t('menus.main.keyMissing')}</span>
          </span>
          <button type="button" className="mm-manage" onClick={() => resolve({ id: 'manage-profile' })}>
            {t('menus.main.manage')}
          </button>
        </div>
        {props.profile.engine === 'api-key' && props.spend && <SpendMeter spend={props.spend} />}
        <button type="button" className="mm-primary" onClick={() => resolve({ id: hasKey ? 'open-settings' : 'add-api-key' })}>
          {hasKey ? t('menus.main.settingsButton') : t('menus.main.addKey')}
        </button>
      </div>
      <CascadeMenu
        items={items}
        label={t('menus.main.label')}
        submenuWidth={240}
        handlers={{
          onChoose: (item) => resolve({ id: item.id }),
          onAction: (item, checked) => {
            if (item.id === 'adblock') setSetting({ adblock: checked ?? !model.adblock })
          },
          // Escape gives focus back to the opener; Tab and outside presses just close.
          onDismiss: (refocus) => (refocus ? resolve({ refocus: true }) : close()),
        }}
        onSubmenusBounds={(box) => {
          subBox.current = box
          report()
        }}
      />
    </Popover>
    </>
  )
}

/** DS-93's meter row: this month's estimated spend on your own key, against your budget when you set one. */
function SpendMeter({ spend }: { spend: NonNullable<MainMenuSurfaceProps['spend']> }): ReactElement {
  const fraction = spend.budgetUsd ? gaugeFraction(spend) : 0
  const text = spend.budgetUsd ? t('menus.main.meterBudget', { spent: formatUsd(spend.usd), budget: formatUsd(spend.budgetUsd) }) : t('menus.main.meter', { spent: formatUsd(spend.usd) })
  return (
    <div className="mm-meter" role="group" aria-label={t('menus.main.meterLabel')}>
      <span className="mm-meter__label">{text}</span>
      {spend.budgetUsd ? (
        <span className="mm-meter__bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} aria-label={t('menus.main.meterLabel')}>
          <span style={{ width: `${Math.round(fraction * 100)}%` }} />
        </span>
      ) : null}
    </div>
  )
}

/** The appearance flyout: the same settings as the Appearance page, compact. */
function AppearancePanel({ model, onSet }: { model: MainMenuModel; onSet(patch: { theme?: ThemePreference; layout?: LayoutMode; accent?: AccentChoice }): void }): ReactElement {
  const themes: Array<[ThemePreference, string]> = [
    ['system', t('menus.view.themeSystem')],
    ['light', t('menus.view.themeLight')],
    ['dark', t('menus.view.themeDark')],
  ]
  const layouts: Array<[LayoutMode, string]> = [
    ['sidebar', t('menus.main.layoutSidebar')],
    ['horizontal', t('menus.main.layoutTop')],
  ]
  return (
    <div className="mm-appearance">
      <div className="mm-appearance__label" id="mm-theme">{t('menus.main.theme')}</div>
      <div className="mm-segmented" role="radiogroup" aria-labelledby="mm-theme">
        {themes.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={model.theme === id} className={cx('mm-segment', model.theme === id && 'mm-segment--on')} onClick={() => onSet({ theme: id })}>
            {label}
          </button>
        ))}
      </div>
      <div className="mm-appearance__label" id="mm-accent">{t('menus.main.accent')}</div>
      <div className="mm-swatches" role="radiogroup" aria-labelledby="mm-accent">
        <button type="button" role="radio" aria-checked={model.accent === 'companion'} aria-label={t('menus.main.accentAuto')} title={t('menus.main.accentAuto')} className={cx('mm-swatch', 'mm-swatch--auto', model.accent === 'companion' && 'mm-swatch--on')} onClick={() => onSet({ accent: 'companion' })} />
        {ACCENT_HUES.map((hue) => (
          <button
            key={hue.id}
            type="button"
            role="radio"
            aria-checked={model.accent === hue.id}
            aria-label={hue.label}
            title={hue.label}
            className={cx('mm-swatch', model.accent === hue.id && 'mm-swatch--on')}
            // The swatch shows the hue it picks, the same data the Appearance page draws.
            style={{ '--swatch': hue.color } as CSSProperties}
            onClick={() => onSet({ accent: hue.id })}
          />
        ))}
      </div>
      <div className="mm-appearance__label" id="mm-layout">{t('menus.main.layout')}</div>
      <div className="mm-segmented" role="radiogroup" aria-labelledby="mm-layout">
        {layouts.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={model.layout === id} className={cx('mm-segment', model.layout === id && 'mm-segment--on')} onClick={() => onSet({ layout: id })}>
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** SH-45's zoom row: minus, the percentage (which resets), plus and full screen. */
function ZoomRow({ percent, mac, onRun, onFullScreen }: { percent: number | null; mac: boolean; onRun(id: string): void; onFullScreen(): void }): ReactElement {
  const disabled = percent === null
  return (
    <div className="mm-zoom" role="group" aria-label={t('menus.main.zoom')}>
      <span className="kit-label">{t('menus.main.zoom')}</span>
      <span className="mm-zoom__controls">
        <button type="button" className="mm-zoom__btn" aria-label={t('menus.main.zoomOut')} title={`${t('menus.main.zoomOut')} (${mac ? '⌘−' : 'Ctrl+−'})`} disabled={disabled} onClick={() => onRun('zoom-out')}>
          <Minus aria-hidden="true" />
        </button>
        <button type="button" className="mm-zoom__value" aria-label={t('menus.main.zoomReset', { percent: '100%' })} disabled={disabled} onClick={() => onRun('zoom-reset')}>
          {percent === null ? '–' : `${percent}%`}
        </button>
        <button type="button" className="mm-zoom__btn" aria-label={t('menus.main.zoomIn')} title={`${t('menus.main.zoomIn')} (${mac ? '⌘+' : 'Ctrl++'})`} disabled={disabled} onClick={() => onRun('zoom-in')}>
          <Plus aria-hidden="true" />
        </button>
        <button type="button" className="mm-zoom__btn" aria-label={t('menus.main.fullScreen')} title={t('menus.main.fullScreen')} onClick={onFullScreen}>
          <Maximize2 aria-hidden="true" />
        </button>
      </span>
    </div>
  )
}
