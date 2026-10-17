#!/bin/bash

# electron-builder's own after-remove script, below, only when the package is
# erased ($1 = 0). An RPM upgrade runs the old package's %postun after the new
# one's %post, so unguarded it took away the /usr/bin/debrowser link the new
# version had just made.
if [ "$1" = 0 ]; then

  # Delete the link to the binary
  # update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
  # not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
  if type update-alternatives >/dev/null 2>&1; then
      update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
  else
      rm -f '/usr/bin/${executable}'
  fi

  APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

  # Remove and unload apparmor profile.
  if [ -f "$APPARMOR_PROFILE_DEST" ]; then
    # Unload the profile from the running kernel before deleting the file so the
    # policy is not left enforced until the next reboot.  Mirror the chroot guard
    # used in the after-install script — live AppArmor operations are not
    # meaningful inside a chroot.
    # https://wiki.debian.org/AppArmor/HowToUse
    if apparmor_status --enabled > /dev/null 2>&1; then
      if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
        apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
      fi
    fi
    rm -f "$APPARMOR_PROFILE_DEST"
  fi
  # --- Debrowser: the repository goes with the package, and with it the note
  # that it was added, so installing again starts over.
  rm -f /etc/yum.repos.d/debrowser.repo /etc/zypp/repos.d/debrowser.repo /etc/default/debrowser
fi
