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
!macroend

!macro customUnInstall
  !insertmacro unregisterBrowser
  Delete "$INSTDIR\${INCOGNITO_EXE}"
  ; The rule is left: removing it needs elevation, and a rule naming a file
  ; that no longer exists blocks nothing and costs nothing.
!macroend
