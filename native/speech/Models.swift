/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The newer engine's language models (macOS 26). SpeechTranscriber needs a
// model per language on this Mac. Atelier installs it the first time a language
// is used, or when Settings › Transcription asks, and reports the progress
// as `assets` lines so Settings can say "Preparing…" and then "ready":
//   {"type":"assets","locale":"en-US","state":"downloading","fraction":0.42}
// States: unavailable (no newer engine on this Mac), unsupported (not for
// this language), supported (not installed yet), downloading, installed,
// failed. Until a model is ready the older engine listens instead.

import Foundation
import Speech

/// One `assets` line; `locale` is echoed as Atelier sent it (BCP-47).
func emitAssets(_ locale: String, _ state: String, _ fraction: Double?) {
  emit(["type": "assets", "locale": bcp47(locale), "state": state, "fraction": orNull(fraction.map { min(1, max(0, $0)) })])
}

/// Locale ids compared without case or separator differences.
func localeKey(_ id: String) -> String {
  bcp47(id).lowercased()
}

@available(macOS 26.0, *)
enum ModernSpeech {
  /// The newer engine runs here (ATELIER_SPEECH_ENGINE=legacy keeps the older one, for comparing).
  static var enabled: Bool {
    ProcessInfo.processInfo.environment["ATELIER_SPEECH_ENGINE"] != "legacy" && SpeechTranscriber.isAvailable
  }

  /// The transcriber Atelier runs: volatile results while live (faster ones for
  /// dictation), and every word's audio time for segment times.
  static func transcriber(_ locale: Locale, live: Bool, dictation: Bool = false) -> SpeechTranscriber {
    var reporting: Set<SpeechTranscriber.ReportingOption> = []
    if live { reporting.insert(.volatileResults) }
    if dictation { reporting.insert(.fastResults) }
    return SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: reporting, attributeOptions: [.audioTimeRange, .transcriptionConfidence])
  }

  /// The model's state for `locale` (asked with the live transcriber Atelier runs).
  static func status(_ locale: Locale) async -> AssetInventory.Status {
    await AssetInventory.status(forModules: [transcriber(locale, live: true)])
  }

  /// The locale to run the newer engine in, once its model is on this Mac.
  /// Starts installing it when it isn't, and waits up to `wait` seconds for
  /// that; nil means the older engine listens this time.
  static func ready(_ id: String, wait: Double) async -> Locale? {
    guard let locale = await ModelCatalog.shared.locale(for: id) else { return nil }
    if await status(locale) == .installed { return locale }
    let install = await ModelCatalog.shared.install(locale, id: id)
    let done = await race(seconds: wait) { await install.value }
    return done == true ? locale : nil
  }

  /// Answers `prepare`: the state of `id`'s model, and with `install` starts installing it.
  static func prepare(_ id: String, install: Bool) async {
    guard let locale = await ModelCatalog.shared.locale(for: id) else { return emitAssets(id, "unsupported", nil) }
    if let fraction = await ModelCatalog.shared.installing(id) { return emitAssets(id, "downloading", fraction) }
    let status = await status(locale)
    switch status {
    case .installed:
      emitAssets(id, "installed", 1)
    case .supported, .downloading:
      if install {
        // The install's own lines answer: downloading, then installed or failed.
        _ = await ModelCatalog.shared.install(locale, id: id)
      } else {
        emitAssets(id, status == .downloading ? "downloading" : "supported", nil)
      }
    case .unsupported:
      emitAssets(id, "unsupported", nil)
    @unknown default:
      emitAssets(id, "unsupported", nil)
    }
  }
}

