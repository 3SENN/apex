/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Bilingual listening (two languages at once): every transcript line says
// which language it was heard in, and a final says how well its text reads
// as that language. Apex keeps, for each stretch of speech, the language
// whose text fits best (src/main/speech/bilingual.ts). Apple's language
// recognizer runs on this Mac.

import Foundation
import NaturalLanguage

enum LanguageFit {
  /// The NaturalLanguage language for a speech locale ("nl-NL" → .dutch, "zh-TW" → traditional Chinese).
  static func language(_ locale: String) -> NLLanguage {
    let parts = locale.replacingOccurrences(of: "_", with: "-").split(separator: "-").map(String.init)
    let code = parts.first?.lowercased() ?? ""
    switch code {
    case "zh", "yue":
      let traditional = code == "yue" || parts.contains { ["TW", "HK", "MO", "Hant"].contains($0) }
      return traditional ? .traditionalChinese : .simplifiedChinese
    case "no", "nn":
      return .norwegian
    default:
      return NLLanguage(rawValue: code)
    }
  }

  /// 0 to 1: how likely `text` is in `locale`'s language. A few words say little, so very short texts stay near the middle.
  static func score(_ text: String, locale: String) -> Double {
    let words = text.split(whereSeparator: { $0.isWhitespace }).count
    guard words > 0 else { return 0 }
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    let p = recognizer.languageHypotheses(withMaximum: 10)[language(locale)] ?? 0
    // One or two words: blend towards 0.5 so a lucky guess can't outweigh a sentence.
    let weight = min(1, Double(words) / 3)
    return (p * weight + 0.5 * (1 - weight) * (p > 0 ? 1 : 0.4)).rounded(toPlaces: 3)
  }
}

private extension Double {
  func rounded(toPlaces places: Int) -> Double {
    let scale = pow(10, Double(places))
    return (self * scale).rounded() / scale
  }
}

/// The longest a single word may last when a line's end is worked out. The
/// older recognizer gives the last word it knows the time of whatever it
/// couldn't follow after it (another language), which would stretch the line
/// over speech that isn't its own.
let wordSecondsMax: Double = 1.2

/// A final with how sure its recognizer was of it, when it says.
func sure(_ line: [String: Any], _ confidence: Double?) -> [String: Any] {
  guard let confidence else { return line }
  var out = line
  out["confidence"] = confidence
  return out
}

/// A partial or final with the language it was heard in (and, for a final, its fit).
func languageTagged(_ line: [String: Any], locale: String) -> [String: Any] {
  var out = line
  out["locale"] = bcp47(locale)
  if line["type"] as? String == "final", let text = line["text"] as? String { out["fit"] = LanguageFit.score(text, locale: locale) }
  return out
}
