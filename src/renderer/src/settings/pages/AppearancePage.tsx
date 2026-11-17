/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Appearance (ST-25 to ST-28): theme, your colour and the
// sidebar tint, layout tiles, text size, density and zoom, the bookmarks bar
// and the media rows.
import { useRef, type KeyboardEvent, type ReactElement } from 'react'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { accentTokens } from '@shared/accent'
import type { BookmarksBarMode, LayoutMode } from '@shared/ipc'
import { PROFILE_HUES, profileTokens, type ProfileHue } from '@shared/profile'
import { ACCENT_HUES, packAccentChoice, type AccentChoice, type ThemePreference } from '@shared/theme'
import type { PacksState } from '@shared/packs'
import { call } from '../../api'
import { useEvent, useResource } from '../data'
import { useT, type T } from '../../i18n/useT'
import { Kbd, SegmentedControl, Select, useMediaQuery, type SegmentOption } from '../../ui'
import { rovingIndex } from '../../ui/logic/keys'
import { CHAT_ZOOM_CHOICES, FONT_SIZE, nearestChoice, percent, UI_ZOOM_CHOICES } from '../../ui/logic/appearance'
import { Card, ChoiceTiles, PageHeader, Row, Section, SwitchRow } from '../kit'
import type { SettingsPageProps } from '../pageTypes'
import { ReaderSettings } from '../../reader/ReaderSettings' // reader (RD-05)

function themeOptions(t: T): SegmentOption<ThemePreference>[] {
  return [
    { value: 'system', label: t('settings.appearance.mode.system'), icon: <Monitor aria-hidden /> },
    { value: 'light', label: t('settings.appearance.mode.light'), icon: <Sun aria-hidden /> },
    { value: 'dark', label: t('settings.appearance.mode.dark'), icon: <Moon aria-hidden /> },
  ]
}

