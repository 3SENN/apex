/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Transcription (ST-17 to ST-21): the one-time
// meeting setup checklist, what a meeting recording is (transcribed with
// notes, or audio only), the microphone and languages, custom vocabulary,
// what happens after a meeting, the alerts, keeping audio, and the capture
// levels with a microphone test. Every control works from the speech kit.
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { RotateCcw } from 'lucide-react'
import { DESKTOP_CALL_APPS, DESKTOP_CALL_APP_IDS } from '@shared/desktopCalls'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { VOCABULARY_MAX, VOCABULARY_TERMS_MAX, VOCABULARY_TERM_MAX, permissionsComplete, type PermissionKind, type SpeechPermissions, type TranscriptionSettings } from '@shared/speech'
import { apex, call } from '../../api'
import { t } from '../../i18n/useT'
import { Button, SaveStatus, SkeletonRows, toast, useAutosave } from '../../ui'
import {
  LanguageSelect,
  MicSelect,
  MicTest,
  PermissionChecklist,
  SensitivitySlider,
  SpeechNotice,
  errorCopy,
  useMicDevices,
  useScreenAccess,
  useSpeechAssets,
  useSpeechLocales,
  useSpeechPermissions,
  useSpeechSession,
  useSpeechStatus,
  type SpeechAssetsState,
} from '../../speech'
import { effectiveLocale, localePrivacy, micMissing, modelNotice, showChecklist, vocabularyStats } from '../../speech/logic'
import { useEvent, useResource } from '../data'
import { Card, ChoiceTiles, Notice, PageHeader, PageSkeleton, Row, Section, SwitchRow, TextArea } from '../kit'
import { LidPauseRow } from '../../native/LidPauseRow'
import { PermissionsLink } from '../permissions/PermissionsLink'

interface TranscriptionPageProps {
  settings: SettingsView
  update(patch: SettingsPatch): Promise<void> | void
}

const MIC_ID = 'transcription-mic'
const LOCALE_ID = 'transcription-locale'
const VOCABULARY_ID = 'transcription-vocabulary'

/** Moves focus to a control by id, or to the first focusable thing inside it (the notices' "choose" actions). */
function focusControl(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  const target = el.matches('button, select, input, textarea, [tabindex]') ? el : el.querySelector<HTMLElement>('button, select, input, textarea, [tabindex]')
  target?.focus()
  target?.scrollIntoView({ block: 'center' })
}

