/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// The JSON rule files: compatibility, hat placement, pupils, randomization,
// animation events and the preset companions.

import { CLIPS, FACE_IDS, PART_IDS, PART_SLOTS } from './catalogue.mjs'
import { faceFiles } from './face-svg.mjs'
import { EAR_ACCESSORIES } from './accessories.mjs'
import { framePoints, fringeClearance, hairFits, hatAdjustment, sameAdjustment } from './fit.mjs'
import { HAIR } from './hair.mjs'
import { HATS } from './hats.mjs'

const CONFIG_FILES = {
  compatibility: 'config/head-part-compatibility.json',
  hats: 'config/hat-config.json',
  pupils: 'config/eye-pupil-config.json',
  randomization: 'config/randomization-config.json',
  animationEvents: 'config/animation-events.json',
  presets: 'config/presets.json',
}

const RULE_SLOTS = ['ears', 'hair', 'hat', 'eyeAccessory', 'earAccessory']

/**
 * Hair and ears that poke through a hat (or vanish inside it). These entries
 * are keyed by hat id and have the same shape as the head entries: what a
 * look wearing that hat accepts. The side-swept fringe runs across the
 * forehead, through a beanie's cuff and a cap's brim.
 */
const HAT_CONFLICTS = {
  'hat-beanie': { hair: ['hair-spiky', 'hair-curls', 'hair-bun', 'hair-sideswept', 'hair-mohawk'], ears: ['ears-bear'] },
  'hat-cap': { hair: ['hair-tuft', 'hair-spiky', 'hair-curls', 'hair-sideswept', 'hair-mohawk'], ears: ['ears-bear'] },
  'hat-wizard': { hair: ['hair-spiky', 'hair-curls', 'hair-bun', 'hair-mohawk'], ears: ['ears-cat', 'ears-bear', 'ears-bunny'] },
  'hat-beret': { hair: ['hair-tuft', 'hair-spiky', 'hair-curls', 'hair-mohawk'], ears: ['ears-bear'] },
}

function compatibility(heads) {
  const out = {}
  for (const head of heads) {
    const points = framePoints(head.head)
    const rules = {}
    for (const slot of RULE_SLOTS) rules[slot] = 'all'
    const hair = PART_IDS.hair.filter((id) => hairFits(points, HAIR[id]).ok)
    if (hair.length !== PART_IDS.hair.length) rules.hair = hair
    out[head.id] = rules
  }
  for (const [hat, blocked] of Object.entries(HAT_CONFLICTS)) {
    const rules = {}
    for (const slot of RULE_SLOTS) rules[slot] = blocked[slot] ? PART_IDS[slot].filter((id) => !blocked[slot].includes(id)) : 'all'
    out[hat] = rules
  }
  return out
}

/** Parts worn over the head and its hair: every hat, plus ear accessories with a band (headphones). */
function overParts() {
  const hats = PART_IDS.hat.map((id) => [id, HATS[id].fit])
  const ear = PART_IDS.earAccessory.filter((id) => EAR_ACCESSORIES[id].fit).map((id) => [id, EAR_ACCESSORIES[id].fit])
  return [...hats, ...ear]
}

/**
 * Seats per part and head. Hair raises the seat, so each head entry also
 * lists replacements for the hair styles that move the part.
 */
