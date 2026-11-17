; Copyright (c) 2026 The Apex Authors. All rights reserved.
; This Source Code Form is subject to the terms of the Mozilla Public
; License, v. 2.0. If a copy of the MPL was not distributed with this file,
; You can obtain one at https://mozilla.org/MPL/2.0/.
;
; Apex's additions to the NSIS installer.
; electron-builder includes this file in both the installer and the uninstaller.
; Names come from ${PRODUCT_NAME}, the branding's (Apex, or Summit for the
; unofficial branding; scripts/branding.mjs), so the two install side by side.
;
; Apex installs per user (no elevation), so every key lives under HKCU. It
; registers Apex as a browser Windows can offer in Settings > Default apps:
; StartMenuInternet capabilities, http and https, and .html and .htm. Apex
; never takes an existing default: Windows asks the person, so these keys only
; add Apex to the choices. Exported companions (.apexcompanion) are Apex's own
; type, so Apex opens them, and so are packs, apps and worlds (.apexpack,
; .apexapp, .apexworld). The uninstaller removes every key it added, but
; not during an update (the new version writes them again).

!define APEX_CLIENT "${PRODUCT_NAME}"
!define APEX_CAPS "Software\Clients\StartMenuInternet\${APEX_CLIENT}"
!define APEX_HTML "${PRODUCT_NAME}HTML"
!define APEX_URL "${PRODUCT_NAME}URL"
!define APEX_COMPANION "${PRODUCT_NAME}.Companion"
!define APEX_PACK "${PRODUCT_NAME}.Pack"

; Always the per-user mode; the folder page still lets the person choose where.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro apexProgId PROGID NAME ICON
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "${NAME}"
  WriteRegStr HKCU "Software\Classes\${PROGID}" "AppUserModelId" "${APP_ID}"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "${ICON}"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$appExe" "%1"'
!macroend

