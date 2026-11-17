/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileUp, Palette, Shuffle } from 'lucide-react'
import { COMPANION_FILE_EXTENSION, COMPANION_NAME_MAX, DEFAULT_PROFILE, skillReviewText, type Companion, type CompanionImportPreview, type CompanionPreset } from '@shared/companion'
import { chatUrl, companionLookUrl, presetUrl } from '@shared/url'
import { atelier, call, errorText, formatBytes } from '../api'
import { Companion as CompanionFigure } from '../companion'
import { useCompanionAssets, useCompanions, usePresets } from '../components/companionData'
import { PresetGallery, shuffledLook, useDraftLook } from '../pages/CompanionEditor'
import { PromptDetails, type PromptItem } from '../packs/PromptDetails'
import { PresetDetailSheet } from './PresetDetailSheet'
import { Button, Dialog, IconButton, SegmentedControl, Sheet, toast } from '../ui'
import { effortLabel, modelLabel } from './logic/models'
import { cleanName, uniqueCompanionName } from './logic/names'
import { describeSchedule } from './logic/schedule'
import { SHUFFLE_STYLES, type ShuffleStyle } from './logic/shuffle'
import { ShapeField } from './ShapeField'
import { useT, t } from '../i18n/useT'
import { motionReduced } from '../ui/motion'
import './card.css'

// The new-companion sheet and the import review sheet. Any surface opens
// them with openNewCompanion() or openCompanionImport(); <CompanionSheets/>
// shows them. App mounts the host once, and it is safe to mount more than
// once (only the first one draws). With no host mounted, the first request
// mounts one on its own root, so a sheet can never silently fail to show.

type SheetRequest =
  | { kind: 'create'; onCreated?(companion: Companion): void }
  | { kind: 'import'; preview: CompanionImportPreview; onCreated?(companion: Companion): void }
  | { kind: 'import-error'; message: string }

let current: SheetRequest | null = null
let serial = 0
const listeners = new Set<() => void>()
const hosts: number[] = []
let fallback: Root | null = null

function notify(): void {
  for (const listener of listeners) listener()
}

function show(request: SheetRequest | null): void {
  current = request
  serial++
  notify()
  if (request && hosts.length === 0 && !fallback) {
    const el = document.createElement('div')
    el.dataset.companionSheets = ''
    document.body.appendChild(el)
    fallback = createRoot(el)
    fallback.render(<CompanionSheets />)
  }
}

/** Opens the new-companion sheet. `onCreated` runs after it is added (it is also made active). */
export function openNewCompanion(options: { onCreated?(companion: Companion): void } = {}): void {
  show({ kind: 'create', onCreated: options.onCreated })
}

/** Shows the review sheet for a file the person already chose (or the error for a bad one). */
export function reviewCompanionImport(preview: CompanionImportPreview, options: { onCreated?(companion: Companion): void } = {}): void {
  show({ kind: 'import', preview, onCreated: options.onCreated })
}

/** Asks for a .ateliercompanion file, then shows the review sheet. */
export async function openCompanionImport(options: { onCreated?(companion: Companion): void } = {}): Promise<void> {
  try {
    const preview = await call('companions', 'pickImport')
    if (preview) reviewCompanionImport(preview, options)
  } catch (err) {
    show({ kind: 'import-error', message: errorText(err) })
  }
}

/** Checks a file's text (a drop) and shows the review sheet or the error. */
export async function reviewCompanionText(text: string): Promise<void> {
  try {
    reviewCompanionImport(await call('companions', 'previewImport', text))
  } catch (err) {
    show({ kind: 'import-error', message: errorText(err) })
  }
}

const FILE_MAX_BYTES = 8 * 1024 * 1024
const EXTENSION = `.${COMPANION_FILE_EXTENSION}`

/** The first .ateliercompanion file in a drop, if any. */
export function companionFileIn(data: DataTransfer | null): File | null {
  if (!data) return null
  for (const file of Array.from(data.files)) if (file.name.toLowerCase().endsWith(EXTENSION)) return file
  return null
}

