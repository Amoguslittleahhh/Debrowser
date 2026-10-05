; The installer's and uninstaller's own window, in the browser's design
; (native/helpers/setup-ui.c), instead of NSIS's: its one-click progress box is drawn
; with the system's dialog controls, which nothing restyles, and its uninstall
; question is a system message box.
;
; Install: .onInit starts the window, and only if that worked makes the
; installer silent - which is what stops NSIS drawing its own. A window that
; cannot start (not built, or refused by the system as an unsigned program)
; leaves the stock one in place, so there is always something on screen. A
; silent install (/S, and every update) stays as it was: no window at all.
;
; Uninstall: Windows' Apps list runs `UninstallString`, which customInstall
; points at the browser itself (`--uninstall`, src/main/setup/uninstall.js) - the
; question in the browser's own window. That starts this uninstaller with /S
; and --wait-pid, and the window here shows the progress.
;
; Embedded only when built (npm run build:setupui; the release workflow does);
; a local package without it gets the stock windows and the stock uninstaller.
!if /FileExists "${PROJECT_DIR}\native\helpers\setup-ui.exe"
  !define SETUP_UI "${PROJECT_DIR}\native\helpers\setup-ui.exe"
!endif
!define SETUP_UI_CLASS "DebrowserSetup"
!define SETUP_UI_ASK 0x8001    ; WM_APP + 1: "Debrowser is open" - answers 1 to go on
!define SETUP_UI_DONE 0x8002   ; WM_APP + 2: fade out and close

!ifdef SETUP_UI
  ; Start the window for this process. Leaves the error flag set if it could not.
  !macro setupUiStart MODE
    Push $0
    InitPluginsDir
    ClearErrors
    File "/oname=$PLUGINSDIR\setup-ui.exe" "${SETUP_UI}"
    ${IfNot} ${Errors}
      ; Lets it come to the front: started by a program the user just opened,
      ; it is entitled to, but Windows only believes that when told.
      System::Call 'user32::AllowSetForegroundWindow(i -1)'
      System::Call 'kernel32::GetCurrentProcessId() i .r0'
      Exec '"$PLUGINSDIR\setup-ui.exe" ${MODE} $0'
    ${EndIf}
    Pop $0
  !macroend

  ; The window's handle into OUT, waiting up to three seconds for it to open; 0 if it never does.
  !macro setupUiWindow OUT
    Push $R9
    StrCpy ${OUT} 0
    ${For} $R9 1 30
      FindWindow ${OUT} "${SETUP_UI_CLASS}"
      ${If} ${OUT} != 0
        ${ExitFor}
      ${EndIf}
      Sleep 100
    ${Next}
    Pop $R9
  !macroend
!endif

!macro customInit
  !ifdef SETUP_UI
    ${IfNot} ${Silent}
      !insertmacro setupUiStart install
      ${IfNot} ${Errors}
        SetSilent silent
      ${EndIf}
    ${ElseIf} ${isUpdated}
      ; An update the user started (Restart to update): silent, as it must be
      ; for no wizard to appear - but not invisible. Between the browser
      ; closing and opening again, our window says what is happening. It goes
      ; when this installer exits, just after electron-builder starts the new
      ; version (--force-run).
      !insertmacro setupUiStart update
    ${EndIf}
  !endif
!macroend

