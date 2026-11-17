; Copyright (c) 2026 The Atelier Authors. All rights reserved.
; This Source Code Form is subject to the terms of the Mozilla Public
; License, v. 2.0. If a copy of the MPL was not distributed with this file,
; You can obtain one at https://mozilla.org/MPL/2.0/.
;
; Atelier's additions to the NSIS installer.
; electron-builder includes this file in both the installer and the uninstaller.
; Names come from ${PRODUCT_NAME}, the branding's (Atelier, or Summit for the
; unofficial branding; scripts/branding.mjs), so the two install side by side.
;
; Atelier installs per user (no elevation), so every key lives under HKCU. It
; registers Atelier as a browser Windows can offer in Settings > Default apps:
; StartMenuInternet capabilities, http and https, and .html and .htm. Atelier
; never takes an existing default: Windows asks the person, so these keys only
; add Atelier to the choices. Exported companions (.ateliercompanion) are Atelier's own
; type, so Atelier opens them, and so are packs, apps and worlds (.atelierpack,
; .atelierapp, .atelierworld). The uninstaller removes every key it added, but
; not during an update (the new version writes them again).

!define ATELIER_CLIENT "${PRODUCT_NAME}"
!define ATELIER_CAPS "Software\Clients\StartMenuInternet\${ATELIER_CLIENT}"
!define ATELIER_HTML "${PRODUCT_NAME}HTML"
!define ATELIER_URL "${PRODUCT_NAME}URL"
!define ATELIER_COMPANION "${PRODUCT_NAME}.Companion"
!define ATELIER_PACK "${PRODUCT_NAME}.Pack"

; Always the per-user mode; the folder page still lets the person choose where.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro atelierProgId PROGID NAME ICON
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "${NAME}"
  WriteRegStr HKCU "Software\Classes\${PROGID}" "AppUserModelId" "${APP_ID}"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "${ICON}"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$appExe" "%1"'
!macroend

