#!/bin/sh
# The accessibility audit (tools/shoot.js --audit: axe-core's WCAG 2.2 A and
# AA rules, and tools/audit-probe.js) over every page the browser draws itself,
# one page per process as shoot.js needs. Fails if any page has a finding.
# On Linux without a display, run it under xvfb-run.
set -u
ELECTRON="${ELECTRON:-node_modules/.bin/electron}"
FLAGS="--disable-gpu ${AUDIT_FLAGS:-}"
failed=0
for name in $("$ELECTRON" tools/shoot.js --list $FLAGS 2>/dev/null); do
  out=$("$ELECTRON" tools/shoot.js --audit --only="$name" $FLAGS 2>&1)
  status=$?
  case "$out" in
    *"AUDIT 0 finding"*) echo "ok    $name" ;;
    *) echo "FAIL  $name (exit $status)"; echo "$out" | grep -v -e dbus -e Fontconfig | tail -20; failed=1 ;;
  esac
done
exit $failed