; Replaces electron-builder's check, then runs it: what differs is who asks.
; Defining this makes electron-builder leave out what its own check needs
; (allowOnlyOneInstallerInstance.nsh), so it is brought in here.
!include "getProcessInfo.nsh"
Var pid
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !ifdef BUILD_UNINSTALLER
    ; Started by the browser's uninstall window, which quits as this starts:
    ; wait for it to be gone, so the check below finds nothing to close.
    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "--wait-pid=" $R1
    ${IfNot} ${Errors}
      !ifdef SETUP_UI
        !insertmacro setupUiStart uninstall
      !endif
      System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i $R1) p .R2'
      ${If} $R2 != 0
        System::Call 'kernel32::WaitForSingleObject(p $R2, i 15000)'
        System::Call 'kernel32::CloseHandle(p $R2)'
      ${EndIf}
    ${EndIf}
  !else
    !ifdef SETUP_UI
      ; Our window is up, so the installer is silent and the stock check would
      ; close a running Debrowser without asking. Asked in our window instead.
      ${If} ${FileExists} "$PLUGINSDIR\setup-ui.exe"
      ${AndIfNot} ${isUpdated}
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${If} $R0 == 0
          !insertmacro setupUiWindow $R2
          ${If} $R2 != 0
            SendMessage $R2 ${SETUP_UI_ASK} 0 0 $R3
            ${If} $R3 != 1
              Quit
            ${EndIf}
          ${Else}
            MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" IDOK +2
            Quit
          ${EndIf}
        ${EndIf}
      ${EndIf}
    !endif
  !endif
  ; A private window runs as Debrowser-Incognito.exe, which electron-builder's
  ; check below does not look for when PowerShell is unavailable, and which
  ; quitting the browser does not end. Asked to close, then made to: its files
  ; are about to be replaced or removed. It sweeps its profile next time.
  nsExec::Exec '"$CmdPath" /C taskkill /IM "${INCOGNITO_EXE}" /FI "USERNAME eq %USERNAME%"'
  Pop $R0
  ${If} $R0 == 0
    Sleep 2000
    nsExec::Exec '"$CmdPath" /C taskkill /F /IM "${INCOGNITO_EXE}" /FI "USERNAME eq %USERNAME%"'
    Pop $R0
  ${EndIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend

; Incognito's kill switch on Windows.
;
; A private window runs as its own executable name, Debrowser-Incognito.exe - a
; hard link to the real one, so it is the same program at no extra size - and
; one outbound firewall rule blocks that name from every address except
; loopback, where Tor listens. The browser's own proxy settings are then not
; the only thing between a private window and the network: Windows is.
;
; The installer is per-user and asks for nothing, so the rule costs one UAC
; prompt, once. It is checked first, without elevation, so an update that finds
; the rule already there asks for nothing. If the prompt is refused, the private
; window still works and says in its panel that the firewall rule is missing.

!define INCOGNITO_EXE "Debrowser-Incognito.exe"
!define INCOGNITO_RULE "Debrowser private window"

; Registered as a web browser, so Windows lists Debrowser under Default apps
; and the welcome tour's "Make Debrowser the default" has something to point
; at. Per-user, like the install: HKCU, no prompt. Windows 10 and 11 let no
; app make itself the default; this only offers it, and the user chooses.
!define BROWSER_KEY "Software\Clients\StartMenuInternet\Debrowser"
!define URL_PROGID "DebrowserURL"
!define HTML_PROGID "DebrowserHTML"

!macro registerProgId PROGID DESC
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "${DESC}"
  WriteRegStr HKCU "Software\Classes\${PROGID}" "FriendlyTypeName" "${DESC}"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro registerBrowser
  !insertmacro registerProgId "${URL_PROGID}" "Debrowser URL"
  WriteRegStr HKCU "Software\Classes\${URL_PROGID}" "URL Protocol" ""
  !insertmacro registerProgId "${HTML_PROGID}" "Debrowser HTML Document"

  WriteRegStr HKCU "${BROWSER_KEY}" "" "Debrowser"
  WriteRegStr HKCU "${BROWSER_KEY}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "${BROWSER_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities" "ApplicationName" "Debrowser"
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities" "ApplicationDescription" "A web browser that keeps out of the way of your computer."
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities\StartMenu" "StartMenuInternet" "Debrowser"
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities\URLAssociations" "http" "${URL_PROGID}"
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities\URLAssociations" "https" "${URL_PROGID}"
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities\FileAssociations" ".htm" "${HTML_PROGID}"
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities\FileAssociations" ".html" "${HTML_PROGID}"
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities\FileAssociations" ".pdf" "${HTML_PROGID}"
  WriteRegStr HKCU "Software\RegisteredApplications" "Debrowser" "${BROWSER_KEY}\Capabilities"
  ; Tell Explorer the associations changed, so Default apps lists it at once.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro unregisterBrowser
  DeleteRegValue HKCU "Software\RegisteredApplications" "Debrowser"
  DeleteRegKey HKCU "${BROWSER_KEY}"
  DeleteRegKey HKCU "Software\Classes\${URL_PROGID}"
  DeleteRegKey HKCU "Software\Classes\${HTML_PROGID}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customInstall
  !insertmacro registerBrowser

  ; Re-made on every install: an update replaces the real executable, and a
  ; hard link to the old file would keep running the old version.
  Delete "$INSTDIR\${INCOGNITO_EXE}"
  nsExec::ExecToLog 'cmd /c mklink /H "$INSTDIR\${INCOGNITO_EXE}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  Pop $0

  nsExec::ExecToStack 'netsh advfirewall firewall show rule name="${INCOGNITO_RULE}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ExecShellWait "runas" "netsh" 'advfirewall firewall add rule name="${INCOGNITO_RULE}" dir=out action=block program="$INSTDIR\${INCOGNITO_EXE}" remoteip=0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255,::,::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff profile=any enable=yes' SW_HIDE
  ${EndIf}

  ; Uninstalling from Windows' Apps list opens the browser's own window
  ; (src/main/setup/uninstall.js) rather than the uninstaller's message box. The
  ; quiet string, which management tools use, still runs it with /S.
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall'

  !ifdef SETUP_UI
    ${If} ${FileExists} "$PLUGINSDIR\setup-ui.exe"
    ${AndIfNot} ${isUpdated}
      ; Our window made this install silent, and electron-builder starts the
      ; app after a silent install only when told to (--force-run): started
      ; here, as the window fades.
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
      FindWindow $0 "${SETUP_UI_CLASS}"
      ${If} $0 != 0
        SendMessage $0 ${SETUP_UI_DONE} 0 0 /TIMEOUT=2000
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!macro customUnInstall
  !insertmacro unregisterBrowser
  Delete "$INSTDIR\${INCOGNITO_EXE}"
  ; The rule is left: removing it needs elevation, and a rule naming a file
  ; that no longer exists blocks nothing and costs nothing.
!macroend