function hatConfig(heads) {
  const out = {}
  const hairPositions = new Map()
  const positionsOf = (hairId) => {
    if (!hairPositions.has(hairId)) hairPositions.set(hairId, Object.values(HAIR[hairId].build()).flatMap((mesh) => mesh.pos))
    return hairPositions.get(hairId)
  }
  for (const [id, fit] of overParts()) {
    out[id] = {}
    for (const head of heads) {
      const points = framePoints(head.head)
      const base = hatAdjustment(head.head, points, fit)
      const hair = {}
      for (const hairId of PART_IDS.hair) {
        if (!HAIR[hairId].shells || HAT_CONFLICTS[id]?.hair.includes(hairId)) continue
        const adj = hatAdjustment(head.head, points, fit, HAIR[hairId])
        if (!sameAdjustment(adj, base)) hair[hairId] = adj
      }
      out[id][head.id] = Object.keys(hair).length > 0 ? { ...base, hair } : base
      // The fit only grows a shell hat over hair caps; locks and fringes are
      // checked here, so a style that would cut through the brim or cuff
      // has to be listed in HAT_CONFLICTS.
      if (fit.type !== 'shell') continue
      for (const hairId of PART_IDS.hair) {
        if (HAT_CONFLICTS[id]?.hair.includes(hairId)) continue
        const scale = (hair[hairId] ?? base).scale
        const poke = fringeClearance(positionsOf(hairId), fit.shells, scale)
        if (poke > 0) throw new Error(`${hairId} stands ${poke.toFixed(3)} out of ${id} on ${head.id}; list it in HAT_CONFLICTS`)
      }
    }
  }
  return out
}

/** Pip's look: official Apex's default companion, which the app takes from presets.json (scripts/branding.mjs). */
const PIP_LOOK = {
  rig: 'A',
  parts: { head: 'head-round', ears: null, hair: 'hair-tuft', hat: null, eyeAccessory: null, earAccessory: null, prop: null },
  face: { eyes: 'eyes-round', brows: 'brows-soft', mouth: 'mouth-smile' },
  colors: { skin: '#8f74f8', hair: '#4b3aa8', accent: '#c9bbff', outfit: '#6a4bff' },
}

const PALETTES = [
  { name: 'Lavender', weight: 3, colors: { ...PIP_LOOK.colors } },
  { name: 'Peach Fizz', weight: 2, colors: { skin: '#ffb38a', hair: '#7a3b2e', accent: '#2ec4b6', outfit: '#ff6b6b' } },
  { name: 'Mint Drop', weight: 2, colors: { skin: '#7fe0c0', hair: '#1f6f5c', accent: '#ffe08a', outfit: '#3fa7d6' } },
  { name: 'Sky Pop', weight: 2, colors: { skin: '#8ec9ff', hair: '#2d4e9e', accent: '#ffd166', outfit: '#ef476f' } },
  { name: 'Sunbeam', weight: 2, colors: { skin: '#ffd36e', hair: '#a0522d', accent: '#ff8fab', outfit: '#4cc9f0' } },
  { name: 'Berry Jam', weight: 2, colors: { skin: '#ff8fb8', hair: '#6b2148', accent: '#ffe3ef', outfit: '#8338ec' } },
  { name: 'Cocoa', weight: 2, colors: { skin: '#c68b62', hair: '#3b2318', accent: '#f6c177', outfit: '#5b8e7d' } },
  { name: 'Midnight', weight: 1, colors: { skin: '#8d9ae0', hair: '#1b1f3b', accent: '#ffd447', outfit: '#2b2d63' } },
  { name: 'Bubblegum', weight: 2, colors: { skin: '#ffc2e2', hair: '#ff5fa2', accent: '#9be7ff', outfit: '#b388eb' } },
  { name: 'Moss', weight: 1, colors: { skin: '#a7c957', hair: '#386641', accent: '#f2e8cf', outfit: '#bc4749' } },
  { name: 'Marshmallow', weight: 1, colors: { skin: '#f4efe6', hair: '#9a8c98', accent: '#f4a261', outfit: '#6d6875' } },
  { name: 'Coral Reef', weight: 2, colors: { skin: '#ff9f80', hair: '#264653', accent: '#e9c46a', outfit: '#2a9d8f' } },
]

