/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Onboarding illustrations, drawn as code SVG: the
// showcase scenes (ON-09) and the layout previews (ON-07). Shapes coloured
// by tokens (light and dark), with the person's own companion in them (a
// rendered still of its face), decorative to screen readers, and
// still when `animate` is false (reduced motion).
import { createContext, useContext, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { DEFAULT_LOOK, type CompanionLook } from '@shared/companion'
import type { ShowcaseSlideId } from '@shared/onboarding'
import { useCompanionImage } from '../companion'
import './illustrations.css'

interface ArtProps {
  animate?: boolean
  /** The companion's accent; the art follows it. */
  tint?: string
  className?: string
  /** The companion that stars in the scene; without one its place is a soft disc. */
  look?: CompanionLook
}

/** The companion's face still, for every Head in one picture. */
const FaceContext = createContext<string | null>(null)

/** The face rendered once per picture, at a size that stays sharp on a 2× screen. */
function useFace(look: CompanionLook | undefined): string | null {
  return useCompanionImage(look ?? DEFAULT_LOOK, 128, { mood: 'happy', framing: 'face', skip: !look })
}

function Frame({ animate = true, tint, className, children, look, viewBox = '0 0 240 150' }: ArtProps & { children: ReactNode; viewBox?: string }): ReactElement {
  const face = useFace(look)
  return (
    <svg className={`il${className ? ` ${className}` : ''}`} viewBox={viewBox} aria-hidden="true" focusable="false" data-static={animate ? undefined : ''} style={tint ? ({ '--il-tint': tint } as CSSProperties) : undefined}>
      <FaceContext.Provider value={face}>{children}</FaceContext.Provider>
    </svg>
  )
}

/** A browser window outline with a tab strip. */
function Window({ x = 20, y = 16, w = 200, h = 118 }: { x?: number; y?: number; w?: number; h?: number }): ReactElement {
  return (
    <>
      <rect className="panel" x={x} y={y} width={w} height={h} rx="10" />
      <circle className="line" cx={x + 12} cy={y + 11} r="3" />
      <circle className="line" cx={x + 22} cy={y + 11} r="3" />
      <circle className="line" cx={x + 32} cy={y + 11} r="3" />
      <rect className="line" x={x + 46} y={y + 7} width={w - 58} height="8" rx="4" />
    </>
  )
}

/** The companion in the art: its own face on a soft disc in its colour (the disc alone while the face renders). */
function Head({ cx, cy, r = 13, className }: { cx: number; cy: number; r?: number; className?: string }): ReactElement {
  const face = useContext(FaceContext)
  const size = r * 2.5
  return (
    <g className={className}>
      <circle className="soft" cx={cx} cy={cy} r={r + 2} />
      {face && <image className="face" href={face} x={cx - size / 2} y={cy - size / 2} width={size} height={size} preserveAspectRatio="xMidYMid meet" />}
    </g>
  )
}

const lines = (x: number, y: number, widths: number[], gap = 9): ReactElement[] => widths.map((w, i) => <rect key={i} className="line" x={x} y={y + i * gap} width={w} height="4" rx="2" />)

function Tabs(): ReactElement {
  return (
    <>
      <Window />
      <rect className="soft" x="32" y="38" width="80" height="84" rx="6" />
      {lines(40, 50, [60, 48, 56, 40])}
      <rect className="panel" x="122" y="38" width="86" height="84" rx="6" />
      {lines(130, 50, [66, 52, 60])}
      <rect className="accent" x="130" y="86" width="40" height="12" rx="6" />
      <path className="stroke drift" d="M178 104 l8 8 l3 -9 z" />
      <Head cx={196} cy={30} r={11} className="drift" />
    </>
  )
}

function Meetings(): ReactElement {
  return (
    <>
      <Window />
      <circle className="soft pulse" cx="70" cy="82" r="26" />
      <circle className="accent" cx="70" cy="82" r="12" />
      <g className="bars">
        <rect className="accent" x="112" y="62" width="6" height="36" rx="3" />
        <rect className="accent" x="124" y="56" width="6" height="42" rx="3" />
        <rect className="accent" x="136" y="66" width="6" height="32" rx="3" />
        <rect className="accent" x="148" y="58" width="6" height="40" rx="3" />
        <rect className="accent" x="160" y="68" width="6" height="30" rx="3" />
      </g>
      {lines(112, 108, [84, 60])}
      <Head cx={194} cy={52} r={12} className="drift" />
    </>
  )
}

function Documents(): ReactElement {
  return (
    <>
      <rect className="panel" x="56" y="14" width="128" height="124" rx="8" />
      <rect className="ink" x="70" y="28" width="70" height="7" rx="3.5" />
      {lines(70, 46, [96, 88, 92, 60])}
      <rect className="soft" x="70" y="86" width="100" height="34" rx="5" />
      <rect className="accent type" x="78" y="98" width="72" height="5" rx="2.5" />
      <Head cx={190} cy={110} r={12} className="drift" />
    </>
  )
}

function Research(): ReactElement {
  return (
    <>
      <rect className="panel" x="18" y="30" width="62" height="78" rx="6" />
      <rect className="panel" x="89" y="22" width="62" height="78" rx="6" />
      <rect className="panel" x="160" y="30" width="62" height="78" rx="6" />
      {lines(26, 42, [44, 36, 40])}
      {lines(97, 34, [46, 38, 30])}
      {lines(168, 42, [40, 44, 34])}
      <path className="stroke draw" d="M49 108 C 60 128, 110 132, 120 122 C 130 132, 180 128, 191 108" />
      <Head cx={120} cy={126} r={10} />
    </>
  )
}

function Routines(): ReactElement {
  return (
    <>
      <circle className="panel" cx="86" cy="76" r="48" />
      <g className="spin">
        <rect className="accent" x="84" y="36" width="4" height="40" rx="2" />
      </g>
      <rect className="ink" x="84" y="58" width="4" height="20" rx="2" transform="rotate(60 86 76)" />
      <circle className="accent" cx="86" cy="76" r="5" />
      <rect className="panel" x="148" y="34" width="72" height="22" rx="6" />
      <rect className="panel" x="148" y="64" width="72" height="22" rx="6" />
      <rect className="soft" x="148" y="94" width="72" height="22" rx="6" />
      {lines(156, 43, [40])}
      {lines(156, 73, [48])}
      <Head cx={206} cy={105} r={9} className="pulse" />
    </>
  )
}

function Memory(): ReactElement {
  return (
    <>
      <rect className="panel" x="40" y="26" width="72" height="54" rx="6" transform="rotate(-6 76 53)" />
      <rect className="panel" x="128" y="22" width="72" height="54" rx="6" transform="rotate(5 164 49)" />
      <rect className="soft" x="84" y="72" width="76" height="56" rx="6" />
      {lines(50, 40, [46, 38])}
      {lines(138, 36, [48, 34])}
      {lines(94, 86, [52, 44, 30])}
      <Head cx={122} cy={60} r={12} className="drift" />
    </>
  )
}

const SCENES: Record<ShowcaseSlideId, () => ReactElement> = { tabs: Tabs, meetings: Meetings, documents: Documents, research: Research, routines: Routines, memory: Memory }

/** One showcase slide's scene (ON-09). */
export function ShowcaseScene({ id, ...art }: ArtProps & { id: ShowcaseSlideId }): ReactElement {
  const Scene = SCENES[id]
  return (
    <Frame {...art}>
      <rect className="paper" x="0" y="0" width="240" height="150" rx="12" />
      <Scene />
    </Frame>
  )
}

/** The layout step's small previews (ON-07): the sidebar, or tabs across the top. */
export function LayoutPreview({ kind, ...art }: ArtProps & { kind: 'sidebar' | 'tabs' }): ReactElement {
  return (
    <Frame {...art} viewBox="0 0 160 100">
      <rect className="paper" x="0" y="0" width="160" height="100" rx="10" />
      <rect className="panel" x="10" y="10" width="140" height="80" rx="7" />
      {kind === 'sidebar' ? (
        <>
          <rect className="soft" x="14" y="14" width="34" height="72" rx="5" />
          {[22, 32, 42, 52].map((y, i) => <rect key={y} className={i === 0 ? 'accent' : 'line'} x="19" y={y} width="24" height="5" rx="2.5" />)}
          {lines(56, 22, [80, 70, 84, 60], 10)}
          <Head cx={31} cy={74} r={7} />
        </>
      ) : (
        <>
          <rect className="soft" x="14" y="14" width="132" height="12" rx="4" />
          {[18, 50, 82].map((x, i) => <rect key={x} className={i === 0 ? 'accent' : 'line'} x={x} y="17" width="28" height="6" rx="3" />)}
          {lines(20, 36, [110, 96, 116, 80], 10)}
          <Head cx={134} cy={74} r={7} />
        </>
      )}
    </Frame>
  )
}
