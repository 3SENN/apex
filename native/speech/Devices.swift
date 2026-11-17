/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Audio inputs and recognition languages, for Settings › Transcription.

import AVFoundation
import CoreAudio
import Foundation
import Speech

enum Devices {
  static func inputs() -> [AVCaptureDevice] {
    var types: [AVCaptureDevice.DeviceType] = [.builtInMicrophone, .externalUnknown]
    if #available(macOS 14.0, *) { types = [.microphone, .external] }
    return AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .audio, position: .unspecified).devices
  }

  /// The Mac's own microphone. The device type can't tell (since macOS 14 every
  /// microphone, an iPhone's included, has the same type), the transport can.
  static func isBuiltIn(_ device: AVCaptureDevice) -> Bool {
    device.transportType == Int32(bitPattern: kAudioDeviceTransportTypeBuiltIn) || device.uniqueID == "BuiltInMicrophoneDevice"
  }

  /// The device to record from: the requested one, or the system default when it is gone.
  static func pick(_ id: String?) -> (device: AVCaptureDevice?, fallback: Bool) {
    if let id {
      if let device = AVCaptureDevice(uniqueID: id) { return (device, false) }
      return (AVCaptureDevice.default(for: .audio), true)
    }
    return (AVCaptureDevice.default(for: .audio), false)
  }

  static func report() -> [String: Any] {
    let defaultId = AVCaptureDevice.default(for: .audio)?.uniqueID
    let items: [[String: Any]] = inputs().map { device in
      ["id": device.uniqueID, "name": device.localizedName, "builtIn": isBuiltIn(device), "isDefault": device.uniqueID == defaultId]
    }
    return ["type": "devices", "items": items]
  }
}

enum Locales {
  /// Every language the recognizer supports, marked when it runs on this Mac.
  /// The others send audio to Apple's servers to be transcribed (ST-18).
  /// `analyzer` lists the languages macOS 26's newer engine handles (each
  /// item says which engine Atelier uses); one whose model is `installed`
  /// counts as on this Mac too (Models.swift).
  static func report(analyzer: [String] = [], installed: [String] = []) -> [String: Any] {
    let names = Locale.current
    let newer = Set(analyzer.map(localeKey))
    let ready = Set(installed.map(localeKey))
    var seen = Set<String>()
    var items: [[String: Any]] = SFSpeechRecognizer.supportedLocales()
      .map { locale -> [String: Any] in
        let id = bcp47(locale.identifier)
        let key = localeKey(id)
        seen.insert(key)
        let onDevice = (SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition ?? false) || ready.contains(key)
        return ["id": id, "name": names.localizedString(forIdentifier: locale.identifier) ?? id, "onDevice": onDevice, "engine": newer.contains(key) ? "analyzer" : "recognizer"]
      }
    for id in analyzer where !seen.contains(localeKey(id)) {
      seen.insert(localeKey(id))
      items.append(["id": bcp47(id), "name": names.localizedString(forIdentifier: id) ?? bcp47(id), "onDevice": ready.contains(localeKey(id)), "engine": "analyzer"])
    }
    items.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    return ["type": "locales", "system": bcp47(systemLocale()), "items": items]
  }

  /// The system language with its region, as the recognizer names it.
  static func systemLocale() -> String {
    let preferred = Locale.preferredLanguages.first.map { Locale(identifier: $0) } ?? Locale.current
    let language = preferred.languageCode ?? "en"
    let region = preferred.regionCode ?? Locale.current.regionCode
    return region.map { "\(language)_\($0)" } ?? language
  }
}
