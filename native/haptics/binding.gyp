# Copyright (c) 2026 The Atelier Authors. All rights reserved.
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this file,
# You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Atelier haptics addon. Build it with scripts/build-native.mjs, which runs
# node-gyp against the installed Electron's headers. On macOS it links
# AppKit; elsewhere it compiles a no-op, though the build script only
# builds it on macOS and the JS loader (index.js) stubs it everywhere else.
{
  'targets': [
    {
      'target_name': 'atelier_haptics',
      'sources': ['addon.cc'],
      'dependencies': [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api",
      ],
      # Node-API 8 is plenty for one function, and keeps the binary loadable
      # by any runtime from Electron 16 on.
      'defines': ['NAPI_VERSION=8'],
      'conditions': [
        ['OS=="mac"', {
          'sources': ['haptics.mm'],
          'link_settings': {
            'libraries': ['-framework AppKit'],
          },
          'xcode_settings': {
            # The same floor as Electron 45's own framework (minos 13.0).
            'MACOSX_DEPLOYMENT_TARGET': '13.0',
            'CLANG_ENABLE_OBJC_ARC': 'YES',
            'CLANG_CXX_LANGUAGE_STANDARD': 'c++20',
            'GCC_ENABLE_CPP_EXCEPTIONS': 'NO',
            'WARNING_CFLAGS': ['-Wall', '-Wextra'],
          },
        }, {
          'sources': ['haptics_noop.cc'],
          'cflags_cc': ['-Wall', '-Wextra'],
        }],
      ],
    },
  ],
}
