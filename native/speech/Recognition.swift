/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Recognition for one source. Each utterance is its own request: a short
// silence after speech (or 50 s of audio, inside the server limit) ends it,
// its final is printed, and the next request starts with the next audio.
// Segment times are in session audio time, pauses excluded. When the
// recognizer drops out it reports `interrupted`, starts again by itself, and
// reports `restored` with the next result.
//
// On-device when the language supports it. Other languages send audio to
// Apple's servers to be transcribed (Settings › Transcription says so
// beside them, ST-18).

import AVFoundation
import Foundation
import Speech

/// RMS above this counts as speech (about -36 dBFS, after gain).
private let speechLevel: Float = 0.016
/// Silence after speech that ends an utterance.
private let utteranceGapMs: Double = 800
/// Audio per request, kept under the server's one-minute limit.
private let utteranceMaxMs: Double = 50_000
/// How long an ended utterance has to deliver its final.
private let finalWait: TimeInterval = 2.5

final class Recognizer: NSObject, SFSpeechRecognizerDelegate {
  private final class Utterance {
    let request = SFSpeechAudioBufferRecognitionRequest()
    var task: SFSpeechRecognitionTask?
    /// Session audio time where this request's audio starts.
    let offsetMs: Double
    var audioMs: Double = 0
    var speechAtMs: Double?
    var text = ""
    var startMs: Double = 0
    var endMs: Double = 0
    var done = false
    var finalLine: [String: Any]?
    var heldPartial: [String: Any]?
    /// How sure the recognizer was of the final text (0 to 1), when it says.
    var confidence: Double?

    init(offsetMs: Double) {
      self.offsetMs = offsetMs
    }
  }

  private let session: String
  private let source: String
  private let recognizer: SFSpeechRecognizer
  private let contextualStrings: [String]
  private let queue: DispatchQueue
  private var current: Utterance?
  /// Ended utterances waiting for their finals, oldest first; finals print in this order.
  private var finishing: [Utterance] = []
  private var stopped = false
  private var interrupted = false
  private var failures = 0
  private var restartAt: Date = .distantPast
  private var silenceMs: Double = 0
  private var heardSpeech = false
  private var onIdle: (() -> Void)?
  /// Whether any text was recognised (no-speech is reported otherwise).
  private(set) var heardText = false

  var onDevice: Bool { recognizer.supportsOnDeviceRecognition }

  init?(session: String, source: String, locale: String, contextualStrings: [String]) {
    guard let recognizer = SFSpeechRecognizer(locale: speechLocale(locale)), recognizer.isAvailable else { return nil }
    self.session = session
    self.source = source
    self.recognizer = recognizer
    self.contextualStrings = contextualStrings
    queue = DispatchQueue(label: "com.sennechin.apex.speech.recognizer.\(source)")
    super.init()
    recognizer.delegate = self
  }

  /// One canonical buffer at `atMs` in session audio time, with its RMS after gain.
  func append(_ buffer: AVAudioPCMBuffer, atMs: Double, rms: Float) {
    queue.async { [self] in
      guard !stopped else { return }
      let lengthMs = Double(buffer.frameLength) / framesPerMs
      if current == nil {
        // After repeated failures, wait a little before asking again.
        guard Date() >= restartAt else { return }
        begin(offsetMs: atMs)
      }
      guard let utterance = current else { return }
      utterance.request.append(buffer)
      if rms > speechLevel {
        heardSpeech = true
        silenceMs = 0
        if utterance.speechAtMs == nil { utterance.speechAtMs = utterance.audioMs }
      } else {
        silenceMs += lengthMs
      }
      utterance.audioMs += lengthMs
      if (heardSpeech && silenceMs >= utteranceGapMs) || utterance.audioMs >= utteranceMaxMs { endCurrent() }
    }
  }

  /// Ends the current utterance now (on pause, so what was said is final).
  func cut() {
    queue.async { [self] in endCurrent() }
  }

  /// Stops listening, waits for the last finals (briefly), then calls `done`.
  func finish(_ done: @escaping () -> Void) {
    queue.async { [self] in
      stopped = true
      onIdle = done
      endCurrent()
      flush()
    }
  }