!macro customInstall
  ; The ProgIDs Apex opens things with.
  !insertmacro apexProgId "${APEX_HTML}" "${PRODUCT_NAME} HTML Document" "$INSTDIR\resources\html-document.ico"
  !insertmacro apexProgId "${APEX_URL}" "${PRODUCT_NAME} URL" "$appExe,0"
  WriteRegStr HKCU "Software\Classes\${APEX_URL}" "URL Protocol" ""
  !insertmacro apexProgId "${APEX_COMPANION}" "${PRODUCT_NAME} companion" "$INSTDIR\resources\apexcompanion.ico"
  !insertmacro apexProgId "${APEX_PACK}" "${PRODUCT_NAME} pack" "$INSTDIR\resources\apexpack.ico"

  ; StartMenuInternet: how Settings > Default apps lists Apex as a browser.
  WriteRegStr HKCU "${APEX_CAPS}" "" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${APEX_CAPS}\DefaultIcon" "" "$appExe,0"
  WriteRegStr HKCU "${APEX_CAPS}\shell\open\command" "" '"$appExe"'
  WriteRegStr HKCU "${APEX_CAPS}\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${APEX_CAPS}\Capabilities" "ApplicationIcon" "$appExe,0"
  WriteRegStr HKCU "${APEX_CAPS}\Capabilities" "ApplicationDescription" "A browser with a companion that works in your tabs."
  WriteRegStr HKCU "${APEX_CAPS}\Capabilities\StartMenu" "StartMenuInternet" "${APEX_CLIENT}"
  WriteRegStr HKCU "${APEX_CAPS}\Capabilities\URLAssociations" "http" "${APEX_URL}"
  WriteRegStr HKCU "${APEX_CAPS}\Capabilities\URLAssociations" "https" "${APEX_URL}"
  WriteRegStr HKCU "${APEX_CAPS}\Capabilities\FileAssociations" ".html" "${APEX_HTML}"
  WriteRegStr HKCU "${APEX_CAPS}\Capabilities\FileAssociations" ".htm" "${APEX_HTML}"
  WriteRegStr HKCU "${APEX_CAPS}\Capabilities\FileAssociations" ".apexcompanion" "${APEX_COMPANION}"
  WriteRegStr HKCU "${APEX_CAPS}\Capabilities\FileAssociations" ".apexpack" "${APEX_PACK}"
  WriteRegStr HKCU "${APEX_CAPS}\Capabilities\FileAssociations" ".apexapp" "${APEX_PACK}"
  WriteRegStr HKCU "${APEX_CAPS}\Capabilities\FileAssociations" ".apexworld" "${APEX_PACK}"
  WriteRegStr HKCU "Software\RegisteredApplications" "${APEX_CLIENT}" "${APEX_CAPS}\Capabilities"

  ; "Open with" entries; the person's current default stays.
  WriteRegStr HKCU "Software\Classes\.html\OpenWithProgids" "${APEX_HTML}" ""
  WriteRegStr HKCU "Software\Classes\.htm\OpenWithProgids" "${APEX_HTML}" ""

  ; Exported companions are Apex's own type.
  WriteRegStr HKCU "Software\Classes\.apexcompanion" "" "${APEX_COMPANION}"
  WriteRegStr HKCU "Software\Classes\.apexcompanion" "Content Type" "application/x-apexcompanion"
  WriteRegStr HKCU "Software\Classes\.apexcompanion\OpenWithProgids" "${APEX_COMPANION}" ""
  ; Packs (docs/packs.md) are Apex's own type too.
  WriteRegStr HKCU "Software\Classes\.apexpack" "" "${APEX_PACK}"
  WriteRegStr HKCU "Software\Classes\.apexpack" "Content Type" "application/x-apexpack"
  WriteRegStr HKCU "Software\Classes\.apexpack\OpenWithProgids" "${APEX_PACK}" ""
  ; Apps and worlds (docs/apps.md) travel as the same archive, so they open as packs.
  WriteRegStr HKCU "Software\Classes\.apexapp" "" "${APEX_PACK}"
  WriteRegStr HKCU "Software\Classes\.apexapp" "Content Type" "application/x-apexapp"
  WriteRegStr HKCU "Software\Classes\.apexapp\OpenWithProgids" "${APEX_PACK}" ""
  WriteRegStr HKCU "Software\Classes\.apexworld" "" "${APEX_PACK}"
  WriteRegStr HKCU "Software\Classes\.apexworld" "Content Type" "application/x-apexworld"
  WriteRegStr HKCU "Software\Classes\.apexworld\OpenWithProgids" "${APEX_PACK}" ""

  ; Tell Explorer the associations changed (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\RegisteredApplications" "${APEX_CLIENT}"
    DeleteRegKey HKCU "${APEX_CAPS}"
    DeleteRegValue HKCU "Software\Classes\.html\OpenWithProgids" "${APEX_HTML}"
    DeleteRegValue HKCU "Software\Classes\.htm\OpenWithProgids" "${APEX_HTML}"
    DeleteRegValue HKCU "Software\Classes\.apexcompanion\OpenWithProgids" "${APEX_COMPANION}"
    ; Clear the .apexcompanion default only while it still points at Apex.
    ReadRegStr $0 HKCU "Software\Classes\.apexcompanion" ""
    ${if} $0 == "${APEX_COMPANION}"
      DeleteRegValue HKCU "Software\Classes\.apexcompanion" ""
      DeleteRegValue HKCU "Software\Classes\.apexcompanion" "Content Type"
    ${endIf}
    DeleteRegKey /ifempty HKCU "Software\Classes\.apexcompanion\OpenWithProgids"
    DeleteRegKey /ifempty HKCU "Software\Classes\.apexcompanion"
    DeleteRegValue HKCU "Software\Classes\.apexpack\OpenWithProgids" "${APEX_PACK}"
    ReadRegStr $0 HKCU "Software\Classes\.apexpack" ""
    ${if} $0 == "${APEX_PACK}"
      DeleteRegValue HKCU "Software\Classes\.apexpack" ""
      DeleteRegValue HKCU "Software\Classes\.apexpack" "Content Type"
    ${endIf}
    DeleteRegKey /ifempty HKCU "Software\Classes\.apexpack\OpenWithProgids"
    DeleteRegKey /ifempty HKCU "Software\Classes\.apexpack"
    DeleteRegValue HKCU "Software\Classes\.apexapp\OpenWithProgids" "${APEX_PACK}"
    ReadRegStr $0 HKCU "Software\Classes\.apexapp" ""
    ${if} $0 == "${APEX_PACK}"
      DeleteRegValue HKCU "Software\Classes\.apexapp" ""
      DeleteRegValue HKCU "Software\Classes\.apexapp" "Content Type"
    ${endIf}
    DeleteRegKey /ifempty HKCU "Software\Classes\.apexapp\OpenWithProgids"
    DeleteRegKey /ifempty HKCU "Software\Classes\.apexapp"
    DeleteRegValue HKCU "Software\Classes\.apexworld\OpenWithProgids" "${APEX_PACK}"
    ReadRegStr $0 HKCU "Software\Classes\.apexworld" ""
    ${if} $0 == "${APEX_PACK}"
      DeleteRegValue HKCU "Software\Classes\.apexworld" ""
      DeleteRegValue HKCU "Software\Classes\.apexworld" "Content Type"
    ${endIf}
    DeleteRegKey /ifempty HKCU "Software\Classes\.apexworld\OpenWithProgids"
    DeleteRegKey /ifempty HKCU "Software\Classes\.apexworld"
    DeleteRegKey HKCU "Software\Classes\${APEX_HTML}"
    DeleteRegKey HKCU "Software\Classes\${APEX_URL}"
    DeleteRegKey HKCU "Software\Classes\${APEX_COMPANION}"
    DeleteRegKey HKCU "Software\Classes\${APEX_PACK}"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
