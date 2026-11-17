/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex-translate: Apex's on-device page translation helper (TR-05). Apex
// starts it when a page is first translated and keeps it running while it is
// in use. It reads one JSON request per line on stdin and answers each with
// one JSON line on stdout (src/main/translate/helper.ts checks them with zod):
//
//   {"id":N,"op":"status","source":"fr","target":"en"}
//       {"id":N,"type":"status","status":"installed"|"supported"|"unsupported"|"unavailable"}
//   {"id":N,"op":"translate","source":"fr","target":"en","texts":["…"]}
//       {"id":N,"type":"result","texts":["…"]}            (same order and length)
//   {"id":N,"op":"detect","text":"…"}
//       {"id":N,"type":"detect","language":"fr"|null,"confidence":0.0…1.0}
//
// A failure answers {"id":N,"type":"error","code":C,"message":"…"}, C being
// not-installed, unsupported, unavailable, failed or bad-request. Everything
// stays on this Mac: Apple's Translation framework (macOS 26 for a session
// outside SwiftUI) and NaturalLanguage for detection. It exits when stdin closes.

import Foundation
import NaturalLanguage
import Translation

/// Texts one request may carry, and characters per text (TRANSLATE_BATCH_* on the TypeScript side).
let textsMax = 128
let textMax = 5000
let detectMax = 4000

let output = DispatchQueue(label: "apex.translate.output")

func emit(_ object: [String: Any]) {
  output.sync {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
  }
}

func fail(_ id: Int, _ code: String, _ message: String) {
  emit(["id": id, "type": "error", "code": code, "message": message])
}

/// A BCP-47 tag Apex sent; anything else is refused before it reaches the framework.
func validTag(_ value: Any?) -> String? {
  guard let tag = value as? String, tag.count >= 2, tag.count <= 35,
        tag.range(of: "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$", options: .regularExpression) != nil else { return nil }
  return tag
}

@available(macOS 15.0, *)
func statusName(_ status: LanguageAvailability.Status) -> String {
  switch status {
  case .installed: return "installed"
  case .supported: return "supported"
  case .unsupported: return "unsupported"
  @unknown default: return "unsupported"
  }
}

/// One session per language pair, made once and reused (the models stay loaded while Apex translates).
final class Sessions: @unchecked Sendable {
  /// TranslationSession values; typed as AnyObject so the store itself needs no availability.
  private var cache: [String: AnyObject] = [:]
  private let lock = NSLock()

  @available(macOS 26.0, *)
  func session(_ source: String, _ target: String) -> TranslationSession {
    lock.lock()
    defer { lock.unlock() }
    let key = "\(source)>\(target)"
    if let existing = cache[key] as? TranslationSession { return existing }
    let made = TranslationSession(installedSource: Locale.Language(identifier: source), target: Locale.Language(identifier: target))
    cache[key] = made
    return made
  }

  func drop(_ source: String, _ target: String) {
    lock.lock()
    defer { lock.unlock() }
    cache.removeValue(forKey: "\(source)>\(target)")
  }
}

let sessions = Sessions()

func status(_ id: Int, _ source: String, _ target: String) {
  guard #available(macOS 15.0, *) else {
    emit(["id": id, "type": "status", "status": "unavailable"])
    return
  }
  Task {
    let found = await LanguageAvailability().status(from: Locale.Language(identifier: source), to: Locale.Language(identifier: target))
    // A session outside SwiftUI needs macOS 26: before it, an installed pair still cannot be used here.
    if #available(macOS 26.0, *) {
      emit(["id": id, "type": "status", "status": statusName(found)])
    } else {
      emit(["id": id, "type": "status", "status": found == .unsupported ? "unsupported" : "unavailable"])
    }
  }
}

func translate(_ id: Int, _ source: String, _ target: String, _ texts: [String]) {
  guard #available(macOS 26.0, *) else {
    fail(id, "unavailable", "On-device translation needs macOS 26 or later.")
    return
  }
  Task {
    let found = await LanguageAvailability().status(from: Locale.Language(identifier: source), to: Locale.Language(identifier: target))
    if found == .unsupported {
      fail(id, "unsupported", "This Mac cannot translate between these languages.")
      return
    }
    if found == .supported {
      fail(id, "not-installed", "The languages are not downloaded yet.")
      return
    }
    // Blank texts stay as they are; the framework refuses them.
    var result = texts
    let requests = texts.enumerated().compactMap { index, text -> TranslationSession.Request? in
      text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : TranslationSession.Request(sourceText: text, clientIdentifier: String(index))
    }
    if requests.isEmpty {
      emit(["id": id, "type": "result", "texts": result])
      return
    }
    do {
      let responses = try await sessions.session(source, target).translations(from: requests)
      for response in responses {
        if let key = response.clientIdentifier, let index = Int(key), index >= 0, index < result.count {
          result[index] = response.targetText
        }
      }
      emit(["id": id, "type": "result", "texts": result])
    } catch {
      sessions.drop(source, target)
      if TranslationError.notInstalled ~= error {
        fail(id, "not-installed", "The languages are not downloaded yet.")
      } else if TranslationError.unsupportedLanguagePairing ~= error || TranslationError.unsupportedSourceLanguage ~= error || TranslationError.unsupportedTargetLanguage ~= error {
        fail(id, "unsupported", "This Mac cannot translate between these languages.")
      } else {
        fail(id, "failed", String(describing: error).prefix(300).description)
      }
    }
  }
}

func detect(_ id: Int, _ text: String) {
  let recognizer = NLLanguageRecognizer()
  recognizer.processString(String(text.prefix(detectMax)))
  guard let best = recognizer.languageHypotheses(withMaximum: 1).max(by: { $0.value < $1.value }), best.key != .undetermined else {
    emit(["id": id, "type": "detect", "language": NSNull(), "confidence": 0])
    return
  }
  emit(["id": id, "type": "detect", "language": best.key.rawValue, "confidence": best.value])
}

func handle(_ line: String) {
  guard let data = line.data(using: .utf8),
        let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let id = request["id"] as? Int else { return }
  switch request["op"] as? String {
  case "status":
    guard let source = validTag(request["source"]), let target = validTag(request["target"]) else { return fail(id, "bad-request", "Languages are missing.") }
    status(id, source, target)
  case "translate":
    guard let source = validTag(request["source"]), let target = validTag(request["target"]),
          let texts = request["texts"] as? [String], texts.count <= textsMax, texts.allSatisfy({ $0.count <= textMax }) else {
      return fail(id, "bad-request", "The request isn’t one this helper understands.")
    }
    translate(id, source, target, texts)
  case "detect":
    guard let text = request["text"] as? String else { return fail(id, "bad-request", "Text is missing.") }
    detect(id, text)
  default:
    fail(id, "bad-request", "Unknown request.")
  }
}

Thread {
  while let line = readLine(strippingNewline: true) {
    if !line.isEmpty { handle(line) }
  }
  exit(0)
}.start()

dispatchMain()