  private func begin(offsetMs: Double) {
    let utterance = Utterance(offsetMs: offsetMs)
    let request = utterance.request
    request.shouldReportPartialResults = true
    request.contextualStrings = contextualStrings
    if #available(macOS 13.0, *) { request.addsPunctuation = true }
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    current = utterance
    heardSpeech = false
    silenceMs = 0
    utterance.task = recognizer.recognitionTask(with: request) { [weak self, utterance] result, error in
      self?.queue.async { self?.handle(utterance, result, error) }
    }
  }

  private func endCurrent() {
    guard let utterance = current else { return }
    current = nil
    heardSpeech = false
    silenceMs = 0
    finishing.append(utterance)
    utterance.request.endAudio()
    queue.asyncAfter(deadline: .now() + finalWait) { [weak self, utterance] in
      guard let self, !utterance.done else { return }
      utterance.task?.cancel()
      self.complete(utterance)
    }
  }

  private func handle(_ utterance: Utterance, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
    guard !utterance.done else { return }
    if let result {
      let text = result.bestTranscription.formattedString
      if !text.isEmpty {
        utterance.text = text
        let segments = result.bestTranscription.segments
        if let first = segments.first, let last = segments.last, last.timestamp + last.duration > 0 {
          utterance.startMs = utterance.offsetMs + first.timestamp * 1000
          utterance.endMs = utterance.offsetMs + (last.timestamp + min(last.duration, wordSecondsMax)) * 1000
        } else {
          utterance.startMs = utterance.offsetMs + (utterance.speechAtMs ?? 0)
          utterance.endMs = utterance.offsetMs + utterance.audioMs
        }
      }
      if interrupted {
        interrupted = false
        emit(["type": "restored", "session": session, "source": source])
      }
      failures = 0
      if result.isFinal {
        // Partial results say 0 for every word: only a final's are real.
        utterance.confidence = Segments.confidence(result.bestTranscription.segments.map { ($0.substring, $0.confidence > 0 ? Double($0.confidence) : nil) })
        complete(utterance)
      } else if !text.isEmpty {
        partial(utterance)
      }
      return
    }
    if let error {
      let code = (error as NSError).code
      // 1110: no speech heard; 216 and 301: cancelled while ending.
      let quiet = stopped || code == 1110 || code == 216 || code == 301
      if !quiet {
        failures += 1
        restartAt = Date().addingTimeInterval(min(8, failures > 2 ? pow(2, Double(failures - 2)) : 0))
        if !interrupted {
          interrupted = true
          emit(["type": "interrupted", "session": session, "source": source])
        }
      }
      complete(utterance)
    }
  }

  private func line(_ type: String, _ utterance: Utterance) -> [String: Any] {
    languageTagged(["type": type, "session": session, "source": source, "text": utterance.text, "startMs": ms(utterance.startMs), "endMs": ms(max(utterance.startMs, utterance.endMs))], locale: recognizer.locale.identifier)
  }

  private func partial(_ utterance: Utterance) {
    let partial = line("partial", utterance)
    if finishing.first === utterance {
      emit(partial)
    } else if utterance === current {
      // An earlier utterance's final must print first.
      if finishing.isEmpty { emit(partial) } else { utterance.heldPartial = partial }
    }
  }

  /// An utterance is over: its text (if any) becomes its final, printed in order.
  private func complete(_ utterance: Utterance) {
    guard !utterance.done else { return }
    utterance.done = true
    if !utterance.text.isEmpty {
      utterance.finalLine = sure(line("final", utterance), utterance.confidence)
      heardText = true
    }
    if utterance === current {
      current = nil
      finishing.append(utterance)
    }
    flush()
  }

  private func flush() {
    while let first = finishing.first, first.done {
      if let final = first.finalLine { emit(final) }
      finishing.removeFirst()
    }
    if finishing.isEmpty, let held = current?.heldPartial {
      emit(held)
      current?.heldPartial = nil
    }
    if stopped, finishing.isEmpty, current == nil, let done = onIdle {
      onIdle = nil
      done()
    }
  }

  func speechRecognizer(_ speechRecognizer: SFSpeechRecognizer, availabilityDidChange available: Bool) {
    queue.async { [self] in
      guard !stopped else { return }
      if !available, !interrupted {
        interrupted = true
        emit(["type": "interrupted", "session": session, "source": source])
      } else if available, interrupted {
        interrupted = false
        emit(["type": "restored", "session": session, "source": source])
      }
    }
  }
}
