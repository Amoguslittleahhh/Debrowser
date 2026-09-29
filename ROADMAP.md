# Roadmap

What is being worked on, and roughly when. Dates are targets, not promises;
anything that slips moves to the next release rather than holding it back.

## Calendar

A stable release comes about every four weeks. Between them, a point release is
made only for a security fix, lost data or a crash, and its notes say which.

## Next release (2.0)

Everything under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md): spaces with
their own cookies, split view, Peek, reader view, the command bar, the memory
receipt, battery mode, the built-in blocker, HTTPS first, secure DNS, warnings
before dangerous sites, the password check-up and the safety check.

## After that

- **Tab groups** inside spaces, with a colour and collapse.
- **A quick window** for links opened from other apps, with "Move to main
  window".
- **What's new** after an update, as a quiet note rather than a tab.
- **Labs** in Settings: named experiments, off by default, each with a place to
  say how it went.
- **Signed installers** for Windows and macOS, so the first run does not stop at
  a warning.
- **winget, Homebrew and Flathub** packages built by the release workflow.
- **Measured memory against Chrome and Edge,** with the method published.

## Not planned

- A built-in AI assistant, VPN or crypto wallet.
- Chrome extensions: Electron supports only part of them, and "extensions work"
  would be a promise Debrowser could not keep. The blocker, site styles and
  hiding elements cover what most people install extensions for.
- Hardware-backed DRM (Widevine L1): Debrowser plays protected video at the
  level Electron can offer.
