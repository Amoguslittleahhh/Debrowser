abi <abi/4.0>,
include <tunables/global>

# The browser. Chromium's sandbox makes user namespaces, which Ubuntu 24.04
# denies to unconfined programs unless a profile grants it - this is the
# profile electron-builder ships by default, unchanged.
profile "${executable}" "/opt/${sanitizedProductName}/${executable}" flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/${executable}>
}

# The private-window launcher (tools/netns-launch.c). It puts the private
# browser in a network namespace with nowhere to go - incognito's kill switch -
# and needs the same one permission to do it. Without this entry the launcher
# is refused, and the private window runs with the tripwire alone and says so.
profile "${executable}-netns-launch" "/opt/${sanitizedProductName}/resources/tools/netns-launch" flags=(unconfined) {
  userns,
}