export async function reviewCompanionDrop(file: File): Promise<void> {
  if (file.size > FILE_MAX_BYTES) {
    show({ kind: 'import-error', message: t('coCard.sheets.thisCompanionFileIs') })
    return
  }
  await reviewCompanionText(await file.text())
}

// Files opened by the OS (double-click) arrive as app events, and files
// dropped anywhere on the chrome are caught at the window. Both are set up
// once, when this module first loads.
let installed = false
function installImport(): void {
  if (installed) return
  installed = true
  atelier.onAppEvent((event) => {
    if (event.type === 'companion-import') reviewCompanionImport(event.preview)
    else if (event.type === 'companion-import-error') show({ kind: 'import-error', message: event.message })
  })
  window.addEventListener('dragover', (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return
    // File names are hidden until the drop, so every file drag is accepted
    // here; the drop below ignores anything that isn't a companion file.
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  })
  window.addEventListener('drop', (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return
    // Never let a dropped file navigate the chrome away.
    e.preventDefault()
    const file = companionFileIn(e.dataTransfer)
    if (file) void reviewCompanionDrop(file)
  })
}
installImport()

function useSheetRequest(): { request: SheetRequest | null; serial: number } {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => serial,
  )
  return { request: current, serial: value }
}

let nextHost = 0

/** Draws the create and import sheets. Mount once near the root; extra mounts stay idle. */
export function CompanionSheets(): ReactElement | null {
  const [token] = useState(() => ++nextHost)
  const [primary, setPrimary] = useState(false)
  const { request, serial: key } = useSheetRequest()
  useEffect(() => {
    hosts.push(token)
    const update = (): void => setPrimary(hosts[0] === token)
    update()
    listeners.add(update)
    return () => {
      hosts.splice(hosts.indexOf(token), 1)
      listeners.delete(update)
      notify()
    }
  }, [token])
  if (!primary || !request) return null
  const close = (): void => {
    if (current === request) show(null)
  }
  // Keyed by request so a new one starts fresh.
  if (request.kind === 'create') return <NewCompanionSheet key={key} onClose={close} onCreated={request.onCreated} />
  if (request.kind === 'import') return <ImportReviewSheet key={key} preview={request.preview} onClose={close} onCreated={request.onCreated} />
  return <ImportErrorDialog key={key} message={request.message} onClose={close} />
}

/**
 * DS-79: the celebration in the sheet once a companion is added (created or
 * imported). The sheet stays open on the newcomer: it waves hello while a
 * ring and a few of Atelier's sparkles rise around it, then you start a chat
 * with it or close. Under Reduce Motion it simply stands there, happy.
 */
function WelcomeSheet({ companion, onClose }: { companion: Companion; onClose(): void }): ReactElement {
  const tr = useT()
  const [starting, setStarting] = useState(false)
  const startChat = (): void => {
    setStarting(true)
    call('chats', 'create', { companionId: companion.id })
      .then((draft) => call('pages', 'open', chatUrl(draft.id)))
      .then(onClose, (err: unknown) => {
        setStarting(false)
        toast.show({ message: errorText(err), tone: 'error' })
      })
  }
  const name = companion.name
  return (
    <Sheet
      open
      onClose={onClose}
      dismissible={!starting}
      title={tr('tabs.welcome.title', { name })}
      description={tr('tabs.welcome.body', { name })}
      size="md"
      className="co-sheet"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={starting}>{tr('tabs.welcome.done')}</Button>
          <Button variant="primary" onClick={startChat} loading={starting} data-autofocus>{tr('tabs.welcome.startChat', { name })}</Button>
        </>
      }
    >
      <div className="co-welcome" style={{ '--hero-tint': companion.look.colors.skin, '--welcome-tint': companion.look.colors.accent } as CSSProperties}>
        <ShapeField tint={companion.look.colors.skin} className="co-stage-field" />
        {!motionReduced() && (
          <span className="co-welcome__burst" aria-hidden="true">
            <span className="co-welcome__ring" />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <svg key={i} className="co-welcome__spark" viewBox="-1 -1 2 2" style={{ '--i': i } as CSSProperties}>
                <path d="M0 -1 L0.22 -0.22 L1 0 L0.22 0.22 L0 1 L-0.22 0.22 L-1 0 L-0.22 -0.22 Z" />
              </svg>
            ))}
          </span>
        )}
        <CompanionFigure profile={companion} mood="happy" size={170} greet />
        <p className="ui-sr-only" role="status">{tr('tabs.welcome.title', { name })}</p>
      </div>
    </Sheet>
  )
}

