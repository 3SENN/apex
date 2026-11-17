/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { IconButton } from './Button'
import { useLatest } from './hooks'
import { isTopLayer, pushLayer, tabbables } from './layers'
import { cx } from './logic/format'
import { trapFocusIndex } from './logic/keys'
import { useLayerPresence } from './motion'
import { useOverlay } from './overlay'
import { useT } from '../i18n/useT'

export interface ModalProps {
  open: boolean
  onClose(): void
  children: ReactNode
  /** Id of the visible title; or give `label`. */
  labelledBy?: string
  label?: string
  describedBy?: string
  /** Where the panel sits; 'none' leaves it to `className` (e.g. the companion card). */
  placement?: 'center' | 'right' | 'bottom' | 'none'
  /** Classes for the panel. */
  className?: string
  /** Esc and a click on the scrim close it (default true). */
  dismissible?: boolean
  /** Focused on open; otherwise a [data-autofocus] child, the first focusable control, then the panel. */
  initialFocus?: RefObject<HTMLElement | null>
  role?: 'dialog' | 'alertdialog'
  /**
   * 'content' scopes the scrim to the content area (DS-29): the sidebar and
   * toolbar stay sharp, and the panel sits inside the content area. Defaults
   * to the nearest ModalScope (the companion card provides 'content').
   */
  scope?: ModalScopeKind
}

export type ModalScopeKind = 'window' | 'content'

const ScopeContext = createContext<ModalScopeKind>('window')

/** Modals rendered inside take this scope unless they name their own. */
export function ModalScope({ scope, children }: { scope: ModalScopeKind; children: ReactNode }): ReactElement {
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
}

/** The element App marks as the content area (the card washes and floats over it). */
const CONTENT_REGION = '[data-card-region]'

