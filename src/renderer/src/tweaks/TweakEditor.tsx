/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useState, type ReactElement } from 'react'
import { Download, EyeOff, MousePointerClick, Trash2 } from 'lucide-react'
import { ACCENT_HUES } from '@shared/theme'
import { TWEAK_FONTS, TWEAK_LIMITS, sanitizeCss, type Tweak, type TweakColor, type TweakFont, type TweakPatch, type TweakStyle } from '@shared/tweaks'
import { call, errorText } from '../api'
import { t } from '../i18n/useT'
import { Notice, TextArea } from '../settings/kit'
import { Button, Select, Switch, useConfirm, useToast } from '../ui'
import { FONT_KEYS, colorName } from './logic'
import { Swatches, type SwatchOption } from './Swatches'
import { Package } from 'lucide-react'
import { shareAsPack } from '../packs/share'

// One tweak, edited in place on atelier://tweaks (TWK-03 to TWK-06): what it
// hides, its style, custom CSS and (with Allow custom scripts on) its script,
// where it runs, export and delete. Style and switches save as they change;
// CSS and the script save with their buttons.

export interface TweakEditorProps {
  tweak: Tweak
  scriptsAllowed: boolean
  /** After a delete, so the page can offer Undo. */
  onDeleted(tweak: Tweak): void
}

const NONE = 'none'
const CUSTOM = 'custom'

