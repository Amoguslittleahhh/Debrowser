# Security

## Reporting a vulnerability

Please report it privately, through **Security → Report a vulnerability** on
this repository, not in a public issue. Say what an attacker can do, and how to
reproduce it.

You will get an answer within a week. A fix ships in a point release as soon as
it is ready, and the release notes credit you unless you ask them not to.

## What is in scope

Debrowser's own code: the browser process, its internal pages
(`debrowser://`), private windows, the password vault, downloads, and the
update and release pipeline.

A bug in Chromium itself belongs with the Chromium project
(<https://bugs.chromium.org>). Debrowser picks up Chromium's fixes through
castLabs Electron, which a daily workflow watches for new builds; the menu shows
which Chromium you are running.

## Supported versions

Only the latest release. Updates are automatic unless turned off in Settings.