// ---- create ----

function NewCompanionSheet({ onClose, onCreated }: { onClose(): void; onCreated?(companion: Companion): void }) {
  const t = useT()
  const [loaded] = useCompanionAssets()
  const assets = loaded instanceof Error ? null : loaded
  const presets = usePresets()
  const { items } = useCompanions()
  // A companion of your own starts from the default companion's look (the branding's).
  const draft = useDraftLook(DEFAULT_PROFILE.look, assets)
  const [presetId, setPresetId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false)
  const [style, setStyle] = useState<ShuffleStyle>('any')
  const [busy, setBusy] = useState(false)
  const [welcomed, setWelcomed] = useState<Companion | null>(null) // DS-79
  const [error, setError] = useState<string | null>(null)
  const rolled = useRef(false)
  const nameId = useId()

  // The preview starts shuffled once the parts are known.
  useEffect(() => {
    if (!assets || rolled.current) return
    rolled.current = true
    draft.replace(shuffledLook(assets))
  }, [assets])

  const clean = cleanName(name)
  const finalName = clean ? uniqueCompanionName(clean, items.map((c) => c.name)) : ''
  const pickPreset = (preset: CompanionPreset): void => {
    setPresetId(preset.id)
    draft.replace(preset.look)
    if (!named) setName(preset.name)
  }
  const shuffle = (): void => {
    if (!assets) return
    setPresetId(null)
    draft.set(shuffledLook(assets, style))
  }
  /** Adds the companion; `thenLook` opens its card with the look editor (the ring around the figure) instead of the welcome. */
  const create = (thenLook = false): void => {
    if (!clean) return
    setBusy(true)
    setError(null)
    call('companions', 'create', { name: clean, persona: presetId ?? 'custom', look: draft.look }).then(
      (created) => {
        onCreated?.(created)
        if (thenLook) {
          onClose()
          void call('pages', 'open', companionLookUrl(created.id))
          return
        }
        // DS-79: the sheet celebrates the newcomer instead of closing on a toast.
        setWelcomed(created)
      },
      (err: unknown) => {
        setBusy(false)
        setError(errorText(err))
      },
    )
  }

  if (welcomed) return <WelcomeSheet companion={welcomed} onClose={onClose} />
  return (
    <Sheet
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('coCard.sheets.newCompanion')}
      description={t('coCard.sheets.startFromAPreset')}
      size="lg"
      className="co-sheet"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('coCard.sheets.cancel')}</Button>
          <Button variant="primary" onClick={() => create()} loading={busy} disabled={!clean}>{t('coCard.sheets.addCompanion')}</Button>
        </>
      }
    >
      <div className="co-create">
        <div className="co-create__stage" style={{ '--hero-tint': draft.look.colors.skin } as CSSProperties}>
          <ShapeField tint={draft.look.colors.skin} className="co-stage-field" />
          <CompanionFigure profile={{ name: finalName || t('coCard.sheets.newCompanion'), persona: presetId ?? 'custom', look: draft.look, dockIcon: false }} mood="happy" size={170} greet />
          <div className="co-create__shuffle">
            <SegmentedControl<ShuffleStyle> size="sm" label={t('coCard.sheets.shuffleStyle')} options={SHUFFLE_STYLES.map((s) => ({ value: s.id, label: s.label }))} value={style} onChange={setStyle} />
            <IconButton label={t('coCard.sheets.shuffleTheLook')} icon={<Shuffle />} variant="subtle" disabled={!assets} onClick={shuffle} />
          </div>
        </div>
        <div className="co-field">
          <label className="co-field__label" htmlFor={nameId}>{t('coCard.sheets.name')}</label>
          <input
            id={nameId}
            className="co-input"
            value={name}
            maxLength={COMPANION_NAME_MAX}
            placeholder={t('coCard.sheets.forExampleName')}
            data-autofocus
            onChange={(e) => {
              setName(e.target.value)
              setNamed(e.target.value.trim().length > 0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                create()
              }
            }}
          />
          {finalName && finalName !== clean && <p className="co-hint">{t('coCard.sheets.isTakenSoThis', { clean, finalName })}</p>}
        </div>
        {presets.length > 0 && (
          <div className="co-field">
            <span className="co-field__label">{t('coCard.sheets.startFromAPreset2')}</span>
            <PresetGallery presets={presets} selectedId={presetId} onPick={pickPreset} compact label={t('coCard.sheets.presetCompanions')} onDetails={(p) => setDetailId(p.id)} />
            <p className="co-hint">{t('coCard.sheets.aPresetBringsIts')}</p>
            {/* Every preset, as a gallery with a profile each. */}
            <PresetsLink onOpen={onClose} />
            {/* CO-17: the gallery opens the preset's detail sheet */}
            {detailId && <PresetDetailSheet presetId={detailId} onClose={() => setDetailId(null)} onAdded={(c) => onCreated?.(c)} />}
          </div>
        )}
        {/* The look is changed piece by piece on the card, the same ring of bubbles as any companion's. */}
        <div className="co-create__customize">
          <Button variant="secondary" icon={<Palette />} disabled={!clean || busy} onClick={() => create(true)}>
            {t('coCard.sheets.customizeLook')}
          </Button>
          <p className="co-hint">{clean ? t('coCard.sheets.customizeHint', { name: finalName }) : t('coCard.sheets.customizeNameFirst')}</p>
        </div>
        {error && <p className="co-field__error" role="alert">{error}</p>}
      </div>
    </Sheet>
  )
}

