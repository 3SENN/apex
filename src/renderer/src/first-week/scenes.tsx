/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement, ReactNode } from 'react'
import './scenes.css'

// Short looping previews for the guides: small vector scenes of Apex's own
// UI with a simple companion figure. Each scene rests on
// a complete frame and plays its loop only while hovered or focused (or
// always with `playing`); under Reduce Motion it stays on the resting frame.

/** A small vector companion: a bean body and round head in the companion's colour. */
function Pal({ x, y, scale = 1, wave = false }: { x: number; y: number; scale?: number; wave?: boolean }): ReactElement {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <g className="fw-s-bob">
        <ellipse className="fw-s-shadow" cx="0" cy="19" rx="13" ry="2.6" />
        <rect className="fw-s-tint" x="-11" y="-3" width="22" height="21" rx="10" />
        {wave && <rect className="fw-s-tint fw-s-wave" x="9" y="-2" width="5" height="12" rx="2.5" />}
        <circle className="fw-s-tint" cx="0" cy="-12" r="12" />
        <ellipse className="fw-s-face" cx="0" cy="-10.5" rx="8.4" ry="6.6" />
        <g className="fw-s-blink">
          <circle className="fw-s-eye" cx="-3.2" cy="-11.4" r="1.5" />
          <circle className="fw-s-eye" cx="3.2" cy="-11.4" r="1.5" />
        </g>
        <path className="fw-s-mouth" d="M-2.4 -7.6q2.4 1.9 4.8 0" />
      </g>
    </g>
  )
}

/** A browser window frame: title bar dots and an address pill. */
function Frame({ children }: { children?: ReactNode }): ReactElement {
  return (
    <g>
      <rect className="fw-s-win" x="22" y="16" width="276" height="148" rx="11" />
      <circle className="fw-s-ink" cx="35" cy="27" r="2.4" />
      <circle className="fw-s-ink" cx="43" cy="27" r="2.4" />
      <circle className="fw-s-ink" cx="51" cy="27" r="2.4" />
      <rect className="fw-s-bar" x="112" y="22" width="96" height="10" rx="5" />
      <line className="fw-s-rule" x1="22" y1="37.5" x2="298" y2="37.5" />
      {children}
    </g>
  )
}

function Sparkle({ x, y, size = 4, delay = 0 }: { x: number; y: number; size?: number; delay?: number }): ReactElement {
  const s = size
  return (
    <path
      className="fw-s-sparkle"
      style={{ animationDelay: `${delay}ms` }}
      d={`M${x} ${y - s}Q${x + s * 0.18} ${y - s * 0.18} ${x + s} ${y}Q${x + s * 0.18} ${y + s * 0.18} ${x} ${y + s}Q${x - s * 0.18} ${y + s * 0.18} ${x - s} ${y}Q${x - s * 0.18} ${y - s * 0.18} ${x} ${y - s}Z`}
    />
  )
}

function MeetScene(): ReactElement {
  return (
    <>
      <Frame>
        <rect className="fw-s-ink-strong" x="40" y="52" width="92" height="8" rx="4" />
        <rect className="fw-s-ink" x="40" y="68" width="128" height="5" rx="2.5" />
        <rect className="fw-s-ink" x="40" y="78" width="116" height="5" rx="2.5" />
        <rect className="fw-s-ink" x="40" y="88" width="122" height="5" rx="2.5" />
        <rect className="fw-s-tint-soft" x="40" y="102" width="58" height="44" rx="7" />
        <rect className="fw-s-ink" x="106" y="104" width="62" height="5" rx="2.5" />
        <rect className="fw-s-ink" x="106" y="114" width="54" height="5" rx="2.5" />
        <rect className="fw-s-ink" x="106" y="124" width="60" height="5" rx="2.5" />
      </Frame>
      <g className="fw-s-bubble-pop">
        <rect className="fw-s-bubble" x="196" y="58" width="58" height="24" rx="10" />
        <path className="fw-s-bubble" d="M226 81l6 8 2-8z" />
        <circle className="fw-s-dot" cx="214" cy="70" r="2.6" />
        <circle className="fw-s-dot fw-s-dot--2" cx="225" cy="70" r="2.6" />
        <circle className="fw-s-dot fw-s-dot--3" cx="236" cy="70" r="2.6" />
      </g>
      <Pal x={244} y={124} scale={1.55} wave />
      <Sparkle x={274} y={92} size={4.5} />
      <Sparkle x={208} y={108} size={3.2} delay={600} />
    </>
  )
}

