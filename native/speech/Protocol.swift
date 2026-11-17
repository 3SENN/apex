/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The JSON-lines protocol Apex speaks with this helper (version 2; the
// TypeScript side is src/shared/speech.ts and
// src/main/speech/protocol.ts). One command per line on stdin, one event per
// line on stdout. Apex ignores lines it doesn't know, so a new event type
// needs no version bump; a changed meaning does.

import Foundation

let protocolVersion = 2

/// Stable error codes Apex maps to its own copy (HelperErrorCode).
enum HelperError: String {
  case micDenied = "mic-denied"
  case speechDenied = "speech-denied"
  case screenDenied = "screen-denied"
  case micBusy = "mic-busy"
  case deviceMissing = "device-missing"
  case localeUnsupported = "locale-unsupported"
  case noSpeech = "no-speech"
  case recordingFailed = "recording-failed"
  case busy = "busy"
  case invalid = "invalid"
  case failed = "failed"
}

private let outputLock = NSLock()

/// Prints one event line. Safe from any thread.
func emit(_ object: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(object),
        let data = try? JSONSerialization.data(withJSONObject: object),
        let line = String(data: data, encoding: .utf8) else { return }
  outputLock.lock()
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
  outputLock.unlock()
}

func emitError(session: String? = nil, source: String? = nil, _ code: HelperError, _ message: String, fatal: Bool) {
  var line: [String: Any] = ["type": "error", "code": code.rawValue, "message": message, "fatal": fatal]
  if let session { line["session"] = session }
  if let source { line["source"] = source }
  emit(line)
}

/// JSON null, or the value.
func orNull(_ value: Any?) -> Any {
  value ?? NSNull()
}

/// Milliseconds, rounded, as JSON wants them.
func ms(_ value: Double) -> Int {
  max(0, Int(value.rounded()))
}

/// Everything `start` carries.
struct StartOptions {
  let session: String
  let meeting: Bool
  let locale: String
  /// Bilingual: a second language listened to at the same time (Language.swift).
  let secondaryLocale: String?
  let deviceId: String?
  let contextualStrings: [String]
  let micGain: Float
  let systemGain: Float
  let transcribe: Bool
  let levels: Bool
  let recordPath: String?
  /// A desktop call: only these apps' sound is the other side (bundle ids, helpers included).
  let apps: [String]

  init?(_ json: [String: Any]) {
    guard let session = json["session"] as? String, !session.isEmpty,
          let mode = json["mode"] as? String, mode == "dictation" || mode == "meeting",
          let locale = json["locale"] as? String, !locale.isEmpty else { return nil }
    self.session = session
    meeting = mode == "meeting"
    self.locale = locale
    secondaryLocale = (json["secondaryLocale"] as? String).flatMap { $0.isEmpty || $0 == locale ? nil : $0 }
    deviceId = json["deviceId"] as? String
    contextualStrings = Array(((json["contextualStrings"] as? [String]) ?? []).prefix(100))
    micGain = StartOptions.gain(json["micGain"])
    systemGain = StartOptions.gain(json["systemGain"])
    transcribe = (json["transcribe"] as? Bool) ?? true
    levels = (json["levels"] as? Bool) ?? false
    recordPath = (json["record"] as? [String: Any])?["path"] as? String
    apps = Array(((json["apps"] as? [String]) ?? []).filter { !$0.isEmpty }.prefix(32))
  }

  /// Sensitivity from Settings, kept to 0.25 to 4 whatever arrives.
  private static func gain(_ value: Any?) -> Float {
    guard let number = value as? NSNumber else { return 1 }
    let gain = number.floatValue
    return gain.isFinite ? min(4, max(0.25, gain)) : 1
  }
}

/// The locale Apple's recognizer wants: "en-US" and "en_US" both work as identifiers.
func speechLocale(_ id: String) -> Locale {
  Locale(identifier: id.replacingOccurrences(of: "-", with: "_"))
}

/// BCP-47 with a hyphen, as Apex stores it.
func bcp47(_ identifier: String) -> String {
  identifier.replacingOccurrences(of: "_", with: "-")
}