!macro customInstall
  ; The ProgIDs Atelier opens things with.
  !insertmacro atelierProgId "${ATELIER_HTML}" "${PRODUCT_NAME} HTML Document" "$INSTDIR\resources\html-document.ico"
  !insertmacro atelierProgId "${ATELIER_URL}" "${PRODUCT_NAME} URL" "$appExe,0"
  WriteRegStr HKCU "Software\Classes\${ATELIER_URL}" "URL Protocol" ""
  !insertmacro atelierProgId "${ATELIER_COMPANION}" "${PRODUCT_NAME} companion" "$INSTDIR\resources\ateliercompanion.ico"
  !insertmacro atelierProgId "${ATELIER_PACK}" "${PRODUCT_NAME} pack" "$INSTDIR\resources\atelierpack.ico"

  ; StartMenuInternet: how Settings > Default apps lists Atelier as a browser.
  WriteRegStr HKCU "${ATELIER_CAPS}" "" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${ATELIER_CAPS}\DefaultIcon" "" "$appExe,0"
  WriteRegStr HKCU "${ATELIER_CAPS}\shell\open\command" "" '"$appExe"'
  WriteRegStr HKCU "${ATELIER_CAPS}\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${ATELIER_CAPS}\Capabilities" "ApplicationIcon" "$appExe,0"
  WriteRegStr HKCU "${ATELIER_CAPS}\Capabilities" "ApplicationDescription" "A browser with a companion that works in your tabs."
  WriteRegStr HKCU "${ATELIER_CAPS}\Capabilities\StartMenu" "StartMenuInternet" "${ATELIER_CLIENT}"
  WriteRegStr HKCU "${ATELIER_CAPS}\Capabilities\URLAssociations" "http" "${ATELIER_URL}"
  WriteRegStr HKCU "${ATELIER_CAPS}\Capabilities\URLAssociations" "https" "${ATELIER_URL}"
  WriteRegStr HKCU "${ATELIER_CAPS}\Capabilities\FileAssociations" ".html" "${ATELIER_HTML}"
  WriteRegStr HKCU "${ATELIER_CAPS}\Capabilities\FileAssociations" ".htm" "${ATELIER_HTML}"
  WriteRegStr HKCU "${ATELIER_CAPS}\Capabilities\FileAssociations" ".ateliercompanion" "${ATELIER_COMPANION}"
  WriteRegStr HKCU "${ATELIER_CAPS}\Capabilities\FileAssociations" ".atelierpack" "${ATELIER_PACK}"
  WriteRegStr HKCU "${ATELIER_CAPS}\Capabilities\FileAssociations" ".atelierapp" "${ATELIER_PACK}"
  WriteRegStr HKCU "${ATELIER_CAPS}\Capabilities\FileAssociations" ".atelierworld" "${ATELIER_PACK}"
  WriteRegStr HKCU "Software\RegisteredApplications" "${ATELIER_CLIENT}" "${ATELIER_CAPS}\Capabilities"

  ; "Open with" entries; the person's current default stays.
  WriteRegStr HKCU "Software\Classes\.html\OpenWithProgids" "${ATELIER_HTML}" ""
  WriteRegStr HKCU "Software\Classes\.htm\OpenWithProgids" "${ATELIER_HTML}" ""

  ; Exported companions are Atelier's own type.
  WriteRegStr HKCU "Software\Classes\.ateliercompanion" "" "${ATELIER_COMPANION}"
  WriteRegStr HKCU "Software\Classes\.ateliercompanion" "Content Type" "application/x-ateliercompanion"
  WriteRegStr HKCU "Software\Classes\.ateliercompanion\OpenWithProgids" "${ATELIER_COMPANION}" ""
  ; Packs (docs/packs.md) are Atelier's own type too.
  WriteRegStr HKCU "Software\Classes\.atelierpack" "" "${ATELIER_PACK}"
  WriteRegStr HKCU "Software\Classes\.atelierpack" "Content Type" "application/x-atelierpack"
  WriteRegStr HKCU "Software\Classes\.atelierpack\OpenWithProgids" "${ATELIER_PACK}" ""
  ; Apps and worlds (docs/apps.md) travel as the same archive, so they open as packs.
  WriteRegStr HKCU "Software\Classes\.atelierapp" "" "${ATELIER_PACK}"
  WriteRegStr HKCU "Software\Classes\.atelierapp" "Content Type" "application/x-atelierapp"
  WriteRegStr HKCU "Software\Classes\.atelierapp\OpenWithProgids" "${ATELIER_PACK}" ""
  WriteRegStr HKCU "Software\Classes\.atelierworld" "" "${ATELIER_PACK}"
  WriteRegStr HKCU "Software\Classes\.atelierworld" "Content Type" "application/x-atelierworld"
  WriteRegStr HKCU "Software\Classes\.atelierworld\OpenWithProgids" "${ATELIER_PACK}" ""

  ; Tell Explorer the associations changed (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\RegisteredApplications" "${ATELIER_CLIENT}"
    DeleteRegKey HKCU "${ATELIER_CAPS}"
    DeleteRegValue HKCU "Software\Classes\.html\OpenWithProgids" "${ATELIER_HTML}"
    DeleteRegValue HKCU "Software\Classes\.htm\OpenWithProgids" "${ATELIER_HTML}"
    DeleteRegValue HKCU "Software\Classes\.ateliercompanion\OpenWithProgids" "${ATELIER_COMPANION}"
    ; Clear the .ateliercompanion default only while it still points at Atelier.
    ReadRegStr $0 HKCU "Software\Classes\.ateliercompanion" ""
    ${if} $0 == "${ATELIER_COMPANION}"
      DeleteRegValue HKCU "Software\Classes\.ateliercompanion" ""
      DeleteRegValue HKCU "Software\Classes\.ateliercompanion" "Content Type"
    ${endIf}
    DeleteRegKey /ifempty HKCU "Software\Classes\.ateliercompanion\OpenWithProgids"
    DeleteRegKey /ifempty HKCU "Software\Classes\.ateliercompanion"
    DeleteRegValue HKCU "Software\Classes\.atelierpack\OpenWithProgids" "${ATELIER_PACK}"
    ReadRegStr $0 HKCU "Software\Classes\.atelierpack" ""
    ${if} $0 == "${ATELIER_PACK}"
      DeleteRegValue HKCU "Software\Classes\.atelierpack" ""
      DeleteRegValue HKCU "Software\Classes\.atelierpack" "Content Type"
    ${endIf}
    DeleteRegKey /ifempty HKCU "Software\Classes\.atelierpack\OpenWithProgids"
    DeleteRegKey /ifempty HKCU "Software\Classes\.atelierpack"
    DeleteRegValue HKCU "Software\Classes\.atelierapp\OpenWithProgids" "${ATELIER_PACK}"
    ReadRegStr $0 HKCU "Software\Classes\.atelierapp" ""
    ${if} $0 == "${ATELIER_PACK}"
      DeleteRegValue HKCU "Software\Classes\.atelierapp" ""
      DeleteRegValue HKCU "Software\Classes\.atelierapp" "Content Type"
    ${endIf}
    DeleteRegKey /ifempty HKCU "Software\Classes\.atelierapp\OpenWithProgids"
    DeleteRegKey /ifempty HKCU "Software\Classes\.atelierapp"
    DeleteRegValue HKCU "Software\Classes\.atelierworld\OpenWithProgids" "${ATELIER_PACK}"
    ReadRegStr $0 HKCU "Software\Classes\.atelierworld" ""
    ${if} $0 == "${ATELIER_PACK}"
      DeleteRegValue HKCU "Software\Classes\.atelierworld" ""
      DeleteRegValue HKCU "Software\Classes\.atelierworld" "Content Type"
    ${endIf}
    DeleteRegKey /ifempty HKCU "Software\Classes\.atelierworld\OpenWithProgids"
    DeleteRegKey /ifempty HKCU "Software\Classes\.atelierworld"
    DeleteRegKey HKCU "Software\Classes\${ATELIER_HTML}"
    DeleteRegKey HKCU "Software\Classes\${ATELIER_URL}"
    DeleteRegKey HKCU "Software\Classes\${ATELIER_COMPANION}"
    DeleteRegKey HKCU "Software\Classes\${ATELIER_PACK}"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