function ChatsScene(): ReactElement {
  return (
    <>
      <Frame>
        <rect className="fw-s-bar" x="22.5" y="38" width="78" height="125.5" />
        <rect className="fw-s-tint-soft fw-s-hop" x="28" y="45" width="66" height="13" rx="6.5" />
        {[51.5, 67.5, 83.5, 99.5, 115.5].map((y, i) => (
          <g key={y}>
            <circle className={i < 3 ? 'fw-s-tint' : 'fw-s-ink'} cx="36" cy={y} r="3.6" />
            <rect className="fw-s-ink" x="44" y={y - 2.5} width={i % 2 ? 36 : 44} height="5" rx="2.5" />
          </g>
        ))}
        <g className="fw-s-slide-in">
          <circle className="fw-s-tint" cx="36" cy="131.5" r="3.6" />
          <rect className="fw-s-ink-strong" x="44" y="129" width="40" height="5" rx="2.5" />
        </g>
        <rect className="fw-s-tint fw-s-appear fw-s-appear--1" x="206" y="50" width="78" height="15" rx="7.5" />
        <circle className="fw-s-tint fw-s-appear fw-s-appear--2" cx="118" cy="82" r="5" />
        <rect className="fw-s-ink fw-s-appear fw-s-appear--2" x="130" y="78" width="126" height="5" rx="2.5" />
        <rect className="fw-s-ink fw-s-appear fw-s-appear--3" x="130" y="88" width="112" height="5" rx="2.5" />
        <rect className="fw-s-ink fw-s-appear fw-s-appear--4" x="130" y="98" width="120" height="5" rx="2.5" />
        <rect className="fw-s-composer" x="112" y="134" width="174" height="20" rx="10" />
        <circle className="fw-s-tint" cx="276" cy="144" r="6" />
      </Frame>
    </>
  )
}

function SkillsScene(): ReactElement {
  return (
    <>
      <Frame>
        <rect className="fw-s-menu" x="40" y="54" width="134" height="58" rx="9" />
        <rect className="fw-s-tint-soft fw-s-pick" x="46" y="60" width="122" height="14" rx="5" />
        {[67, 83, 99].map((y, i) => (
          <g key={y}>
            <rect className="fw-s-tint" x="52" y={y - 3} width="6" height="6" rx="2" opacity={1 - i * 0.2} />
            <rect className="fw-s-ink" x="64" y={y - 2.5} width={[54, 40, 62][i]} height="5" rx="2.5" />
          </g>
        ))}
        <rect className="fw-s-composer" x="40" y="120" width="134" height="26" rx="10" />
        <text className="fw-s-slash" x="52" y="137.5">/</text>
        <rect className="fw-s-tint-soft fw-s-grow" x="62" y="127" width="46" height="12" rx="6" />
        <circle className="fw-s-clock" cx="238" cy="78" r="28" />
        <line className="fw-s-hand fw-s-hand--long" x1="238" y1="78" x2="238" y2="58" />
        <line className="fw-s-hand fw-s-hand--short" x1="238" y1="78" x2="251" y2="78" />
        <circle className="fw-s-tint" cx="238" cy="78" r="3" />
        {[0, 1, 2, 3, 4].map((i) => (
          <rect key={i} className={`fw-s-day fw-s-day--${i}`} x={206 + i * 13.5} y="122" width="10" height="20" rx="4" />
        ))}
      </Frame>
    </>
  )
}

function MemoryScene(): ReactElement {
  return (
    <>
      <Frame>
        {[0, 1, 2].map((i) => (
          <g key={i} className={`fw-s-note fw-s-note--${i}`}>
            <rect className="fw-s-paper" x={48 + i * 8} y={60 + i * 10} width="66" height="48" rx="7" />
            <rect className={i === 2 ? 'fw-s-tint' : 'fw-s-ink-strong'} x={56 + i * 8} y={70 + i * 10} width="30" height="5" rx="2.5" />
            <rect className="fw-s-ink" x={56 + i * 8} y={80 + i * 10} width="48" height="4" rx="2" />
            <rect className="fw-s-ink" x={56 + i * 8} y={88 + i * 10} width="40" height="4" rx="2" />
          </g>
        ))}
        <rect className="fw-s-paper" x="244" y="66" width="34" height="46" rx="8" />
        <rect className="fw-s-ink-strong" x="252" y="80" width="5" height="12" rx="2" />
        <rect className="fw-s-ink-strong" x="265" y="80" width="5" height="12" rx="2" />
        <circle className="fw-s-glow" cx="261" cy="89" r="26" />
        <g className="fw-s-plug">
          <rect className="fw-s-tint" x="200" y="80" width="26" height="18" rx="6" />
          <rect className="fw-s-tint" x="226" y="83" width="12" height="4" rx="2" />
          <rect className="fw-s-tint" x="226" y="91" width="12" height="4" rx="2" />
          <path className="fw-s-cord" d="M200 89c-18 0-20 26-46 26" />
        </g>
        <circle className="fw-s-check-bg fw-s-checked" cx="278" cy="66" r="7" />
        <path className="fw-s-check fw-s-checked" d="M274.6 66.2l2.4 2.4 4.4-4.6" />
      </Frame>
    </>
  )
}

const SCENES: Record<string, () => ReactElement> = {
  'meet-your-companion': MeetScene,
  'chats-and-tabs': ChatsScene,
  'skills-and-routines': SkillsScene,
  'memory-and-connectors': MemoryScene,
}

export function GuideScene({ id, playing = false }: { id: string; playing?: boolean }): ReactElement {
  const Scene = SCENES[id] ?? MeetScene
  return (
    <svg className={`fw-scene${playing ? ' fw-scene--play' : ''}`} viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false">
      <Scene />
    </svg>
  )
}
