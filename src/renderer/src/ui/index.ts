/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Atelier's renderer kit. Import from here: `import { Button, useToast } from '../ui'`.
// Mount <UiHost/> once in App so confirmations and toasts can show.
import './ui.css'

export { Button, IconButton, type ButtonProps, type ButtonVariant, type ControlSize, type IconButtonProps } from './Button'
export { Modal, ModalScope, Dialog, Sheet, type ModalProps, type ModalScopeKind, type DialogProps, type SheetProps } from './Dialog'
export { ConfirmDialog, ConfirmHost, confirm, useConfirm, type ConfirmDialogProps, type ConfirmOptions } from './Confirm'
export { ToastHost, toast, useToast, type ToastApi, type ToastDismissReason, type ToastHostProps, type ToastOptions, type ToastPlacement, type ToastTone } from './Toast'
export { UiHost, type UiHostProps } from './UiHost'
export { showMenu, showContextMenu, menuSeparator, type MenuAnchor, type MenuItemSpec } from './menu'
export { PopoverHost, closePopover, isPopoverOpen, popoverItemsFromSpec, showPopoverMenu, showSpecPopover, type PopoverAnchor, type PopoverItem, type PopoverMenuOptions } from './Popover'
export { Seam, type SeamProps } from './Seam'
export { Skeleton, SkeletonText, SkeletonRows, EmptyState, ErrorState, type SkeletonProps, type SkeletonRowsProps, type EmptyStateProps, type ErrorStateProps } from './States'
export { SaveStatus, useAutosave, type SaveStatusProps, type SaveState, type AutosaveHandle, type AutosaveHookOptions } from './SaveStatus'
export { InlineRename, type InlineRenameProps } from './InlineRename'
export { CheckRow, SegmentedControl, Switch, Select, type CheckRowProps, type SegmentOption, type SegmentedControlProps, type SwitchProps, type SelectOption, type SelectGroup, type SelectProps } from './controls'
export { TabList, TabPanel, tabDomId, panelDomId, type TabItem, type TabListProps, type TabPanelProps } from './TabList'
export { Badge, StatusDot, Spinner, ProgressRing, Kbd, VisuallyHidden, type BadgeProps, type BadgeTone, type Status, type StatusDotProps, type SpinnerProps, type ProgressRingProps, type KbdProps } from './indicators'
export { RelativeTime, type RelativeTimeProps } from './RelativeTime'
export { holdOverlay, useOverlay } from './overlay'
export { MOTION, SPRING, applyMotionSetting, followFrames, motionReduced, springAt, springDuration, springEasing, useFlip, useLayerPresence, useMotion, usePresenceList, type LayerState, type MotionDurations, type PresenceEntry, type PresencePhase, type ResolvedMotion, type SpringPreset } from './motion'
export { applyProfileHue } from './profile'
export { AmbientField, type AmbientFieldHandle, type AmbientFieldProps } from './AmbientField'
export { isMac, useLatest, useMediaQuery, useNow, useReducedMotion, useResolvedTheme, type ResolvedTheme } from './hooks'
export { cx, formatCount } from './logic/format'
export { formatAbsolute, formatDuration, formatRelative, type TimeStyle } from './logic/time'
export { formatShortcut, shortcutParts, tooltipText } from './logic/shortcut'
export { alert, confirmOptionsSpec, type AlertOptions } from './Confirm'
export { reasonFor, toastWire } from './Toast'
export { AsyncButton, useAsyncAction, type AsyncAction, type AsyncActionOptions, type AsyncButtonProps } from './async'
export { useRovingFocus, type RovingFocusOptions } from './roving'
export { applyInterfaceSettings, checkInterfaceFont } from './appearance'
