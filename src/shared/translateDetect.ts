/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The page language (TR-02): a small on-device detector, and how its guess
// is weighed against what the page declares. Writing systems settle most
// languages at once (kana is Japanese, Hangul Korean, a few letters tell
// Ukrainian from Russian); Latin-script languages are told apart by their
// most common short words. Nothing leaves the computer. On macOS main can
// ask Apple's NaturalLanguage through the translate helper when this one is unsure.
import { canonicalTag } from './languages'
import { languageKey, type PageLanguageHints } from './translate'

export interface Detection {
  language: string | null
  /** 0 to 1. */
  confidence: number
  /** Confident enough to overrule what the page declares. */
  reliable: boolean
}

const NONE: Detection = { language: null, confidence: 0, reliable: false }

/** Single-script languages: the share of letters in a script names the language. */
const SCRIPTS: Array<{ re: RegExp; language: string }> = [
  { re: /[぀-ヿ]/gu, language: 'ja' },
  { re: /[가-힯ᄀ-ᇿ]/gu, language: 'ko' },
  { re: /[Ͱ-Ͽ]/gu, language: 'el' },
  { re: /[֐-׿]/gu, language: 'he' },
  { re: /[฀-๿]/gu, language: 'th' },
  { re: /[ऀ-ॿ]/gu, language: 'hi' },
  { re: /[ঀ-৿]/gu, language: 'bn' },
  { re: /[਀-੿]/gu, language: 'pa' },
  { re: /[઀-૿]/gu, language: 'gu' },
  { re: /[஀-௿]/gu, language: 'ta' },
  { re: /[ఀ-౿]/gu, language: 'te' },
  { re: /[ಀ-೿]/gu, language: 'kn' },
  { re: /[ഀ-ൿ]/gu, language: 'ml' },
  { re: /[Ⴀ-ჿ]/gu, language: 'ka' },
  { re: /[԰-֏]/gu, language: 'hy' },
  { re: /[ក-៿]/gu, language: 'km' },
  { re: /[຀-໿]/gu, language: 'lo' },
  { re: /[က-႟]/gu, language: 'my' },
  { re: /[඀-෿]/gu, language: 'si' },
  { re: /[ሀ-፿]/gu, language: 'am' },
]

const HAN = /[一-鿿㐀-䶿]/gu
const CYRILLIC = /[Ѐ-ӿ]/gu
const ARABIC = /[؀-ۿݐ-ݿ]/gu
const LATIN = /[A-Za-zÀ-ɏ]/gu

/** Characters common in one Chinese script and absent from the other. */
const TRADITIONAL_ONLY = /[這們個來說時會對國學與為後過發還開關問題實經裡麼樣種從現點應義讓體電腦網頁]/gu
const SIMPLIFIED_ONLY = /[这们个来说时会对国学与为后过发还开关问题实经里么样种从现点应义让体电脑网页]/gu

/** The most common short words of each Latin-script language, Atelier's own lists. */
const STOPWORDS: Record<string, string> = {
  en: 'the and of to in is that for it with as was on are be this by have from or not but at you an they which we his her their has been were will would can all there what',
  fr: 'le la les de des du et est un une pour dans que qui sur pas au aux avec par plus ce cette sont nous vous il elle ils ne se son sa ses ou mais été être',
  de: 'der die das und ist nicht ein eine zu den von mit sich des auf für im dem auch es an als wie wir ich sie er bei aus oder werden wird sind hat kann noch',
  es: 'el la los las de del y en que un una por para con no es se su sus al lo como más pero o este esta son fue ha muy también sobre entre cuando',
  it: 'il lo la gli le di del della e è un una per che non con si da al in sono come più ma anche questo questa nel alla dei delle ha essere',
  pt: 'o a os as de do da dos das e em um uma para com não que se por mais como mas foi ao no na nos nas é são também seu sua está ser tem',
  nl: 'de het een en van in is dat op te zijn voor met niet aan er die ook als maar om bij of door wordt dit nog worden kan heeft naar wat zich',
  sv: 'och att det som en på är av för med till den inte har de ett om var men så kan jag vi från eller hade sig vid när där också ska',
  da: 'og at det som en på er af for med til den ikke har de et om var men så kan jeg vi fra eller havde sig ved når der også skal være',
  nb: 'og at det som en på er av for med til den ikke har de et om var men så kan jeg vi fra eller hadde seg ved når der også skal være',
  fi: 'ja on ei se että oli hän mutta kun tai niin myös kuin ovat mukaan sen jos ole sekä vain joka voi olla nyt tämä siitä hänen',
  pl: 'i w nie na się z do że jest to o jak co po ale tak za od przez jego są czy już dla tym być może także jej tylko',
  cs: 'a v se na je že to s z do o i jako ale jsou pro by k jeho podle který která které také bylo již jen při ve není',
  hu: 'a az és hogy nem is egy van meg de ez azt ami mint csak már volt el kell még vagy minden lesz után most ki',
  ro: 'și în de la nu cu o pe un din că este se care sunt mai pentru ce sau dar fost au fi lui acest această',
  tr: 've bir bu da de için ile çok gibi daha ne olarak ama en kadar sonra var olan değil mi ya her şey ben',
  id: 'yang dan di ini itu dengan untuk dari tidak dalam akan pada ada juga ke atau bisa karena oleh saya mereka sudah lebih',
  vi: 'và của là có không được trong cho các một những với này người đã để khi đến từ cũng như về',
  ca: 'el la els les de del i en que un una per amb no és es seu seva al com més però o aquest aquesta són va',
  hr: 'i je u se na da za su od s a koji koja kao ali iz to što bi će biti ne sam ili samo',
  sl: 'in je v se na da za so pa z ki od tudi kot ali bi to ne sem biti še le po',
  et: 'ja on ei et see oli ta kui aga ka või mis nii oma seda kes siis tema ning',
  lt: 'ir yra kad bet tai su į ne kaip jo jau iš buvo taip savo už apie arba',
  lv: 'un ir ka ar par no uz tas bet arī kā vai lai to jau pie viņš bija',
  sk: 'a v sa na je že to s z do o ako ale sú pre by k jeho podľa ktorý ktorá ktoré tiež bolo už len pri',
}

