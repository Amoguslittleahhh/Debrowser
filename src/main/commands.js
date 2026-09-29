'use strict';

/**
 * The command bar's list (Ctrl+K, or `>` in the address bar): the things the
 * browser can do, by name, so none of them has to be found in a menu.
 *
 * Every entry is a command `runCommand` already knows - this is a list of
 * names for them, not a second way of doing anything. `keywords` are the
 * other words people reach for ("dark" for the theme, "incognito" for a
 * private window). Built in the main process, and what a row runs is read
 * back from here by index, never from the page.
 */

const shortcuts = require('./shortcuts');

const COMMANDS = [
  { title: 'New tab', command: 'new-tab', keywords: 'open' },
  { title: 'New private window', command: 'new-incognito-window', keywords: 'incognito tor private', normalOnly: true },
  { title: 'Reopen closed tab', command: 'reopen-closed-tab', keywords: 'undo restore' },
  { title: 'Search open tabs', command: 'search-tabs', keywords: 'find switch' },
  { title: 'New space', command: 'new-space', payload: {}, keywords: 'workspace group project', normalOnly: true },
  { title: 'New space with its own cookies', command: 'new-space', payload: { container: true }, keywords: 'workspace container account profile', normalOnly: true },
  { title: 'Next space', command: 'cycle-space', payload: { delta: 1 }, keywords: 'workspace switch', normalOnly: true },
  { title: 'Split view – a new tab beside this one', command: 'split-new', keywords: 'side by side two compare', needsTab: true },
  { title: 'Close split view', command: 'unsplit', keywords: 'side by side single' },
  { title: 'Swap the two sides', command: 'split-swap', keywords: 'split side' },
  { title: 'Put other tabs to sleep', command: 'sleep-other-tabs', keywords: 'discard memory free' },
  { title: 'Close other tabs', command: 'close-other-tabs', keywords: '', needsTab: true },
  { title: 'Duplicate tab', command: 'duplicate-tab', needsTab: true },
  { title: 'Pin tab', command: 'pin-tab', keywords: 'unpin', needsTab: true },
  { title: 'Mute tab', command: 'mute-tab', keywords: 'sound unmute', needsTab: true },
  { title: 'Bookmark this page', command: 'bookmark-page', keywords: 'star save', needsTab: true },
  { title: 'Hide something on this page', command: 'hide-element', keywords: 'remove block distraction element picker', needsTab: true, normalOnly: true },
  { title: 'Show what I hid on this site', command: 'show-hidden', keywords: 'unhide restore', normalOnly: true },
  { title: 'Edit this site’s style', command: 'open-site-style', keywords: 'css boost theme custom', normalOnly: true },
  { title: 'Reader view', command: 'reader-view', keywords: 'read article clean', needsTab: true },
  { title: 'Find in page', command: 'find-open', keywords: 'search' },
  { title: 'Save page', command: 'save-page', keywords: 'download' },
  { title: 'Screenshot the whole page', command: 'screenshot-page', keywords: 'capture image picture', needsTab: true },
  { title: 'Print', command: 'print' },
  { title: 'Zoom in', command: 'zoom', payload: { direction: 'in' }, keywords: 'bigger larger' },
  { title: 'Zoom out', command: 'zoom', payload: { direction: 'out' }, keywords: 'smaller' },
  { title: 'Reset zoom', command: 'zoom', payload: { direction: 'reset' }, keywords: '100' },
  { title: 'Full screen', command: 'toggle-fullscreen' },
  { title: 'History', command: 'open-history', keywords: 'visited' },
  { title: 'Downloads', command: 'open-downloads-page', keywords: 'files' },
  { title: 'Bookmarks', command: 'open-bookmarks' },
  { title: 'Passwords', command: 'open-passwords', keywords: 'logins cards', normalOnly: true },
  { title: 'Settings', command: 'open-settings', keywords: 'preferences options' },
  { title: 'Safety check', command: 'open-safety', keywords: 'security privacy', normalOnly: true },
  { title: 'This week – what Debrowser saved', command: 'open-receipt', keywords: 'receipt memory freed', normalOnly: true },
  { title: 'Task manager', command: 'toggle-panel', keywords: 'memory processes' },
  { title: 'Developer tools', command: 'toggle-devtools', keywords: 'inspect console devtools' },
  { title: 'Keyboard shortcuts', command: 'show-shortcuts', keywords: 'keys help' },
  { title: 'Use the dark theme', command: 'set-pref', payload: { key: 'theme', value: 'dark' }, keywords: 'night appearance' },
  { title: 'Use the light theme', command: 'set-pref', payload: { key: 'theme', value: 'light' }, keywords: 'day appearance' },
  { title: 'Follow the system theme', command: 'set-pref', payload: { key: 'theme', value: 'system' }, keywords: 'appearance auto' },
  { title: 'Battery mode: always on', command: 'set-pref', payload: { key: 'batteryMode', value: 'always' }, keywords: 'power saver laptop' },
  { title: 'Battery mode: on battery only', command: 'set-pref', payload: { key: 'batteryMode', value: 'auto' }, keywords: 'power saver laptop' },
  { title: 'Welcome tour', command: 'open-welcome', keywords: 'setup import', normalOnly: true }
];

/** The list for this window, each with the shortcut that does the same. */
function commandList({ incognito = false, hasTab = true } = {}) {
  return COMMANDS
    .filter((c) => !(incognito && c.normalOnly) && !(c.needsTab && !hasTab))
    .map((c) => ({
      title: c.title,
      command: c.command,
      payload: c.payload || null,
      keywords: c.keywords || '',
      accel: shortcuts.accelFor(c.command, c.payload || null)
    }));
}

module.exports = { commandList, COMMANDS };
