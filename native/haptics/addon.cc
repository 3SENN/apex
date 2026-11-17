/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Atelier haptics: the Node-API surface.
//
//   perform(pattern: 'alignment' | 'levelChange' | 'generic'): boolean
//
// Returns true when the pattern was handed to the system's haptic
// performer, false on platforms without one. A missing or unknown pattern
// throws a TypeError. 'level-change' is accepted as a spelling of
// 'levelChange', to match the haptics service's kebab-case kind.
#include <napi.h>

#include <string>

#include "haptics.h"

namespace {

// Longest accepted name is "level-change"; anything longer is rejected
// without copying the whole string.
constexpr size_t kMaxNameBytes = 16;

bool ParsePattern(const std::string& name, atelier_haptics::Pattern* out) {
  if (name == "alignment") {
    *out = atelier_haptics::Pattern::kAlignment;
    return true;
  }
  if (name == "levelChange" || name == "level-change") {
    *out = atelier_haptics::Pattern::kLevelChange;
    return true;
  }
  if (name == "generic") {
    *out = atelier_haptics::Pattern::kGeneric;
    return true;
  }
  return false;
}

Napi::Value Perform(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "perform expects a pattern name string")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  char buffer[kMaxNameBytes + 2] = {0};
  size_t copied = 0;
  napi_status status = napi_get_value_string_utf8(
      env, info[0], buffer, sizeof(buffer), &copied);
  if (status != napi_ok) {
    Napi::TypeError::New(env, "perform could not read the pattern name")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  atelier_haptics::Pattern pattern;
  if (copied > kMaxNameBytes ||
      !ParsePattern(std::string(buffer, copied), &pattern)) {
    Napi::TypeError::New(
        env, "unknown haptic pattern (use alignment, levelChange or generic)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return Napi::Boolean::New(env, atelier_haptics::Play(pattern));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("perform", Napi::Function::New(env, Perform, "perform"));
  return exports;
}

}  // namespace

NODE_API_MODULE(atelier_haptics, Init)