/** Apex's own small drawings of the two layouts, from tokens. */
function LayoutArt({ layout }: { layout: LayoutMode }): ReactElement {
  return (
    <span className={`sp-layout-art sp-layout-art--${layout}`}>
      <span className="sp-layout-art__bar" />
      <span className="sp-layout-art__body">
        {layout === 'sidebar' && (
          <span className="sp-layout-art__side">
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="sp-layout-art__page" />
      </span>
    </span>
  )
}

export function AppearancePage({ settings, update, companionName, companionAccent }: SettingsPageProps & { companionName: string; companionAccent: string }): ReactElement {
  const t = useT()
  // Packs (docs/packs.md): accents from the packs that are on.
  const packs = useResource<PacksState>(() => call('packs', 'state'))
  useEvent('packs', (event) => packs.set(event.state))
  const packAccents = (packs.data?.packs ?? []).filter((p) => p.enabled && p.problems.length === 0).flatMap((p) => p.themes.map((th) => ({ id: packAccentChoice(p.id, th.id), label: t('settings.appearance.accent.fromPack', { name: th.name, pack: p.name }), color: th.accent })))
  const reducedTransparency = useMediaQuery('(prefers-reduced-transparency: reduce)')
  const bookmarksOptions: SegmentOption<BookmarksBarMode>[] = [
    { value: 'always', label: t('settings.appearance.bookmarksBar.always') },
    { value: 'newtab', label: t('settings.appearance.bookmarksBar.newtab') },
    { value: 'never', label: t('settings.appearance.bookmarksBar.never') },
  ]
  const keys = (shortcut: string): ReactElement => <Kbd shortcut={shortcut} />
  const withKeys = (text: string, shortcut: string): ReactElement => {
    const [before, after] = text.split('{keys}')
    return (
      <>
        {before}
        {keys(shortcut)}
        {after}
      </>
    )
  }
  const fontSizes = Array.from({ length: FONT_SIZE.max - FONT_SIZE.min + 1 }, (_, i) => String(FONT_SIZE.min + i))
  return (
    <>
      <PageHeader title={t('settings.appearance.title')} description={t('settings.appearance.description')} />
      <Section title={t('settings.appearance.theme')}>
        <Card>
          <Row anchor="theme" title={t('settings.appearance.mode')} description={t('settings.appearance.mode.description')}>
            <SegmentedControl label={t('settings.appearance.mode')} options={themeOptions(t)} value={settings.theme} onChange={(theme) => void update({ theme })} />
          </Row>
          <Row anchor="profile-hue" title={t('settings.appearance.hue')} description={t('settings.appearance.hue.description')} stack>
            <ProfileHuePicker label={t('settings.appearance.hue')} value={settings.profileHue} onChange={(profileHue) => void update({ profileHue })} />
          </Row>
          <SwitchRow
            anchor="sidebar-tint"
            label={t('settings.appearance.tint')}
            description={reducedTransparency ? `${t('settings.appearance.tint.description')} ${t('settings.appearance.tint.reduced')}` : t('settings.appearance.tint.description')}
            checked={settings.sidebarTint}
            onChange={(sidebarTint) => void update({ sidebarTint })}
          />
          {/* DS-75b: the floor of the start surfaces, per profile; every open new tab follows it. */}
          <SwitchRow
            anchor="companion-floor"
            label={t('settings.appearance.companionFloor')}
            description={t('settings.appearance.companionFloor.description')}
            checked={settings.companionFloor}
            onChange={(companionFloor) => void update({ companionFloor })}
          />
          <Row anchor="accent" title={t('settings.appearance.accent')} description={t('settings.appearance.accent.description')} stack>
            <AccentPicker
              label={t('settings.appearance.accent')}
              value={settings.accent}
              onChange={(accent) => void update({ accent })}
              followLabel={t('settings.appearance.accent.follow', { name: companionName })}
              companionAccent={companionAccent}
              extra={packAccents}
            />
          </Row>
        </Card>
      </Section>
      <Section title={t('settings.appearance.layout')}>
        <Card>
          <Row anchor="layout" title={t('settings.appearance.layout')} description={withKeys(t('settings.appearance.layout.description'), 'CmdOrCtrl+Shift+S')} stack>
            <ChoiceTiles
              label={t('settings.appearance.layout')}
              value={settings.layout}
              onChange={(layout) => void update({ layout })}
              options={[
                { value: 'sidebar', title: t('settings.appearance.layout.sidebar'), description: t('settings.appearance.layout.sidebar.description'), art: <LayoutArt layout="sidebar" /> },
                { value: 'horizontal', title: t('settings.appearance.layout.top'), description: t('settings.appearance.layout.top.description'), art: <LayoutArt layout="horizontal" /> },
              ]}
            />
          </Row>
        </Card>
      </Section>
      <Section title={t('settings.appearance.text')}>
        <Card>
          <Row anchor="font-size" title={t('settings.appearance.fontSize')} description={t('settings.appearance.fontSize.description')} htmlFor="settings-font-size">
            <Select
              id="settings-font-size"
              size="sm"
              value={String(settings.fontSize)}
              options={fontSizes.map((s) => ({ value: s, label: t('settings.appearance.fontSize.value', { size: s }) }))}
              onChange={(s) => void update({ fontSize: Number(s) })}
            />
          </Row>
          <Row anchor="density" title={t('settings.appearance.density')} description={t('settings.appearance.density.description')}>
            <SegmentedControl
              label={t('settings.appearance.density')}
              size="sm"
              options={[
                { value: 'comfortable', label: t('settings.appearance.density.comfortable') },
                { value: 'compact', label: t('settings.appearance.density.compact') },
              ]}
              value={settings.density}
              onChange={(density) => void update({ density })}
            />
          </Row>
          <Row anchor="interface-zoom" title={t('settings.appearance.uiZoom')} description={withKeys(t('settings.appearance.uiZoom.description'), 'CmdOrCtrl+Plus')} htmlFor="settings-ui-zoom">
            <Select
              id="settings-ui-zoom"
              size="sm"
              value={String(nearestChoice(settings.uiZoom, UI_ZOOM_CHOICES))}
              options={UI_ZOOM_CHOICES.map((z) => ({ value: String(z), label: percent(z) }))}
              onChange={(z) => void update({ uiZoom: Number(z) })}
            />
          </Row>
          <Row anchor="chat-zoom" title={t('settings.appearance.chatZoom')} description={t('settings.appearance.chatZoom.description')} htmlFor="settings-chat-zoom">
            <Select
              id="settings-chat-zoom"
              size="sm"
              value={String(nearestChoice(settings.chatZoom, CHAT_ZOOM_CHOICES))}
              options={CHAT_ZOOM_CHOICES.map((z) => ({ value: String(z), label: percent(z) }))}
              onChange={(z) => void update({ chatZoom: Number(z) })}
            />
          </Row>
        </Card>
      </Section>
      {/* RD-05: the reader's typeface, size, width, colours and read-aloud voice. */}
      <ReaderSettings settings={settings} update={update} />
      <Section title={t('settings.appearance.window')}>
        <Card>
          <Row anchor="bookmarks-bar" title={t('settings.appearance.bookmarksBar')} description={withKeys(t('settings.appearance.bookmarksBar.description'), 'CmdOrCtrl+Shift+B')}>
            <SegmentedControl label={t('settings.appearance.bookmarksBar')} size="sm" options={bookmarksOptions} value={settings.bookmarksBar} onChange={(bookmarksBar) => void update({ bookmarksBar })} />
          </Row>
          <SwitchRow
            anchor="full-urls"
            label={t('settings.appearance.fullUrls')}
            description={t('settings.appearance.fullUrls.description')}
            checked={settings.showFullUrls}
            onChange={(showFullUrls) => void update({ showFullUrls })}
          />
        </Card>
      </Section>
      <Section title={t('settings.appearance.media')}>
        <Card>
          <SwitchRow
            anchor="picture-in-picture"
            label={t('settings.appearance.pip')}
            description={t('settings.appearance.pip.description')}
            checked={settings.autoPictureInPicture}
            onChange={(autoPictureInPicture) => void update({ autoPictureInPicture })}
          />
          <SwitchRow
            anchor="media-card"
            label={t('settings.appearance.mediaCard')}
            description={t('settings.appearance.mediaCard.description')}
            checked={settings.mediaCard}
            onChange={(mediaCard) => void update({ mediaCard })}
          />
          {/* MD-01: the toolbar's now-playing button. */}
          <SwitchRow
            anchor="now-playing"
            label={t('media.settings.button')}
            description={t('media.settings.button.description')}
            checked={settings.nowPlayingButton}
            onChange={(nowPlayingButton) => void update({ nowPlayingButton })}
          />
        </Card>
      </Section>
      <Section title={t('settings.appearance.motion')}>
        <Card>
          <SwitchRow
            anchor="reduce-motion"
            label={t('settings.appearance.reduceMotion')}
            description={t('settings.appearance.reduceMotion.description')}
            checked={settings.reduceMotion}
            onChange={(reduceMotion) => void update({ reduceMotion })}
          />
        </Card>
      </Section>
    </>
  )
}

function swatchStyle(color: string): Record<string, string> {
  const light = accentTokens(color, 'light')
  const dark = accentTokens(color, 'dark')
  return { '--swatch-light': light.accent, '--swatch-dark': dark.accent, '--swatch-on-light': light.text, '--swatch-on-dark': dark.text }
}

/** A radio group of colour swatches; arrows move and select, like any radio group. */
function AccentPicker({ label, value, onChange, followLabel, companionAccent, extra = [] }: { label: string; value: AccentChoice; onChange(value: AccentChoice): void; followLabel: string; companionAccent: string; extra?: Array<{ id: AccentChoice; label: string; color: string }> }): ReactElement {
  const choices: Array<{ id: AccentChoice; label: string; color: string }> = [
    { id: 'companion', label: followLabel, color: companionAccent },
    ...ACCENT_HUES.map((h) => ({ id: h.id, label: h.label, color: h.color })),
    ...extra,
  ]
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const selected = Math.max(0, choices.findIndex((c) => c.id === value))
  const onKeyDown = (e: KeyboardEvent, index: number): void => {
    const next = rovingIndex(e.key, index, choices.length, { orientation: 'both' })
    const target = next === null ? undefined : choices[next]
    if (next === null || !target) return
    e.preventDefault()
    refs.current[next]?.focus()
    onChange(target.id)
  }
  return (
    <div className="sp-swatches" role="radiogroup" aria-label={label}>
      {choices.map((choice, i) => (
        <button
          key={choice.id}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={i === selected}
          aria-label={choice.label}
          title={choice.label}
          tabIndex={i === selected ? 0 : -1}
          className={choice.id === 'companion' ? 'sp-swatch sp-swatch--companion' : 'sp-swatch'}
          style={swatchStyle(choice.color)}
          onClick={() => onChange(choice.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {choice.id === 'companion' ? (
            <>
              <span className="sp-swatch__dot" aria-hidden />
              {choice.label}
            </>
          ) : (
            i === selected && <Check aria-hidden />
          )}
        </button>
      ))}
    </div>
  )
}

function hueStyle(hue: ProfileHue): Record<string, string> {
  const light = profileTokens(hue, 'light')
  const dark = profileTokens(hue, 'dark')
  return { '--swatch-light': light.hue, '--swatch-dark': dark.hue, '--swatch-on-light': '#ffffff', '--swatch-on-dark': '#ffffff' }
}

/** Apex's profile hues, as a radio group of swatches. */
function ProfileHuePicker({ label, value, onChange }: { label: string; value: ProfileHue; onChange(value: ProfileHue): void }): ReactElement {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const selected = Math.max(0, PROFILE_HUES.findIndex((h) => h.id === value))
  const onKeyDown = (e: KeyboardEvent, index: number): void => {
    const next = rovingIndex(e.key, index, PROFILE_HUES.length, { orientation: 'both' })
    const target = next === null ? undefined : PROFILE_HUES[next]
    if (next === null || !target) return
    e.preventDefault()
    refs.current[next]?.focus()
    onChange(target.id)
  }
  return (
    <div className="sp-swatches" role="radiogroup" aria-label={label}>
      {PROFILE_HUES.map((hue, i) => (
        <button
          key={hue.id}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={i === selected}
          aria-label={hue.label}
          title={hue.label}
          tabIndex={i === selected ? 0 : -1}
          className="sp-swatch"
          style={hueStyle(hue.id)}
          onClick={() => onChange(hue.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {i === selected && <Check aria-hidden />}
        </button>
      ))}
    </div>
  )
}