// ---- import ----

function ImportReviewSheet({ preview, onClose, onCreated }: { preview: CompanionImportPreview; onClose(): void; onCreated?(companion: Companion): void }) {
  const t = useT()
  const presets = usePresets()
  const [busy, setBusy] = useState(false)
  const [welcomed, setWelcomed] = useState<Companion | null>(null) // DS-79
  const [error, setError] = useState<string | null>(null)
  const personality = presets.find((p) => p.id === preview.persona)
  const add = (): void => {
    setBusy(true)
    setError(null)
    call('companions', 'confirmImport', preview.token).then(
      (created) => {
        setWelcomed(created) // DS-79
        onCreated?.(created)
      },
      (err: unknown) => {
        setBusy(false)
        setError(errorText(err))
      },
    )
  }
  if (welcomed) return <WelcomeSheet companion={welcomed} onClose={onClose} />
  return (
    <Sheet
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('coCard.sheets.addACompanionFrom')}
      description={t('coCard.sheets.checkWhatThisFile')}
      size="lg"
      className="co-sheet"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('coCard.sheets.cancel')}</Button>
          <Button variant="primary" onClick={add} loading={busy} data-autofocus>{t('coCard.sheets.add', { name: preview.name })}</Button>
        </>
      }
    >
      <div className="co-review">
        <div className="co-review__hero" style={{ '--hero-tint': preview.look.colors.skin } as CSSProperties}>
          <ShapeField tint={preview.look.colors.skin} className="co-stage-field" origin={{ x: 0.16, y: 0.8 }} />
          <CompanionFigure profile={{ name: preview.name, persona: preview.persona, look: preview.look, dockIcon: false }} mood="happy" size={150} greet />
          <div>
            <h3 className="co-review__name">{preview.name}</h3>
            <p className="co-hint">{personality ? `${personality.name} personality: ${personality.tagline}` : t('coCard.sheets.noPersonalityPreset')}</p>
            {preview.name !== preview.originalName && <p className="co-hint">{t('coCard.sheets.youAlreadyHaveA', { originalName: preview.originalName, name: preview.name })}</p>}
          </div>
        </div>
        {preview.note && (
          <figure className="co-review__note">
            <figcaption>{t('coCard.sheets.aNoteFromWhoever')}</figcaption>
            <blockquote>{preview.note}</blockquote>
          </figure>
        )}
        <section className="co-review__section">
          <h4>{t('coCard.sheets.standingInstructions')}</h4>
          {preview.instructions ? <p className="co-review__text">{preview.instructions}</p> : <p className="co-hint">{t('coCard.sheets.none')}</p>}
        </section>
        <section className="co-review__section">
          <h4>{t('coCard.sheets.newChats')}</h4>
          <p className="co-hint">
            {preview.model || preview.effort
              ? t('coCard.sheets.startWithModel', { model: preview.model ? modelLabel(preview.model) : t('coCard.sheets.yourDefaultModelLower'), effort: preview.effort ? t('coCard.sheets.atEffortLevel', { effort: effortLabel(preview.effort).toLowerCase() }) : '' })
              : t('coCard.sheets.useYourDefaultModel')}
          </p>
        </section>
        <section className="co-review__section">
          <h4>{t('coCard.sheets.skills', { length: preview.skills.length })}</h4>
          {preview.skills.length === 0 ? <p className="co-hint">{t('coCard.sheets.noSkillsIncluded')}</p> : (
            <>
              <p className="co-hint">{t('coCard.sheets.skillsHint')}</p>
              <PromptDetails items={skillItems(preview.skills)} />
            </>
          )}
        </section>
        <section className="co-review__section">
          <h4>{t('coCard.sheets.routines', { length: preview.routines.length })}</h4>
          {preview.routines.length === 0 ? <p className="co-hint">{t('coCard.sheets.noRoutinesIncluded')}</p> : (
            <>
              <PromptDetails items={preview.routines.map((r, i) => ({ key: `${r.name}-${i}`, summary: `${r.name} · ${describeSchedule(r.schedule)}`, text: r.prompt }))} />
              <p className="co-hint">{t('coCard.sheets.theyReAddedPaused')}</p>
            </>
          )}
        </section>
        <section className="co-review__section">
          <h4>{t('coCard.sheets.memory')}</h4>
          <p className="co-hint">{preview.memoryFiles === 0 ? t('coCard.sheets.noMemoryNotesIncluded') : t('coCard.sheets.memoryNotesShared', { count: preview.memoryFiles })}</p>
        </section>
        {error && <p className="co-field__error" role="alert">{error}</p>}
      </div>
    </Sheet>
  )
}

