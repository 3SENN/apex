/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-speech: Atelier's macOS speech helper, protocol v2 (see Protocol.swift).
//
// Recognition runs on this Mac for languages that support on-device
// recognition. Languages without it send audio to Apple's servers to be
// transcribed; Settings › Transcription marks which are which (ST-18).
// Recordings are written only where Atelier asks, and stay on this Mac.
//
// The helper never prompts on its own: `start` fails fast with an error code
// when a permission is missing, and prompts follow a `request` command only.

import Foundation

let controller = Controller()
var pendingInput = Data()

DispatchQueue.main.async { startObservers() }

FileHandle.standardInput.readabilityHandler = { handle in
  let data = handle.availableData
  if data.isEmpty {
    // Atelier went away: stop cleanly and exit.
    handle.readabilityHandler = nil
    controller.shutdown {
      DispatchQueue.main.async {
        stopObservers()
        exit(0)
      }
    }
    return
  }
  pendingInput.append(data)
  while let newline = pendingInput.firstIndex(of: 0x0A) {
    let line = pendingInput.subdata(in: pendingInput.startIndex..<newline)
    pendingInput.removeSubrange(pendingInput.startIndex...newline)
    if !line.isEmpty { controller.handle(line: line) }
  }
}

RunLoop.main.run()