const STOPWORD_SETS: Array<[string, Set<string>]> = Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words.split(' '))])

/** Letters that only a few Latin-script languages use, as a tie-breaker. */
const MARKS: Array<[RegExp, string]> = [
  [/[ßäöü]/gu, 'de'],
  [/[ãõç]/gu, 'pt'],
  [/[ñ¿¡]/gu, 'es'],
  [/[ąęłńśźż]/gu, 'pl'],
  [/[ěřůč]/gu, 'cs'],
  [/[őű]/gu, 'hu'],
  [/[șțăâî]/gu, 'ro'],
  [/[ğış]/gu, 'tr'],
  [/[ơưđạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gu, 'vi'],
  [/[åæø]/gu, 'nb'],
  [/[õäöü]/gu, 'et'],
  [/[ėįųū]/gu, 'lt'],
  [/[āēīūņļķģ]/gu, 'lv'],
  [/[ľĺŕôä]/gu, 'sk'],
]

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0

function cyrillic(text: string): string {
  if (count(text, /[іїєґ]/giu) > 0) return 'uk'
  if (count(text, /[ђћџљњј]/giu) > 0) return 'sr'
  if (count(text, /[ѓќѕ]/giu) > 0) return 'mk'
  if (count(text, /[ыэ]/giu) === 0 && count(text, /ъ/giu) > 2) return 'bg'
  return 'ru'
}

function arabic(text: string): string {
  if (count(text, /[ٹڈڑےں]/gu) > 2) return 'ur'
  if (count(text, /[پچژگ]/gu) > 2 || count(text, /ی/gu) > count(text, /ي/gu) * 2 + 2) return 'fa'
  return 'ar'
}

function latin(text: string): Detection {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? []
  if (words.length < 6) return NONE
  const scores = STOPWORD_SETS.map(([lang, set]) => {
    let hits = 0
    for (const w of words) if (set.has(w)) hits++
    let marks = 0
    for (const [re, l] of MARKS) if (l === lang) marks += count(text, re)
    return { lang, score: hits / words.length + Math.min(0.08, marks / words.length) }
  }).sort((a, b) => b.score - a.score)
  const [best, second] = scores
  if (!best || best.score < 0.06) return NONE
  const margin = best.score - (second?.score ?? 0)
  const confidence = Math.min(1, best.score + margin * 2.5)
  return { language: best.lang, confidence, reliable: words.length >= 20 && best.score >= 0.12 && margin >= best.score * 0.25 }
}

/** The language of a stretch of text, or null when there is too little to tell. */
export function detectLanguage(text: string): Detection {
  const sample = text.slice(0, 20_000)
  const letters = count(sample, /\p{L}/gu)
  if (letters < 20) return NONE
  const share = (n: number): number => n / letters
  for (const { re, language } of SCRIPTS) {
    const s = share(count(sample, re))
    // Japanese mixes kana with Han: a little kana is enough.
    // A kana or Hangul character carries about a word: fewer of them say as much.
    if (s >= (language === 'ja' ? 0.1 : 0.4)) return { language, confidence: Math.min(1, s + 0.3), reliable: letters >= (language === 'ja' || language === 'ko' ? 15 : 30) }
  }
  const han = share(count(sample, HAN))
  if (han >= 0.4) {
    const language = count(sample, TRADITIONAL_ONLY) > count(sample, SIMPLIFIED_ONLY) ? 'zh-TW' : 'zh-CN'
    return { language, confidence: Math.min(1, han + 0.3), reliable: letters >= 15 }
  }
  const cyr = share(count(sample, CYRILLIC))
  if (cyr >= 0.4) return { language: cyrillic(sample), confidence: Math.min(1, cyr + 0.2), reliable: letters >= 60 }
  const arab = share(count(sample, ARABIC))
  if (arab >= 0.4) return { language: arabic(sample), confidence: Math.min(1, arab + 0.2), reliable: letters >= 60 }
  if (share(count(sample, LATIN)) >= 0.5) return latin(sample)
  return NONE
}

/** 'fr_FR' and 'fr-fr' → 'fr-FR'; the first of a comma list; null for anything else. */
export function hintTag(value: string | null | undefined): string | null {
  if (!value) return null
  const first = value.split(',')[0]?.trim().replace(/_/g, '-') ?? ''
  return first ? canonicalTag(first) : null
}

/**
 * The page's language: what it declares (<html lang>, then the
 * content-language meta, then og:locale), unless the detector is sure of
 * another language (templates often say lang="en" whatever they hold); the
 * detector's guess when nothing is declared. Null when neither can tell.
 */
export function pageLanguage(hints: Pick<PageLanguageHints, 'declared' | 'contentLanguage' | 'ogLocale'>, detected: Detection): string | null {
  const declared = hintTag(hints.declared) ?? hintTag(hints.contentLanguage) ?? hintTag(hints.ogLocale)
  const declaredKey = languageKey(declared)
  if (detected.reliable && detected.language && languageKey(detected.language) !== declaredKey) return detected.language
  if (declaredKey) return declared
  return detected.language && detected.confidence >= 0.35 ? detected.language : null
}