export function TranscriptionPage({ settings, update }: TranscriptionPageProps): ReactElement {
  const tr = settings.transcription
  const [saveError, setSaveError] = useState<string | null>(null)
  const set = useCallback(
    (patch: Partial<TranscriptionSettings>): Promise<void> =>
      Promise.resolve(update({ transcription: patch })).catch((err: unknown) => {
        setSaveError(err instanceof Error ? err.message : String(err))
        throw err
      }),
    [update],
  )

  const status = useSpeechStatus()
  const available = status.data?.available ?? false
  // Rechecks every few seconds only while something is still missing (ST-17).
  const [complete, setComplete] = useState(false)
  const permissions = useSpeechPermissions({ poll: !complete, enabled: available })
  useEffect(() => setComplete(permissions.data ? permissionsComplete(permissions.data) : false), [permissions.data])
  const devices = useMicDevices(available)
  const locales = useSpeechLocales(available)
  // B:transcription engine: the language's on-device model (macOS 26); once it is in, the language counts as on this Mac.
  const assets = useSpeechAssets(tr.locale, available)
  useEvent('speech-assets', (e) => {
    if (e.assets.state === 'installed') void locales.reload()
  })
  const calendar = useResource(() => call('transcription', 'calendarAvailable'))
  // Calls in desktop apps need macOS 14.4's per-app microphone report.
  const desktopCalls = useResource(() => call('transcription', 'desktopCalls'))
  const desktopSupported = desktopCalls.data?.supported !== false
  // The calendar row lights up as soon as Calendar access is on (and off again when it goes).
  useEvent('calendar', () => void calendar.reload())
  const test = useSpeechSession({ purpose: 'level-test' })
  // Whether Apex has asked for Screen Recording: main remembers it (macOS only says on or off).
  const screen = useScreenAccess(available)
  const screenAsked = screen.data !== null && screen.data !== 'not-determined'
  const request = useCallback(
    async (kind: PermissionKind): Promise<SpeechPermissions | null> => {
      const next = await permissions.request(kind)
      if (kind === 'screen') void screen.reload()
      return next
    },
    [permissions.request, screen.reload],
  )

  // Coming back from System Settings: look again straight away, not at the next poll.
  useEffect(() => {
    const onFocus = (): void => {
      if (available) void permissions.reload()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [available, permissions.reload])

  if (status.loading && !status.data) {
    return <PageSkeleton label={t('speech.loading')} rows={5} />
  }

  const p = permissions.data
  const checklist = available && showChecklist(p, tr.setupDismissed)
  const screenLater = available && !checklist && p !== null && p.screen !== 'granted' && tr.setupDismissed
  const locale = locales.data ? effectiveLocale(tr.locale, locales.data) : null
  const privacy = localePrivacy(locale)
  const unplugged = available && devices.data !== null && micMissing(devices.data, tr.mic)
  // Without Speech Recognition, meetings are recorded as audio only (the checklist above has the switch).
  const speechOff = available && p !== null && (p.speech === 'denied' || p.speech === 'restricted')

  async function allowScreen(): Promise<void> {
    // Screen Recording prompts only once; after that only System Settings can turn it on.
    if (screenAsked) permissions.openSettings('screen')
    else await request('screen')
  }

  async function reset(): Promise<void> {
    try {
      await call('transcription', 'resetCapture')
      toast.show({ message: t('speech.levels.resetDone') })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="sk-page">
      <PageHeader title={t('speech.settings.title')} description={t('speech.settings.description')} />
      {saveError && (
        <Notice tone="error" onDismiss={() => setSaveError(null)}>
          {saveError}
        </Notice>
      )}
      {status.data && !status.data.available && status.data.reason && <SpeechNotice copy={errorCopy(status.data.reason)} onRetry={() => void status.reload()} />}
      {status.error && !status.data && (
        <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={() => void status.reload()}>{t('speech.retry')}</Button>}>
          {t('speech.loadFailed')}
        </Notice>
      )}

      {/* ST-17: shown until every permission is granted (or skipped with the essential two done). */}
      {available && permissions.loading && !p && (
        <Section title={t('speech.setup.title')}>
          <Card>
            <SkeletonRows rows={3} label={t('speech.loading')} />
          </Card>
        </Section>
      )}
      {available && permissions.error && !p && (
        <Section title={t('speech.setup.title')}>
          <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={() => void permissions.reload()}>{t('speech.retry')}</Button>}>
            {t('speech.loadFailed')}
          </Notice>
        </Section>
      )}
      {checklist && p && (
        <Section title={t('speech.setup.title')}>
          <div data-settings-anchor="transcription-setup">
            <Card className="sk-page__checklist">
              <PermissionChecklist
                permissions={p}
                requesting={permissions.requesting}
                request={request}
                openSettings={permissions.openSettings}
                screenAsked={screenAsked}
                onSkipScreen={() => void set({ setupDismissed: true }).catch(() => undefined)}
              />
            </Card>
            {permissions.requestError && <SpeechNotice copy={permissions.requestError} />}
          </div>
        </Section>
      )}

      {screenLater && (
        <Section title={t('speech.setup.title')}>
          <Card>
            <Row anchor="transcription-setup" title={t('speech.permission.screen')} description={t('speech.setup.screenLater')}>
              <Button size="sm" variant="secondary" loading={permissions.requesting === 'screen'} onClick={() => void allowScreen()}>
                {t('speech.setup.allowScreen')}
              </Button>
            </Row>
          </Card>
        </Section>
      )}

      <Section title={t('speech.mode.title')}>
        <Card>
          <Row anchor="transcription-mode" title={t('speech.mode.label')} stack>
            <ChoiceTiles
              label={t('speech.mode.label')}
              value={tr.recordOnly ? 'record' : 'transcribe'}
              onChange={(mode) => void set({ recordOnly: mode === 'record' }).catch(() => undefined)}
              options={[
                { value: 'transcribe', title: t('speech.mode.transcribe'), description: t('speech.mode.transcribeDescription'), art: <MeetingModeArt mode="transcribe" /> },
                { value: 'record', title: t('speech.mode.record'), description: t('speech.mode.recordDescription'), art: <MeetingModeArt mode="record" /> },
              ]}
            />
          </Row>
          {speechOff && !tr.recordOnly && (
            <div className="sk-page__inset">
              <Notice>{t('speech.mode.speechOff')}</Notice>
            </div>
          )}
        </Card>
      </Section>

      {/* ST-18 */}
      <Section title={t('speech.input.title')} note={t('speech.locale.serverNote')} actions={<PermissionsLink />}>
        <Card>
          <Row anchor="transcription-mic" title={t('speech.mic.title')} description={t('speech.mic.description')} htmlFor={MIC_ID}>
            {devices.error && !devices.data ? (
              <Button size="sm" variant="secondary" onClick={() => void devices.reload()}>
                {t('speech.retry')}
              </Button>
            ) : (
              <MicSelect
                id={MIC_ID}
                value={tr.mic}
                devices={devices.data ?? []}
                onChange={(mic) => void set({ mic }).catch(() => undefined)}
                onRefresh={() => void devices.refresh()}
                refreshing={devices.refreshing || (devices.loading && !devices.data)}
                disabled={!available}
              />
            )}
          </Row>
          {unplugged && (
            <div className="sk-page__inset">
              <Notice tone="warning">{t('speech.mic.fallback')}</Notice>
            </div>
          )}
          {devices.error && !devices.data && available && (
            <div className="sk-page__inset">
              <Notice tone="error">{t('speech.loadFailed')}</Notice>
            </div>
          )}
          <Row
            anchor="transcription-language"
            title={t('speech.locale.title')}
            description={
              <>
                {t('speech.locale.description')}
                {privacy && locale && (
                  <span className={`sk-page__privacy sk-page__privacy--${privacy}`} data-testid="transcription-privacy">
                    {privacy === 'server' ? t('speech.locale.serverChosen', { name: locale.name }) : t('speech.locale.onDeviceChosen', { name: locale.name })}
                  </span>
                )}
              </>
            }
            htmlFor={LOCALE_ID}
          >
            {locales.error && !locales.data ? (
              <Button size="sm" variant="secondary" onClick={() => void locales.reload()}>
                {t('speech.retry')}
              </Button>
            ) : (
              <LanguageSelect
                  id={LOCALE_ID}
                  kind="primary"
                  label={t('speech.locale.title')}
                  value={tr.locale}
                  list={locales.data ?? { system: '', items: [] }}
                  onChange={(value) => void set({ locale: value }).catch(() => undefined)}
                  disabled={!available || !locales.data}
                />
            )}
          </Row>
          {available && <ModelStatus state={assets} name={locale?.name ?? null} />}
          {/* Bilingual meetings: only the macOS helper listens in two languages (the broker asks for one elsewhere). */}
          {apex.platform === 'darwin' && (
            <Row title={t('speech.locale.secondary')} description={t('speech.locale.secondaryDescription')} htmlFor="transcription-locale-2">
              <LanguageSelect
                  id="transcription-locale-2"
                  kind="secondary"
                  primary={locale?.id ?? null}
                  label={t('speech.locale.secondary')}
                  value={tr.secondaryLocale}
                  list={locales.data ?? { system: '', items: [] }}
                  onChange={(value) => void set({ secondaryLocale: value }).catch(() => undefined)}
                  disabled={!available || !locales.data}
                />
            </Row>
          )}
        </Card>
      </Section>

      {/* ST-19 */}
      <Section title={t('speech.vocabulary.title')} labelledBy={`${VOCABULARY_ID}-title`}>
        <Card>
          <div className="sk-page__inset" data-settings-anchor="transcription-vocabulary">
            <VocabularyField value={tr.vocabulary} save={(vocabulary) => set({ vocabulary })} />
          </div>
        </Card>
      </Section>

      {/* ST-20 */}
      <Section title={t('speech.after.title')}>
        <Card>
          <SwitchRow
            anchor="transcription-summary"
            label={t('speech.after.summarize')}
            description={t('speech.after.summarizeDescription')}
            checked={tr.autoSummarize}
            onChange={(autoSummarize) => void set({ autoSummarize }).catch(() => undefined)}
          />
        </Card>
      </Section>
      <Section title={t('speech.alerts.title')}>
        <Card>
          <SwitchRow
            anchor="transcription-alerts"
            label={t('speech.alerts.calendar')}
            description={calendar.data ? t('speech.alerts.calendarDescription') : t('speech.alerts.calendarMissing')}
            // Off and disabled until a calendar source exists (the platform feature supplies it).
            checked={calendar.data === true && tr.alertCalendar}
            disabled={calendar.data !== true}
            onChange={(alertCalendar) => void set({ alertCalendar }).catch(() => undefined)}
          />
          <SwitchRow
            label={t('speech.alerts.sites')}
            description={t('speech.alerts.sitesDescription')}
            checked={tr.alertMeetingSites}
            onChange={(alertMeetingSites) => void set({ alertMeetingSites }).catch(() => undefined)}
          />
          <SwitchRow
            anchor="transcription-desktop-calls"
            label={t('speech.alerts.desktop')}
            description={desktopSupported ? t('speech.alerts.desktopDescription') : t('speech.alerts.desktopUnsupported')}
            checked={desktopSupported && tr.alertDesktopCalls}
            disabled={!desktopSupported}
            onChange={(alertDesktopCalls) => void set({ alertDesktopCalls }).catch(() => undefined)}
          />
          {desktopSupported &&
            tr.alertDesktopCalls &&
            DESKTOP_CALL_APP_IDS.map((id) => (
              <SwitchRow
                key={id}
                size="sm"
                label={id === 'meet-app' ? t('speech.alerts.meetApp') : DESKTOP_CALL_APPS[id].name}
                checked={!tr.desktopCallsMuted.includes(id)}
                onChange={(on) =>
                  void set({ desktopCallsMuted: on ? tr.desktopCallsMuted.filter((app) => app !== id) : [...tr.desktopCallsMuted, id] }).catch(() => undefined)
                }
              />
            ))}
        </Card>
      </Section>

      <Section title={t('speech.record.title')}>
        <Card>
          <SwitchRow
            anchor="transcription-record"
            label={t('speech.record.keep')}
            description={tr.recordOnly ? t('speech.record.keepAlways') : t('speech.record.keepDescription')}
            checked={tr.recordAudio || tr.recordOnly}
            disabled={tr.recordOnly}
            onChange={(recordAudio) => void set({ recordAudio }).catch(() => undefined)}
          />
        </Card>
      </Section>

      <LidPauseRow settings={settings} update={update} />

      {/* ST-21 */}
      <Section
        title={t('speech.levels.title')}
        note={t('speech.levels.note')}
        actions={
          <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => void reset()}>
            {t('speech.levels.reset')}
          </Button>
        }
      >
        <Card>
          <div className="sk-page__levels" data-settings-anchor="transcription-levels">
            <SensitivitySlider
              id="transcription-mic-gain"
              label={t('speech.levels.mic')}
              value={tr.micSensitivity}
              onCommit={(micSensitivity) => void set({ micSensitivity }).catch(() => undefined)}
              level={test.levels.mic}
              disabled={!available}
            />
            <SensitivitySlider
              id="transcription-system-gain"
              label={t('speech.levels.system')}
              value={tr.systemSensitivity}
              onCommit={(systemSensitivity) => void set({ systemSensitivity }).catch(() => undefined)}
              level={test.levels.system}
              meterOff={p?.screen !== 'granted'}
              disabled={!available}
            />
            {available && p && p.screen !== 'granted' && <p className="sk-page__hint">{t('speech.levels.systemNeedsScreen')}</p>}
            <div className="sk-page__test">
              <span className="sk-page__label">{t('speech.test.title')}</span>
              <span className="sk-page__hint">{t('speech.test.description')}</span>
              <MicTest session={test} disabled={!available} onChooseMic={() => focusControl(MIC_ID)} />
              {test.warnings.map((w) => (
                <SpeechNotice key={w.code} copy={w} onChooseMic={() => focusControl(MIC_ID)} />
              ))}
            </div>
          </div>
        </Card>
      </Section>

    </div>
  )
}