/** The content area's viewport rect while `on`, kept current; null when off or not found. */
function useContentRegion(on: boolean): { top: number; left: number; width: number; height: number } | null {
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    if (!on) return
    const el = document.querySelector<HTMLElement>(CONTENT_REGION)
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setRect((old) => (old && old.top === r.top && old.left === r.left && old.width === r.width && old.height === r.height ? old : { top: r.top, left: r.left, width: r.width, height: r.height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [on])
  return on ? rect : null
}

/**
 * The base for anything modal: a dimmed, blurred scrim, a focus trap, Esc,
 * focus restored on close, and an overlay hold so page views get out of the
 * way. Nested modals stack; only the top one reacts. Closing plays a short
 * exit with the last open content before it unmounts (instant under Reduce
 * Motion).
 */
export function Modal(props: ModalProps): ReactElement | null {
  const state = useLayerPresence(props.open)
  // The exit shows what was open, even if the owner already cleared it.
  const shown = useRef(props)
  if (props.open) shown.current = props
  if (state === 'closed') return null
  return <ModalLayer {...(state === 'closing' ? shown.current : props)} closing={state === 'closing'} />
}

function ModalLayer({ onClose, children, labelledBy, label, describedBy, placement = 'center', className, dismissible = true, initialFocus, role = 'dialog', scope, closing }: ModalProps & { closing: boolean }): ReactElement {
  const inherited = useContext(ScopeContext)
  const region = useContentRegion((scope ?? inherited) === 'content')
  const regionStyle: CSSProperties | undefined = region ? { top: region.top, left: region.left, width: region.width, height: region.height } : undefined
  const layer = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const pressedScrim = useRef(false)
  const close = useLatest(onClose)
  const canDismiss = useLatest(dismissible && !closing)
  const release = useRef<(() => void) | null>(null)
  useOverlay(true)

  useLayoutEffect(() => {
    const el = layer.current
    if (!el) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const pop = pushLayer(el)
    const marked = panel.current?.querySelector<HTMLElement>('[data-autofocus]')
    const target = initialFocus?.current ?? marked ?? tabbables(panel.current).find((t) => !t.hasAttribute('data-skip-autofocus')) ?? panel.current
    target?.focus({ preventScroll: true })
    let done = false
    release.current = () => {
      if (done) return
      done = true
      pop()
      // Hand focus back to whatever opened the modal, if it is still there.
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
    return () => release.current?.()
    // Focus is placed once, on open.
  }, [])

  // The exit starts: the app behind is usable again at once.
  useLayoutEffect(() => {
    if (closing) release.current?.()
  }, [closing])

  // Esc is handled at the document so it works wherever focus is. Controls
  // that use Esc themselves (inline rename, menus) call preventDefault.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const el = layer.current
      if (e.key !== 'Escape' || e.defaultPrevented || !el || !isTopLayer(el) || !canDismiss.current) return
      e.preventDefault()
      close.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // React bubbles keys from a nested modal's portal up here; that modal traps its own Tab.
    if (e.key !== 'Tab' || e.defaultPrevented || !layer.current?.contains(e.target as Node)) return
    const items = tabbables(panel.current)
    if (!items.length) {
      e.preventDefault()
      panel.current?.focus()
      return
    }
    const current = items.indexOf(document.activeElement as HTMLElement)
    const atEdge = current === -1 || (e.shiftKey ? current === 0 : current === items.length - 1)
    if (!atEdge) return
    e.preventDefault()
    items[trapFocusIndex(current, items.length, e.shiftKey)]?.focus()
  }

  return createPortal(
    <div ref={layer} className={cx('ui-modal', `ui-modal--${placement}`, region && 'ui-modal--content')} style={regionStyle} data-state={closing ? 'closing' : 'open'} onKeyDown={onKeyDown}>
      <div
        className="ui-modal__scrim"
        aria-hidden
        onPointerDown={(e) => {
          pressedScrim.current = e.target === e.currentTarget
        }}
        onClick={(e) => {
          // Only a press that started on the scrim closes, not a drag out of the panel.
          if (pressedScrim.current && e.target === e.currentTarget && canDismiss.current) close.current()
          pressedScrim.current = false
        }}
      />
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={cx('ui-modal__panel', className)}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

export interface DialogProps {
  open: boolean
  onClose(): void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** Buttons, laid out at the bottom right. */
  footer?: ReactNode
  /** Width: 'sm' 380 px, 'md' 480 px, 'lg' 640 px. */
  size?: 'sm' | 'md' | 'lg'
  dismissible?: boolean
  initialFocus?: RefObject<HTMLElement | null>
  role?: 'dialog' | 'alertdialog'
  /** Hides the close button in the corner. */
  hideClose?: boolean
  className?: string
}

function ModalBody({ titleId, descId, title, description, children, footer, onClose, hideClose }: DialogProps & { titleId: string; descId: string }): ReactElement {
  const t = useT()
  return (
    <>
      <header className="ui-dialog__header">
        <h2 id={titleId} className="ui-dialog__title">
          {title}
        </h2>
        {!hideClose && <IconButton label={t('core.dialog.close')} tooltip={false} size="sm" icon={<X />} onClick={onClose} className="ui-dialog__close" data-skip-autofocus />}
      </header>
      {description !== undefined && (
        <div id={descId} className="ui-dialog__description">
          {description}
        </div>
      )}
      {children !== undefined && <div className="ui-dialog__body">{children}</div>}
      {footer !== undefined && <footer className="ui-dialog__footer">{footer}</footer>}
    </>
  )
}

/** A centred dialog with a title, optional description, body and footer. */
export function Dialog(props: DialogProps): ReactElement | null {
  const titleId = useId()
  const descId = useId()
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      labelledBy={titleId}
      describedBy={props.description !== undefined ? descId : undefined}
      dismissible={props.dismissible}
      initialFocus={props.initialFocus}
      role={props.role}
      className={cx('ui-dialog', `ui-dialog--${props.size ?? 'md'}`, props.className)}
    >
      <ModalBody {...props} titleId={titleId} descId={descId} />
    </Modal>
  )
}

export interface SheetProps extends DialogProps {
  /** Which edge it slides from (default right). */
  side?: 'right' | 'bottom'
}

/** A taller panel from the right (or bottom) edge, for create and review flows. */
export function Sheet({ side = 'right', ...props }: SheetProps): ReactElement | null {
  const titleId = useId()
  const descId = useId()
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      labelledBy={titleId}
      describedBy={props.description !== undefined ? descId : undefined}
      dismissible={props.dismissible}
      initialFocus={props.initialFocus}
      role={props.role}
      placement={side}
      className={cx('ui-dialog', 'ui-sheet', `ui-sheet--${side}`, `ui-dialog--${props.size ?? 'md'}`, props.className)}
    >
      <ModalBody {...props} titleId={titleId} descId={descId} />
    </Modal>
  )
}
