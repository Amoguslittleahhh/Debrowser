#!/bin/sh
# Install Debrowser from a terminal, the way your Linux installs things.
#
#   curl -fsSL https://amoguslittleahhh.github.io/Debrowser/install.sh | sh
#
# Reads /etc/os-release and picks:
#
#   Ubuntu, Debian, Mint, Pop!_OS, elementary...  the .deb, with apt
#   Fedora, RHEL, Rocky, Alma, CentOS             the .rpm, with dnf
#   openSUSE                                      the .rpm, with zypper
#   Arch, Manjaro, EndeavourOS...                 a pacman package, built here
#                                                 from the .deb with makepkg
#   anything else                                 the AppImage, in ~/Applications
#
# Every file is checked against the SHA-512 the release lists for it
# (latest-linux.yml) before anything is installed, and the script stops at the
# first thing that goes wrong. The package managers ask for your password
# through sudo; nothing else runs as root.
#
#   sh install.sh --appimage     the AppImage, whatever the system
#   sh install.sh --help
#
# Run it again to update: it always installs the newest release.
#
# Written for POSIX sh - Ubuntu's sh is dash, not bash.

set -eu

REPO="Amoguslittleahhh/Debrowser"
# Overridable for testing against a copy of a release; not needed otherwise.
BASE="${DEBROWSER_RELEASE_URL:-https://github.com/$REPO/releases/latest/download}"
PKGBUILD_URL="${DEBROWSER_PKGBUILD_URL:-https://amoguslittleahhh.github.io/Debrowser/arch/PKGBUILD}"
OS_RELEASE="${DEBROWSER_OS_RELEASE:-/etc/os-release}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Debrowser could not be installed: %s\n' "$*" >&2; exit 1; }

FORCE_APPIMAGE=
for arg in "$@"; do
  case "$arg" in
    --appimage) FORCE_APPIMAGE=1 ;;
    -h|--help)
      # Spelled out here: piped in through curl, there is no file to read it from.
      cat <<'HELP'
Install Debrowser for this Linux: the .deb with apt, the .rpm with dnf or
zypper, a pacman package on Arch, or else the AppImage. Run it again to update.

  sh install.sh             install the right package for this system
  sh install.sh --appimage  install the AppImage, whatever the system
HELP
      exit 0 ;;
    *) fail "unknown option $arg (try --help)" ;;
  esac
done

[ "$(uname -s)" = Linux ] || fail "this installer is for Linux. Windows and Mac downloads are on https://amoguslittleahhh.github.io/Debrowser/download.html"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "Debrowser is built for 64-bit Intel and AMD processors, and this one is $(uname -m)." ;;
esac

# A downloader: curl, or wget where there is no curl.
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q --tries=3 -O "$2" "$1"; }
else
  fail "it needs curl or wget to download with."
fi

# Root, or sudo for the one step that needs it.
if [ "$(id -u)" -eq 0 ]; then
  as_root() { "$@"; }
elif command -v sudo >/dev/null 2>&1; then
  as_root() { sudo "$@"; }
else
  as_root() { fail "installing a package needs root, and sudo is not here. Run this as root, or use --appimage."; }
fi

