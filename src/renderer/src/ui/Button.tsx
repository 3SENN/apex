/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useRef, type ComponentPropsWithRef, type MouseEvent, type PointerEvent, type ReactElement, type ReactNode, type Ref } from 'react'
import { isMac } from './hooks'
import { cx } from './logic/format'
import { iconTooltip } from './logic/iconTooltip'
import { ariaKeyShortcut } from './logic/shortcut'
import { Spinner } from './indicators'
import { useTooltip, type TooltipOptions } from './Tooltip'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'brand'
export type ControlSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant
  size?: ControlSize
  /** Leading icon; replaced by a spinner while loading. */
  icon?: ReactNode
  iconEnd?: ReactNode
  /** Disables the button and shows a spinner, keeping its width. */
  loading?: boolean
  fullWidth?: boolean
}

export function Button({ variant = 'secondary', size = 'md', icon, iconEnd, loading = false, fullWidth, className, children, disabled, type = 'button', ...rest }: ButtonProps): ReactElement {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, fullWidth && 'ui-btn--full', className)}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon}
      {children !== undefined && children !== null && <span className="ui-btn__label">{children}</span>}
      {iconEnd}
    </button>
  )
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'title'> {
  /** The accessible name, and the tooltip unless `tooltip` says otherwise. */
  label: string
  icon: ReactNode
  /** An Electron accelerator ('CmdOrCtrl+J') shown in the tooltip and exposed to assistive tech. */
  shortcut?: string
  /** Tooltip text, or false for none. Drawn as the dark overlay tooltip (DS-95); the native title only without an overlay host. */
  tooltip?: string | false
  /** Where the tooltip goes; below by default, 'top' for footer and composer controls. */
  tooltipSide?: TooltipOptions['side']
  size?: ControlSize
  /** 'ghost' is bare until hovered; 'subtle' has a resting fill. */
  variant?: 'ghost' | 'subtle'
  /** Makes it a toggle: sets aria-pressed and the on style. */
  pressed?: boolean
  tone?: 'default' | 'danger'
  /** A dot or count drawn on the top-right corner. */
  badge?: ReactNode
  /** Fires after a ~400 ms press (for history lists); the click that follows is swallowed. */
  onLongPress?(button: HTMLButtonElement): void
}

const LONG_PRESS_MS = 400

/** One element ref for the button and the caller's own, object or callback. */
function useMergedRef(outer: Ref<HTMLButtonElement> | undefined): [{ current: HTMLButtonElement | null }, (el: HTMLButtonElement | null) => void] {
  const own = useRef<HTMLButtonElement | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const set = useCallback(
    (el: HTMLButtonElement | null) => {
      own.current = el
      if (typeof outer === 'function') {
        if (el) {
          const done = outer(el)
          cleanup.current = typeof done === 'function' ? done : null
        } else if (cleanup.current) {
          cleanup.current()
          cleanup.current = null
        } else outer(null)
      } else if (outer) outer.current = el
    },
    [outer],
  )
  return [own, set]
}

export function IconButton({
  label,
  icon,
  shortcut,
  tooltip,
  tooltipSide,
  size = 'md',
  variant = 'ghost',
  pressed,
  tone = 'default',
  badge,
  onLongPress,
  className,
  type = 'button',
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onPointerCancel,
  onClickCapture,
  ref: outerRef,
  ...rest
}: IconButtonProps): ReactElement {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const cancel = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const [own, setRef] = useMergedRef(outerRef)
  // DS-95: the dark overlay tooltip, not the system one.
  const tip = iconTooltip(label, shortcut, tooltip, isMac)
  useTooltip(own, { label: tip?.label ?? '', shortcutId: tip?.shortcutId ?? null, side: tooltipSide, disabled: !tip })

  return (
    <button
      {...rest}
      ref={setRef}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut ? ariaKeyShortcut(shortcut, isMac) : undefined}
      className={cx('ui-icon-btn', `ui-icon-btn--${size}`, `ui-icon-btn--${variant}`, pressed && 'ui-icon-btn--on', tone === 'danger' && 'ui-icon-btn--danger', className)}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
        onPointerDown?.(e)
        fired.current = false
        if (!onLongPress || e.button !== 0) return
        const button = e.currentTarget
        cancel()
        timer.current = setTimeout(() => {
          fired.current = true
          onLongPress(button)
        }, LONG_PRESS_MS)
      }}
      onPointerUp={(e) => {
        onPointerUp?.(e)
        cancel()
      }}
      onPointerLeave={(e) => {
        onPointerLeave?.(e)
        cancel()
      }}
      onPointerCancel={(e) => {
        onPointerCancel?.(e)
        cancel()
      }}
      onClickCapture={(e: MouseEvent<HTMLButtonElement>) => {
        if (fired.current) {
          fired.current = false
          e.preventDefault()
          e.stopPropagation()
          return
        }
        onClickCapture?.(e)
      }}
    >
      {icon}
      {badge !== undefined && badge !== null && badge !== false && <span className="ui-icon-btn__badge">{badge}</span>}
    </button>
  )
}