/// The newer engine's languages and the installs running, one of each per language.
@available(macOS 26.0, *)
actor ModelCatalog {
  static let shared = ModelCatalog()
  private var supported: [Locale]?
  private var installs: [String: Task<Bool, Never>] = [:]
  private var fractions: [String: Double] = [:]

  func supportedLocales() async -> [Locale] {
    if let supported { return supported }
    let list = await SpeechTranscriber.supportedLocales
    supported = list
    return list
  }

  /// The supported locale for `id`. Not `supportedLocale(equivalentTo:)`: it
  /// answers for languages the engine can't transcribe (Dutch, on macOS 26).
  func locale(for id: String) async -> Locale? {
    let want = localeKey(id)
    return await supportedLocales().first { localeKey($0.identifier(.bcp47)) == want }
  }

  /// The progress of a running install for `id`, or nil.
  func installing(_ id: String) -> Double? {
    let key = localeKey(id)
    return installs[key] == nil ? nil : (fractions[key] ?? 0)
  }

  /// Starts installing `locale`'s model, or joins the install already running; true once it is in place.
  func install(_ locale: Locale, id: String) -> Task<Bool, Never> {
    let key = localeKey(id)
    if let running = installs[key] { return running }
    fractions[key] = 0
    let task = Task.detached { await ModelCatalog.download(locale, id: id) }
    installs[key] = task
    Task {
      _ = await task.value
      self.ended(key)
    }
    return task
  }

  private func ended(_ key: String) {
    installs[key] = nil
    fractions[key] = nil
  }

  fileprivate func note(_ id: String, _ fraction: Double) {
    fractions[localeKey(id)] = fraction
  }

  private static func download(_ locale: Locale, id: String) async -> Bool {
    do {
      await reserve(locale)
      guard let request = try await AssetInventory.assetInstallationRequest(supporting: [ModernSpeech.transcriber(locale, live: true)]) else {
        emitAssets(id, "installed", 1)
        return true
      }
      let progress = request.progress
      emitAssets(id, "downloading", progress.fractionCompleted)
      let ticker = Task {
        var last = progress.fractionCompleted
        while !Task.isCancelled {
          try? await Task.sleep(nanoseconds: 500_000_000)
          let now = progress.fractionCompleted
          guard !Task.isCancelled, now - last >= 0.01 else { continue }
          last = now
          await ModelCatalog.shared.note(id, now)
          emitAssets(id, "downloading", now)
        }
      }
      defer { ticker.cancel() }
      try await request.downloadAndInstall()
      emitAssets(id, "installed", 1)
      return true
    } catch {
      emitAssets(id, "failed", nil)
      return false
    }
  }

  /// Atelier may hold a few languages; the oldest gives way to a new one.
  private static func reserve(_ locale: Locale) async {
    let key = localeKey(locale.identifier(.bcp47))
    let reserved = await AssetInventory.reservedLocales
    if reserved.contains(where: { localeKey($0.identifier(.bcp47)) == key }) { return }
    if reserved.count >= AssetInventory.maximumReservedLocales, let oldest = reserved.first {
      await AssetInventory.release(reservedLocale: oldest)
    }
    _ = try? await AssetInventory.reserve(locale: locale)
  }
}

/// `prepare`: { "cmd": "prepare", "locale": "en-US", "install": false }.
func prepareSpeech(_ json: [String: Any]) {
  guard let id = json["locale"] as? String, !id.isEmpty else {
    emitError(.invalid, "The prepare command is incomplete.", fatal: false)
    return
  }
  let install = (json["install"] as? Bool) ?? false
  guard #available(macOS 26.0, *), ModernSpeech.enabled else { return emitAssets(id, "unavailable", nil) }
  Task { await ModernSpeech.prepare(id, install: install) }
}

extension Locales {
  /// Prints the report; on macOS 26 it marks the languages the newer engine handles.
  static func send() {
    guard #available(macOS 26.0, *), ModernSpeech.enabled else { return emit(report()) }
    Task {
      let found = await race(seconds: 2) { () async -> ([String], [String]) in
        let supported = await ModelCatalog.shared.supportedLocales().map { $0.identifier(.bcp47) }
        let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }
        return (supported, installed)
      }
      emit(report(analyzer: found?.0 ?? [], installed: found?.1 ?? []))
    }
  }
}