function randomization() {
  const weights = (ids, special = {}, fallback = 1) => ids.map((id) => ({ id, weight: special[id] ?? fallback }))
  return {
    rig: [{ id: 'A', weight: 4 }, { id: 'B', weight: 3 }, { id: 'C', weight: 3 }],
    slots: {
      head: weights(PART_IDS.head, { 'head-round': 3 }, 2),
      ears: [{ id: null, weight: 6 }, ...weights(PART_IDS.ears)],
      hair: [{ id: null, weight: 1 }, ...weights(PART_IDS.hair, { 'hair-tuft': 3 }, 2)],
      hat: [{ id: null, weight: 6 }, ...weights(PART_IDS.hat)],
      eyeAccessory: [{ id: null, weight: 8 }, ...weights(PART_IDS.eyeAccessory)],
      earAccessory: [{ id: null, weight: 8 }, ...weights(PART_IDS.earAccessory)],
      prop: [{ id: null, weight: 6 }, ...weights(PART_IDS.prop)],
    },
    face: {
      eyes: weights(FACE_IDS.eyes, { 'eyes-round': 3, 'eyes-sleepy': 1, 'eyes-wide': 1, 'eyes-cat': 1 }, 2),
      brows: weights(FACE_IDS.brows, { 'brows-soft': 3, 'brows-none': 1 }, 2),
      mouth: weights(FACE_IDS.mouth, { 'mouth-smile': 3, 'mouth-fang': 1 }, 2),
    },
    palettes: PALETTES,
  }
}

/** Cues per clip, in seconds. Think, sleep and wave put the prop away (the right hand is busy); the other loops bring it back. */
function animationEvents() {
  const show = { t: 0.05, type: 'prop', visible: true }
  const events = {
    idle: [show, { t: 1.3, type: 'blink' }, { t: 2.4, type: 'expression', face: { mouth: 'happy' }, duration: 0.8 }, { t: 3.4, type: 'blink' }],
    listen: [
      show,
      { t: 0.8, type: 'expression', face: { eyes: 'happy' }, duration: 0.35 },
      { t: 1.6, type: 'blink' },
      { t: 2.15, type: 'expression', face: { eyes: 'happy' }, duration: 0.35 },
    ],
    think: [
      { t: 0.05, type: 'prop', visible: false },
      { t: 0.9, type: 'blink' },
      { t: 1.6, type: 'expression', face: { eyes: 'neutral', brows: 'raised' }, duration: 0.7 },
      { t: 2.6, type: 'blink' },
      { t: 3.2, type: 'sparkle' },
    ],
    work: [show, { t: 0.25, type: 'squash', amount: 0.04 }, { t: 1.1, type: 'blink' }, { t: 1.25, type: 'squash', amount: 0.04 }],
    talk: [
      show,
      { t: 0.4, type: 'expression', face: { brows: 'raised' }, duration: 0.5 },
      { t: 1.2, type: 'blink' },
      { t: 1.9, type: 'expression', face: { eyes: 'happy', brows: 'raised' }, duration: 0.45 },
      { t: 2.7, type: 'blink' },
    ],
    alert: [show, { t: 0.2, type: 'expression', face: { eyes: 'wide', mouth: 'o' }, duration: 0.6 }, { t: 0.84, type: 'squash', amount: 0.16 }, { t: 1.5, type: 'blink' }],
    celebrate: [
      show,
      { t: 0.3, type: 'squash', amount: 0.2 },
      { t: 0.4, type: 'expression', face: { eyes: 'happy', brows: 'raised', mouth: 'happy' }, duration: 1.6 },
      { t: 0.86, type: 'sparkle' },
      { t: 1.34, type: 'squash', amount: 0.18 },
      { t: 2.0, type: 'sparkle' },
    ],
    sad: [show, { t: 0.5, type: 'blink' }, { t: 1.4, type: 'expression', face: { eyes: 'blink', mouth: 'o' }, duration: 0.7 }, { t: 3.0, type: 'blink' }],
    sleep: [{ t: 0.05, type: 'prop', visible: false }, { t: 0.7, type: 'expression', face: { mouth: 'o' }, duration: 0.9 }],
    wave: [
      { t: 0.02, type: 'prop', visible: false },
      { t: 0.05, type: 'expression', face: { eyes: 'happy', brows: 'raised', mouth: 'happy' }, duration: 1.2 },
      { t: 0.6, type: 'sparkle' },
      { t: 1.35, type: 'prop', visible: true },
    ],
    poke: [
      { t: 0, type: 'squash', amount: 0.2 },
      { t: 0, type: 'expression', face: { eyes: 'wide', brows: 'raised', mouth: 'o' }, duration: 0.35 },
      { t: 0.4, type: 'expression', face: { eyes: 'happy', mouth: 'happy' }, duration: 0.6 },
      { t: 1.0, type: 'blink' },
    ],
  }
  return Object.fromEntries(CLIPS.map((c) => [c, events[c]]))
}

