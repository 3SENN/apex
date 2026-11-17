/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The install review (docs/packs.md): what a pack is, who signed it, what it
// asks for in plain words (and, for an update, what is new), any reason it
// can't be installed, and every code file to read. A pack that can do
// something serious (danger lines) needs a tick before Install.
import { useEffect, useState, type ReactElement } from 'react'
import { BadgeCheck, ShieldQuestion } from 'lucide-react'
import type { PackReview, PackSummary } from '@shared/packs'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Notice } from '../settings/kit'
import { Badge, Button, CheckRow, Sheet, useToast } from '../ui'
import { countParts, formatBytes, needsConfirm, sourceKey } from './logic'
import { PermissionList } from './PermissionList'

export function ReviewSheet({ review, onClose, onInstalled }: { review: PackReview | null; onClose(): void; onInstalled?(pack: PackSummary): void }): ReactElement | null {
  const t = useT()
  const toast = useToast()
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setUnderstood(false)
    setError(null)
  }, [review?.token])
  if (!review) return null

  const confirmNeeded = needsConfirm(review.permissions)
  const blocked = review.problems.length > 0
  const close = (): void => {
    void call('packs', 'cancelReview', review.token).catch(() => undefined)
    onClose()
  }
  const install = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const pack = await call('packs', 'confirmInstall', review.token)
      // An app or a world: open it from here, without looking for it.
      const app = pack.apps[0]
      const world = pack.worlds[0]
      const open = app ? () => void call('packs', 'openApp', pack.id, app.id).catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) })) : world ? () => void call('packs', 'openWorld', world.ref).catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) })) : null
      toast.show({
        message: review.replaces ? t('packs.review.updated', { name: pack.name, version: pack.version }) : t('packs.review.installed', { name: pack.name }),
        ...(open ? { action: { label: app ? t('packs.review.openApp', { name: app.name }) : t('packs.review.openWorld'), onAction: open } } : {}),
      })
      onInstalled?.(pack)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const parts = countParts(review.counts)

  return (
    <Sheet
      open
      onClose={close}
      size="lg"
      title={review.replaces ? t('packs.review.titleUpdate') : t('packs.review.title')}
      description={t('packs.review.description')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('packs.review.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={blocked || (confirmNeeded && !understood)} onClick={() => void install()}>
            {review.replaces ? t('packs.review.update') : t('packs.review.install')}
          </Button>
        </>
      }
    >
      <div className="pk-review">
        <div className="pk-review__head">
          <h3 className="pk-review__name">
            {review.name} <span className="pk-muted pk-small">{review.version}</span>
          </h3>
          {review.description && <p className="pk-muted">{review.description}</p>}
          <dl className="pk-meta">
            {review.author && (
              <>
                <dt>{t('packs.meta.author')}</dt>
                <dd>{review.author}</dd>
              </>
            )}
            {review.builtBy && (
              <>
                <dt>{t('packs.meta.builtBy')}</dt>
                <dd>{review.builtBy}</dd>
              </>
            )}
            <dt>{t('packs.meta.source')}</dt>
            <dd>
              {t(sourceKey(review.source))}
              {review.source.url ? ` · ${review.source.url}` : ''}
            </dd>
            <dt>{t('packs.meta.signature')}</dt>
            <dd>
              {review.signature === 'signed' ? (
                <Badge tone="success">
                  <BadgeCheck size={12} aria-hidden="true" /> {review.organisationKey ? t('packs.signature.organisation') : t('packs.signature.signed', { key: review.keyId ?? '' })}
                </Badge>
              ) : (
                <Badge tone="warning">
                  <ShieldQuestion size={12} aria-hidden="true" /> {t('packs.signature.unsigned')}
                </Badge>
              )}
            </dd>
            {parts.length > 0 && (
              <>
                <dt>{t('packs.meta.adds')}</dt>
                <dd>{parts.map((p) => t(p.key, { count: p.count })).join(' · ')}</dd>
              </>
            )}
          </dl>
        </div>

        {(review.shared.image || review.shared.note) && (
          <section className="pk-block pk-shared" aria-label={t('packs.review.sharedLabel')}>
            {review.shared.image && <img className="pk-shared__image" src={review.shared.image} alt={t('packs.review.sharedImage', { name: review.name })} />}
            {review.shared.note && (
              <blockquote className="pk-shared__note">
                <p>{review.shared.note}</p>
                <footer className="pk-muted pk-small">{t('packs.review.sharedNote')}</footer>
              </blockquote>
            )}
          </section>
        )}

        {blocked && (
          <Notice tone="error">
            <strong>{t('packs.review.problems')}</strong>
            <ul>
              {review.problems.slice(0, 20).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Notice>
        )}
        {review.signature === 'unsigned' && !blocked && <Notice tone="warning">{t('packs.review.unsignedWarning')}</Notice>}

        {review.replaces && (
          <section className="pk-block" aria-labelledby="pk-review-new">
            <h4 className="pk-block__title" id="pk-review-new">
              {t('packs.review.replaces', { from: review.replaces.version, to: review.version })}
            </h4>
            {review.replaces.added.length > 0 ? <PermissionList lines={review.replaces.added} label={t('packs.review.newLines')} /> : <p className="pk-muted pk-small">{t('packs.review.nothingNew')}</p>}
          </section>
        )}

        <section className="pk-block" aria-labelledby="pk-review-perms">
          <h4 className="pk-block__title" id="pk-review-perms">
            {t('packs.review.permissions')}
          </h4>
          <PermissionList lines={review.permissions} added={review.replaces?.added} label={t('packs.review.permissions')} />
        </section>

        {confirmNeeded && !blocked && <CheckRow label={t('packs.review.understand')} checked={understood} onChange={setUnderstood} />}

        {review.prompts.length > 0 && (
          <section className="pk-block" aria-labelledby="pk-review-prompts">
            <h4 className="pk-block__title" id="pk-review-prompts">
              {t('packs.review.prompts')}
            </h4>
            <p className="pk-muted pk-small">{t('packs.review.promptsHint')}</p>
            <div className="pk-code">
              {review.prompts.map((p) => (
                <details key={`${p.kind}:${p.name}`}>
                  <summary>
                    {p.name} · {p.kind === 'skill' ? t('packs.review.promptSkill') : t('packs.review.promptTool')}
                  </summary>
                  <pre tabIndex={0} style={{ whiteSpace: 'pre-wrap' }}>
                    {p.text}
                  </pre>
                </details>
              ))}
            </div>
          </section>
        )}

        {review.code.length > 0 && (
          <section className="pk-block" aria-labelledby="pk-review-code">
            <h4 className="pk-block__title" id="pk-review-code">
              {t('packs.review.code')}
            </h4>
            <p className="pk-muted pk-small">{t('packs.review.codeHint')}</p>
            <div className="pk-code">
              {review.code.map((file) => (
                <details key={file.path}>
                  <summary>{file.path}</summary>
                  <pre tabIndex={0}>{file.text}</pre>
                </details>
              ))}
            </div>
          </section>
        )}

        <details className="pk-code">
          <summary>{t('packs.review.files', { count: review.files.length })}</summary>
          <ul className="pk-log">
            {review.files.map((f) => (
              <li key={f.path}>
                <span>{formatBytes(f.size)}</span>
                <span />
                <span>{f.path}</span>
              </li>
            ))}
          </ul>
        </details>

        {error && (
          <p className="pk-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  )
}
