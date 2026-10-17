# Privacy

Debrowser has no account, no server of its own and no analytics. Nothing about
you or the pages you visit is collected by the project. This page lists every
connection the browser makes that you did not make yourself by visiting a
site, what it carries, and how to turn it off where it can be.

## What stays on your computer

History, bookmarks, the reading list, settings, site permissions and saved
sign-ins, cards, addresses and passkeys are kept in your profile folder and
nowhere else. Saved sign-ins, cards and addresses are encrypted with a key your
operating system's keystore holds. Private windows keep nothing at all.

## Connections Debrowser makes by itself

| What | Where it goes | What it carries | Turn it off |
| --- | --- | --- | --- |
| Update check | GitHub (the project's releases) | The version you have and your system, as any download does | Settings > Updates |
| Dangerous-site lists, once a day | URLhaus (abuse.ch), Phishing Army | Nothing about you: the whole list is downloaded and every check is made on your computer | Settings > Search and startup > Warn before dangerous sites |
| Ad and tracker block lists, at most weekly | GitHub (EasyList, Peter Lowe's and uBlock Origin's lists, as Ghostery's blocker publishes them) | Nothing about you: the lists are downloaded whole | Settings > Search and startup > Block ads and trackers |
| Video DRM component (Widevine), so streaming sites play | castLabs and Google's component servers | A check for the component and its updates when the browser starts, as Chrome makes | Can't be turned off |
| Secure DNS | The provider chosen in Settings (Cloudflare, Quad9, Google, Mullvad), or your system's | The names of the sites you visit, encrypted, instead of to your network's DNS | Settings > Search and startup > Secure DNS |
| Site icons | The site you visited | The icon request | |

## Connections only when you ask

- **Password check-up** sends the first five characters of each password's
  SHA-1 hash to Have I Been Pwned (`api.pwnedpasswords.com`) and compares the
  answers on your computer. Your passwords never leave it.
- **Translate** sends the page's address to Google Translate, which fetches the
  page itself, without your cookies, and sends it back translated. Selected
  text is sent to Google Translate. Nothing is sent until you choose Translate,
  and it is not offered in private windows.
- **Sync** writes your bookmarks, reading list and settings to a folder you
  choose, encrypted with your passphrase. Whatever syncs that folder (iCloud
  Drive, OneDrive, Dropbox, Google Drive, Syncthing) carries the files and
  cannot read them. Passwords and cards are not synced.
- **Problem reports.** When the browser hits an error, it offers on the next
  start to open a GitHub issue, filled in with the version, your system and the
  error, with web addresses and your user name taken out. Nothing is sent
  unless you read it and press Submit on GitHub.
- **Search** goes to the search engine you chose. The address bar's suggestions
  come from your own tabs, bookmarks and history; what you type is not sent
  anywhere until you press Enter.

## Private windows

Private windows send everything through Tor, keep nothing on your computer,
and make none of the background connections above.

## Questions

Open an issue at <https://github.com/Amoguslittleahhh/Debrowser/issues>.
Security problems: see [SECURITY.md](../.github/SECURITY.md).