export function TweakEditor({ tweak, scriptsAllowed, onDeleted }: TweakEditorProps): ReactElement {
  const id = useId()
  const toast = useToast()
  const confirm = useConfirm()
  const [css, setCss] = useState(tweak.css)
  const [js, setJs] = useState(tweak.js)
  const [saved, setSaved] = useState<'css' | 'js' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // A save here or in another window: the drafts follow what is stored.
  useEffect(() => setCss(tweak.css), [tweak.id, tweak.css])
  useEffect(() => setJs(tweak.js), [tweak.id, tweak.js])
  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setSaved(null), 2000)
    return () => clearTimeout(timer)
  }, [saved])

  const run = async (what: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(what)
    try {
      await action()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }
  const update = (patch: TweakPatch): Promise<void> => run('update', () => call('tweaks', 'update', tweak.id, patch))
  const setStyle = (style: Partial<TweakStyle>): Promise<void> => update({ style })

  const removedCss = sanitizeCss(css).removed
  const fontOptions = TWEAK_FONTS.map((f) => ({ value: f, label: t(FONT_KEYS[f]) }))
  const tints: SwatchOption[] = [{ id: NONE, label: t('tweaks.style.tintNone') }, ...ACCENT_HUES.map((h) => ({ id: h.id, label: colorName(h.id), color: h.color }))]
  const presetAccent = ACCENT_HUES.find((h) => h.color.toLowerCase() === tweak.style.accent?.toLowerCase())
  const accents: SwatchOption[] = [
    { id: NONE, label: t('tweaks.style.accentNone') },
    ...ACCENT_HUES.map((h) => ({ id: h.id, label: colorName(h.id), color: h.color })),
    ...(tweak.style.accent && !presetAccent ? [{ id: CUSTOM, label: t('tweaks.style.accentCustom'), color: tweak.style.accent }] : []),
  ]
  const accentValue = !tweak.style.accent ? NONE : (presetAccent?.id ?? CUSTOM)

  const deleteTweak = async (): Promise<void> => {
    const ok = await confirm({ title: t('tweaks.editor.deleteTitle', { host: tweak.host }), message: t('tweaks.editor.deleteBody'), confirmLabel: t('tweaks.editor.deleteConfirm'), destructive: true })
    if (!ok) return
    await run('delete', async () => {
      await call('tweaks', 'remove', tweak.id)
      onDeleted(tweak)
    })
  }
  const showAll = async (): Promise<void> => {
    const ok = await confirm({ title: t('tweaks.hidden.showAllTitle'), message: t('tweaks.hidden.showAllBody', { host: tweak.host }), confirmLabel: t('tweaks.hidden.showAllConfirm') })
    if (ok) await run('clear', () => call('tweaks', 'clearHidden', tweak.id))
  }

  return (
    <div className="twk-editor" role="region" aria-label={t('tweaks.editor.label', { host: tweak.host })}>
      <section className="twk-block" aria-labelledby={`${id}-hidden`}>
        <div className="twk-block__head">
          <h3 id={`${id}-hidden`} className="twk-block__title">
            {t('tweaks.hidden.title')}
          </h3>
          <div className="twk-actions">
            <Button size="sm" variant="secondary" icon={<MousePointerClick />} onClick={() => void run('pick', () => call('tweaks', 'openAndHide', tweak.id))}>
              {t('tweaks.hidden.pick')}
            </Button>
            {tweak.hidden.length > 0 && (
              <Button size="sm" variant="ghost" loading={busy === 'clear'} onClick={() => void showAll()}>
                {t('tweaks.hidden.showAll')}
              </Button>
            )}
          </div>
        </div>
        {tweak.hidden.length === 0 ? (
          <p className="twk-muted">{t('tweaks.hidden.empty')}</p>
        ) : (
          <ul className="twk-hides">
            {tweak.hidden.map((el) => (
              <li key={el.id} className="twk-hide">
                <EyeOff size={14} aria-hidden className="twk-faint" />
                <div className="twk-hide__text">
                  <span className="twk-hide__label">{el.label || el.selector}</span>
                  <code className="twk-hide__selector">{el.selector}</code>
                </div>
                <Button size="sm" variant="ghost" aria-label={t('tweaks.hidden.removeLabel', { label: el.label || el.selector })} onClick={() => void run('unhide', () => call('tweaks', 'removeHidden', tweak.id, el.id))}>
                  {t('tweaks.hidden.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="twk-block" aria-labelledby={`${id}-style`}>
        <h3 id={`${id}-style`} className="twk-block__title">
          {t('tweaks.style.title')}
        </h3>
        <div className="twk-field">
          <label className="twk-field__label" htmlFor={`${id}-font`}>
            {t('tweaks.style.font')}
          </label>
          <Select<TweakFont> id={`${id}-font`} size="sm" value={tweak.style.font} options={fontOptions} onChange={(font) => void setStyle({ font })} />
        </div>
        <div className="twk-field twk-field--stack">
          <span className="twk-field__label">{t('tweaks.style.tint')}</span>
          <Swatches label={t('tweaks.style.tint')} value={tweak.style.tint ?? NONE} options={tints} onChange={(v) => void setStyle({ tint: v === NONE ? null : (v as TweakColor) })} />
        </div>
        <div className="twk-field twk-field--stack">
          <span className="twk-field__label">{t('tweaks.style.accent')}</span>
          <div className="twk-accent">
            <Swatches
              label={t('tweaks.style.accent')}
              value={accentValue}
              options={accents}
              onChange={(v) => {
                if (v === CUSTOM) return
                void setStyle({ accent: v === NONE ? null : (ACCENT_HUES.find((h) => h.id === v)?.color ?? null) })
              }}
            />
            <input
              type="color"
              className="twk-color"
              aria-label={t('tweaks.style.accentCustom')}
              title={t('tweaks.style.accentCustom')}
              value={tweak.style.accent ?? ACCENT_HUES[0].color}
              onChange={(e) => void setStyle({ accent: e.target.value.toLowerCase() })}
            />
          </div>
        </div>
        <Switch size="sm" label={t('tweaks.style.focus')} description={t('tweaks.style.focusBody')} checked={tweak.style.focus} onChange={(focus) => void setStyle({ focus })} />
      </section>

      <section className="twk-block" aria-labelledby={`${id}-css`}>
        <h3 id={`${id}-css`} className="twk-block__title">
          {t('tweaks.css.title')}
        </h3>
        <TextArea
          code
          rows={7}
          spellCheck={false}
          maxLength={TWEAK_LIMITS.css}
          aria-label={t('tweaks.css.label', { host: tweak.host })}
          aria-describedby={`${id}-css-hint`}
          value={css}
          onChange={(e) => setCss(e.target.value)}
        />
        <p className="twk-muted twk-small" id={`${id}-css-hint`}>
          {t('tweaks.css.hint')}
        </p>
        {removedCss > 0 && <Notice tone="warning">{t('tweaks.css.removed', { count: removedCss })}</Notice>}
        <div className="twk-actions">
          <Button
            size="sm"
            variant="primary"
            disabled={css === tweak.css}
            loading={busy === 'css'}
            onClick={() =>
              void run('css', async () => {
                await call('tweaks', 'update', tweak.id, { css })
                setSaved('css')
              })
            }
          >
            {t('tweaks.css.save')}
          </Button>
          {saved === 'css' && (
            <span className="twk-muted twk-small" role="status">
              {t('tweaks.css.saved')}
            </span>
          )}
        </div>
      </section>

      {scriptsAllowed ? (
        <section className="twk-block" aria-labelledby={`${id}-js`}>
          <h3 id={`${id}-js`} className="twk-block__title">
            {t('tweaks.js.title')}
          </h3>
          <Notice tone="warning">{t('tweaks.scripts.warning')}</Notice>
          <Switch size="sm" label={t('tweaks.js.run')} description={t('tweaks.js.runBody')} checked={tweak.jsEnabled} onChange={(jsEnabled) => void update({ jsEnabled })} />
          <TextArea
            code
            rows={7}
            spellCheck={false}
            maxLength={TWEAK_LIMITS.js}
            aria-label={t('tweaks.js.label', { host: tweak.host })}
            aria-describedby={`${id}-js-hint`}
            value={js}
            onChange={(e) => setJs(e.target.value)}
          />
          <p className="twk-muted twk-small" id={`${id}-js-hint`}>
            {t('tweaks.js.reload')}
          </p>
          <div className="twk-actions">
            <Button
              size="sm"
              variant="primary"
              disabled={js === tweak.js}
              loading={busy === 'js'}
              onClick={() =>
                void run('js', async () => {
                  await call('tweaks', 'update', tweak.id, { js })
                  setSaved('js')
                })
              }
            >
              {t('tweaks.js.save')}
            </Button>
            {saved === 'js' && (
              <span className="twk-muted twk-small" role="status">
                {t('tweaks.css.saved')}
              </span>
            )}
          </div>
        </section>
      ) : (
        tweak.js.trim() && <p className="twk-muted twk-small">{t('tweaks.js.hidden')}</p>
      )}

      <section className="twk-block" aria-labelledby={`${id}-where`}>
        <h3 id={`${id}-where`} className="twk-block__title">
          {t('tweaks.options.title')}
        </h3>
        <Switch size="sm" label={t('tweaks.options.enabled')} description={t('tweaks.options.enabledBody')} checked={tweak.enabled} onChange={(enabled) => void update({ enabled })} />
        <Switch size="sm" label={t('tweaks.options.subdomains')} description={t('tweaks.options.subdomainsBody', { host: tweak.host })} checked={tweak.subdomains} onChange={(subdomains) => void update({ subdomains })} />
      </section>

      <div className="twk-editor__foot">
        <div className="twk-actions">
          <Button size="sm" variant="ghost" icon={<Download />} onClick={() => void run('export', () => call('tweaks', 'exportFile', [tweak.id]))}>
            {t('tweaks.editor.export')}
          </Button>
          <Button size="sm" variant="ghost" icon={<Package />} onClick={() => void shareAsPack('tweak', tweak.id)}>
            {t('packs.share.action')}
          </Button>
        </div>
        <Button size="sm" variant="danger" icon={<Trash2 />} loading={busy === 'delete'} onClick={() => void deleteTweak()}>
          {t('tweaks.editor.delete')}
        </Button>
      </div>
    </div>
  )
}