/** Apex's own small drawings of the two meeting modes, from tokens: a waveform with transcript lines, or the waveform alone. */
function MeetingModeArt({ mode }: { mode: 'transcribe' | 'record' }): ReactElement {
  return (
    <span className={`sk-mode-art sk-mode-art--${mode}`}>
      <span className="sk-mode-art__wave">
        {Array.from({ length: 11 }, (_, i) => (
          <i key={i} />
        ))}
      </span>
      {mode === 'transcribe' && (
        <span className="sk-mode-art__lines">
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
  )
}

/** ST-19: saved a moment after typing stops and on blur, with a live counter and the parser's limits. */
/** B:transcription engine: "Preparing on-device speech for …" with its progress, then ready; an offer or a retry otherwise. */
function ModelStatus({ state, name }: { state: SpeechAssetsState; name: string | null }): ReactElement | null {
  const notice = modelNotice(state.data)
  if (!notice || !name) return null
  const prepare = (label: string): ReactElement => (
    <Button size="sm" variant="secondary" loading={state.preparing} onClick={() => void state.prepare()}>
      {label}
    </Button>
  )
  return (
    <div className="sk-page__inset" data-testid="transcription-model" data-state={notice.kind}>
      {notice.kind === 'preparing' && (
        <Notice>{notice.percent === null ? t('speech.model.preparing', { name }) : t('speech.model.preparingPercent', { name, percent: notice.percent })}</Notice>
      )}
      {notice.kind === 'ready' && <Notice>{t('speech.model.ready', { name })}</Notice>}
      {notice.kind === 'offer' && <Notice action={prepare(t('speech.model.prepare'))}>{t('speech.model.offer', { name })}</Notice>}
      {notice.kind === 'failed' && (
        <Notice tone="warning" action={prepare(t('speech.model.retry'))}>
          {t('speech.model.failed', { name })}
        </Notice>
      )}
      {state.prepareError && <SpeechNotice copy={state.prepareError} />}
    </div>
  )
}

function VocabularyField({ value, save }: { value: string; save(value: string): Promise<void> }): ReactElement {
  const [draft, setDraft] = useState(value)
  const autosave = useAutosave(draft, save)
  // Another window (or Reset) changed it: follow, unless this field has unsaved typing.
  useEffect(() => {
    if (autosave.state !== 'saving') setDraft((d) => (d === value ? d : value))
  }, [value])
  const stats = vocabularyStats(draft)
  const problem = stats.tooMany ? t('speech.vocabulary.tooMany', { max: VOCABULARY_TERMS_MAX }) : stats.tooLong ? t('speech.vocabulary.tooLong', { max: VOCABULARY_TERM_MAX }) : null
  return (
    <div className="sk-page__vocab">
      <p className="sk-page__hint" id={`${VOCABULARY_ID}-hint`}>
        {t('speech.vocabulary.description')}
      </p>
      <TextArea
        id={VOCABULARY_ID}
        className="sk-page__vocabulary"
        value={draft}
        maxLength={VOCABULARY_MAX}
        rows={5}
        spellCheck={false}
        placeholder={t('speech.vocabulary.placeholder')}
        aria-labelledby={`${VOCABULARY_ID}-title`}
        aria-describedby={`${VOCABULARY_ID}-hint ${VOCABULARY_ID}-count`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void autosave.flush()}
      />
      <div className="sk-page__counter" id={`${VOCABULARY_ID}-count`}>
        <span>{t('speech.vocabulary.terms', { count: stats.terms })}</span>
        <span aria-hidden>·</span>
        <span className={stats.chars >= VOCABULARY_MAX ? 'sk-page__counter--full' : undefined}>{t('speech.vocabulary.count', { used: stats.chars, max: VOCABULARY_MAX })}</span>
        <SaveStatus state={autosave.state} onRetry={autosave.retry} className="sk-page__save" />
      </div>
      {problem && (
        <p className="sk-page__hint sk-page__hint--warning" role="status">
          {problem}
        </p>
      )}
    </div>
  )
}