# A SHA-512 the way latest-linux.yml writes it: base64 of the raw digest.
sha512_b64() {
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha512 -binary "$1" | base64 | tr -d '\n'
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import base64,hashlib,sys; print(base64.b64encode(hashlib.sha512(open(sys.argv[1],"rb").read()).digest()).decode(), end="")' "$1"
  else
    fail "it needs openssl or python3 to check the download."
  fi
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
chmod 755 "$WORK"   # apt's own user reads the package from here

# Download a file of the release and refuse it unless the release lists it with
# this exact SHA-512.
download() {
  file=$1
  say "Downloading $file…"
  [ -f "$WORK/latest-linux.yml" ] || fetch "$BASE/latest-linux.yml" "$WORK/latest-linux.yml" ||
    fail "the release could not be reached ($BASE)."
  expected=$(awk -v f="$file" '
    $0 == "  - url: " f { on = 1; next }
    on && /^    sha512:/ { print $2; exit }
    on && !/^    / { on = 0 }' "$WORK/latest-linux.yml")
  [ -n "$expected" ] || fail "the release does not list $file."
  fetch "$BASE/$file" "$WORK/$file" || fail "$file could not be downloaded."
  [ "$(sha512_b64 "$WORK/$file")" = "$expected" ] ||
    fail "$file did not match the release, so nothing was installed."
  chmod 644 "$WORK/$file"
}

# Which kind of system, from os-release's ID and ID_LIKE.
family=other
if [ -z "$FORCE_APPIMAGE" ] && [ -r "$OS_RELEASE" ]; then
  # shellcheck source=/dev/null
  ids=$( . "$OS_RELEASE"; printf '%s %s' "${ID:-}" "${ID_LIKE:-}" | tr '[:upper:]' '[:lower:]')
  # shellcheck source=/dev/null
  name=$( . "$OS_RELEASE"; printf '%s' "${NAME:-Linux}")
  for id in $ids; do
    case "$id" in
      debian|ubuntu) command -v apt-get >/dev/null 2>&1 && family=deb && break ;;
      fedora|rhel|centos) command -v dnf >/dev/null 2>&1 && family=dnf && break ;;
      suse|opensuse*|sles) command -v zypper >/dev/null 2>&1 && family=zypper && break ;;
      arch) command -v pacman >/dev/null 2>&1 && family=arch && break ;;
    esac
  done
else
  name=Linux
fi

# No recipe for this release yet (the site builds one from each release's
# .deb): the AppImage instead, rather than nothing.
if [ "$family" = arch ] && ! fetch "$PKGBUILD_URL" "$WORK/PKGBUILD" 2>/dev/null; then
  say "There is no Arch package recipe for this release yet, so this installs the AppImage instead."
  family=other
fi

case "$family" in
  deb)
    say "Installing Debrowser for $name, with apt."
    download Debrowser-Linux.deb
    as_root apt-get install -y "$WORK/Debrowser-Linux.deb"
    ;;
  dnf)
    say "Installing Debrowser for $name, with dnf."
    download Debrowser-Linux.rpm
    as_root dnf install -y "$WORK/Debrowser-Linux.rpm"
    ;;
  zypper)
    say "Installing Debrowser for $name, with zypper."
    download Debrowser-Linux.rpm
    # Checked against the release above; zypper would otherwise stop at a
    # signing key it has not been given yet.
    as_root zypper --non-interactive --no-gpg-checks install "$WORK/Debrowser-Linux.rpm"
    ;;
  arch)
    say "Installing Debrowser for $name: building a pacman package with makepkg."
    command -v makepkg >/dev/null 2>&1 || fail "makepkg is missing. Install it with: sudo pacman -S --needed base-devel"
    [ "$(id -u)" -ne 0 ] || fail "makepkg will not run as root. Run this as your own user; it asks for sudo when it installs."
    # The PKGBUILD names the .deb and its SHA-256; makepkg downloads it and
    # refuses a file that does not match.
    (cd "$WORK" && makepkg --syncdeps --install --noconfirm --needed)
    ;;
  *)
    say "Installing the Debrowser AppImage for $name."
    download Debrowser-Linux.AppImage
    mkdir -p "$HOME/Applications"
    mv "$WORK/Debrowser-Linux.AppImage" "$HOME/Applications/Debrowser.AppImage"
    chmod 755 "$HOME/Applications/Debrowser.AppImage"
    say "Installed to ~/Applications/Debrowser.AppImage. Open it once and it offers to add itself to your apps menu; it keeps itself up to date."
    exit 0
    ;;
esac

say "Done. Debrowser is in your apps menu, or run: debrowser"