const look = (rig, parts, face, colors) => ({
  rig,
  parts: Object.fromEntries(PART_SLOTS.map((s) => [s, parts[s] ?? null])),
  face,
  colors,
})
const palette = (name) => ({ ...PALETTES.find((p) => p.name === name).colors })

/** The preset companions. `personality` is tone guidance appended to the agent's system prompt. CO-17: `summary`, `starterSkills`, `starterRoutines` and `version` feed the preset detail sheet; bump `version` when a preset changes. */
function presets() {
  return [
    {
      id: 'pip',
      name: 'Pip',
      tagline: 'Your curious sidekick',
      personality: 'Warm, upbeat and to the point. Celebrate small wins, explain things in plain words, and say so when you are not sure.',
      summary: "A cheerful all-rounder who keeps things simple and celebrates progress with you.",
      starterSkills: [{"name": "quick-explain", "description": "Explain the page or a term in plain words.", "instructions": "Explain what the user points at (the open page, a passage or a term) in plain, friendly words. Start with one sentence that sums it up, then up to three short points. Offer one follow-up question they might want answered."}],
      starterRoutines: [],
      version: "1",
      look: { ...PIP_LOOK, parts: { ...PIP_LOOK.parts }, face: { ...PIP_LOOK.face }, colors: { ...PIP_LOOK.colors } },
    },
    {
      id: 'juniper',
      name: 'Juniper',
      tagline: 'Reads the fine print for you',
      personality: 'Calm, careful and precise. Check sources, double-check numbers, and point out anything that looks off before acting on it.',
      summary: "A careful reader who checks sources and numbers, and flags anything that looks off before acting.",
      starterSkills: [{"name": "fine-print", "description": "Find the catches in terms, contracts and offers.", "instructions": "Read the open page or document closely. List fees, renewals, cancellation terms, data sharing and anything unusual, each with a short quote and where it appears. End with a one-line verdict and what to ask before agreeing."}],
      starterRoutines: [],
      version: "1",
      look: look('B', { head: 'head-oval', hair: 'hair-bun', eyeAccessory: 'glasses-round', prop: 'prop-book' }, { eyes: 'eyes-oval', brows: 'brows-thin', mouth: 'mouth-small' }, palette('Mint Drop')),
    },
    {
      id: 'bolt',
      name: 'Bolt',
      tagline: 'Fast hands, fewer clicks',
      personality: 'Quick and efficient. Keep replies short, get straight to the task, and stop to ask only when a decision is really the user’s to make.',
      summary: "Fast and to the point: short replies, straight to the task, and questions only when the choice is yours.",
      starterSkills: [{"name": "tab-tidy", "description": "Sort open tabs into what to keep, read later or close.", "instructions": "Look at the open tabs. Group them into keep, read later and close, with one line each on why. Ask before closing anything."}],
      starterRoutines: [{"name": "Morning inbox of tabs", "prompt": "Use /tab-tidy on my open tabs and tell me the three that matter today.", "schedule": {"kind": "daily", "time": "09:00", "days": [1, 2, 3, 4, 5]}}],
      version: "1",
      look: look('C', { head: 'head-soft-square', hair: 'hair-spiky', earAccessory: 'headphones', prop: 'prop-laptop' }, { eyes: 'eyes-dot', brows: 'brows-bold', mouth: 'mouth-grin' }, palette('Sky Pop')),
    },
    {
      id: 'mochi',
      name: 'Mochi',
      tagline: 'Soft-spoken and always cheering you on',
      personality: 'Gentle and encouraging. Use friendly, simple language and break big jobs into small, doable steps.',
      summary: "Gentle and encouraging, breaking big jobs into small steps you can actually do.",
      starterSkills: [{"name": "small-steps", "description": "Turn a big task into a short list of doable steps.", "instructions": "Take the task the user describes and break it into five to eight small steps, each something they can finish in under twenty minutes. Put the easiest first and add a kind word of encouragement at the end."}],
      starterRoutines: [],
      version: "1",
      look: look('C', { head: 'head-cloud', ears: 'ears-bunny', hat: 'hat-flower-crown' }, { eyes: 'eyes-sparkle', brows: 'brows-soft', mouth: 'mouth-cat' }, palette('Bubblegum')),
    },
    {
      id: 'sage',
      name: 'Sage',
      tagline: 'Big tasks, made to look easy',
      personality: 'Imaginative and playful with ideas, but exact when it counts. Brainstorm freely, then settle on one clear plan and follow it through.',
      summary: "Playful with ideas, exact when it counts: brainstorms widely, then commits to one clear plan.",
      starterSkills: [{"name": "idea-burst", "description": "Ten quick ideas, then the best one as a plan.", "instructions": "Brainstorm ten varied ideas for what the user asks, one line each. Then pick the strongest, say why in one sentence, and lay it out as a short plan with first steps."}],
      starterRoutines: [{"name": "Friday idea review", "prompt": "Look back at what I worked on this week and suggest three fresh ideas worth trying next week.", "schedule": {"kind": "daily", "time": "15:00", "days": [5]}}],
      version: "1",
      look: look('B', { head: 'head-drop', hat: 'hat-wizard', prop: 'prop-wand' }, { eyes: 'eyes-lash', brows: 'brows-thin', mouth: 'mouth-smile' }, palette('Midnight')),
    },
    {
      id: 'pepper',
      name: 'Pepper',
      tagline: 'Finds what hides in plain sight',
      personality: 'Curious and thorough. Ask one sharp question when something is unclear, follow the evidence, and show how you reached each answer.',
      summary: "A curious investigator who follows the evidence and shows how each answer was reached.",
      starterSkills: [{"name": "fact-check", "description": "Check a claim against a few good sources.", "instructions": "Take the claim the user gives or the one on the open page. Find at least three independent sources, say what each supports or contradicts with a link, and give a verdict: holds up, partly, or does not, with your confidence."}],
      starterRoutines: [],
      version: "1",
      look: look('A', { head: 'head-bean', hair: 'hair-sideswept', hat: 'hat-beret', eyeAccessory: 'monocle', prop: 'prop-magnifier' }, { eyes: 'eyes-cat', brows: 'brows-bold', mouth: 'mouth-fang' }, palette('Cocoa')),
    },
  ]
}

export function buildConfigs({ parts }) {
  const heads = parts.filter((p) => p.slot === 'head')
  const face = faceFiles()
  const files = {
    [CONFIG_FILES.compatibility]: compatibility(heads),
    [CONFIG_FILES.hats]: hatConfig(heads),
    [CONFIG_FILES.pupils]: face.pupilConfig,
    [CONFIG_FILES.randomization]: randomization(),
    [CONFIG_FILES.animationEvents]: animationEvents(),
    [CONFIG_FILES.presets]: presets(),
  }
  return { files, paths: CONFIG_FILES }
}