/** Each skill as the assistant gets it, then its supporting files, each collapsed under its name. */
function skillItems(skills: CompanionImportPreview['skills']): PromptItem[] {
  return skills.flatMap((s, i) => [
    { key: `skill-${i}`, summary: `/${s.name}${s.description ? ` · ${s.description}` : ''}`, text: skillReviewText(s) },
    ...s.files.map((f) => ({ key: `skill-${i}:${f.path}`, summary: `/${s.name} · ${f.path}`, text: f.text ?? t('coCard.sheets.fileTooLong', { size: formatBytes(f.size) }) })),
  ])
}

function ImportErrorDialog({ message, onClose }: { message: string; onClose(): void }) {
  const t = useT()
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('coCard.sheets.thisCompanionCanT')}
      description={message}
      size="sm"
      role="alertdialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('coCard.sheets.close')}</Button>
          <Button
            variant="primary"
            icon={<FileUp />}
            onClick={() => {
              onClose()
              void openCompanionImport()
            }}
          >
            {t('coCard.sheets.chooseAnotherFile')}
          </Button>
        </>
      }
    />
  )
}

/** Opens the preset gallery (atelier://presets) from the new-companion sheet. */
function PresetsLink({ onOpen }: { onOpen(): void }) {
  const tr = useT()
  return (
    <button type="button" className="sp-link" onClick={() => void call('pages', 'open', presetUrl()).then(onOpen)}>
      {tr('galleries.presets.browse')}
    </button>
  )
}
