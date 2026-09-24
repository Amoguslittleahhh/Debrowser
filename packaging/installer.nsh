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

!macro customInstall
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
  Delete "$INSTDIR\${INCOGNITO_EXE}"
  ; The rule is left: removing it needs elevation, and a rule naming a file
  ; that no longer exists blocks nothing and costs nothing.
!macroend
