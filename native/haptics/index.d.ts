/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for Apex's haptics addon loader (index.js).

/** The patterns AppKit's NSHapticFeedbackManager offers. */
export type HapticPattern = 'alignment' | 'levelChange' | 'generic'

/** What perform() accepts: the AppKit names, plus the service's kebab-case spelling. */
export type HapticPatternInput = HapticPattern | 'level-change'

export type HapticsStubReason =
  | 'unsupported-platform'
  | 'missing'
  | 'load-failed'
  | 'invalid-addon'

export interface Haptics {
  /** True when the native addon loaded. */
  readonly available: boolean
  /** 'loaded', or why this is the stub. */
  readonly reason: 'loaded' | HapticsStubReason
  /** The binary that loaded, or null for the stub. */
  readonly path: string | null
  /** The load error, when reason is 'load-failed' or 'invalid-addon'. */
  readonly error?: string
  /**
   * Plays one pattern. Returns true when it was handed to macOS, false for
   * the stub (or if the native call failed). Throws a TypeError for an
   * unknown pattern, stub or not.
   */
  perform(pattern: HapticPatternInput): boolean
}

export interface LoadHapticsOptions {
  /** Files to try, first existing one wins. Defaults to defaultPaths(). */
  paths?: readonly string[]
  /** Defaults to process.platform. Anything but 'darwin' gets the stub. */
  platform?: NodeJS.Platform | string
  /** Defaults to process.dlopen. */
  dlopen?: (module: { exports: unknown }, filename: string) => void
  /** Defaults to fs.existsSync. */
  exists?: (file: string) => boolean
}

/** The native module itself, as build/apex_haptics.node exports it. */
export interface HapticsAddon {
  perform(pattern: HapticPatternInput): boolean
}

export declare const PATTERNS: readonly HapticPattern[]
/** The binary's file name: apex_haptics.node. */
export declare const BINARY: string

/** Returns the canonical pattern name, or throws a TypeError. */
export declare function normalisePattern(pattern: unknown): HapticPattern
/**
 * <resourcesPath>/native/apex_haptics.node (resourcesPath defaults to
 * Electron's process.resourcesPath), then build/apex_haptics.node here.
 */
export declare function defaultPaths(resourcesPath?: string): string[]
export declare function createStub(reason: HapticsStubReason, error?: string): Haptics
/** Loads the addon, or returns a stub saying why it couldn't. Never throws. */
export declare function loadHaptics(options?: LoadHapticsOptions): Haptics
/** The shared instance, loaded from defaultPaths() on first use. */
export declare function getHaptics(): Haptics
/** Plays one pattern through the shared instance. */
export declare function perform(pattern: HapticPatternInput): boolean
