'use strict';

/**
 * What the right-click menu holds, decided from what was clicked.
 *
 * Right-clicking a page did nothing at all before this: Electron fires
 * `context-menu` and, unless something answers it, no menu appears. It is the
 * menu people open most in a browser, so its absence read as the page being
 * broken rather than as a feature not written yet.
 *
 * This file only decides *what is in* the menu. Drawing it is the sheet's job
 * (`context.html`, styled from the app menu's own stylesheet so the two cannot
 * drift), and running an item is the command switch's, as with every other
 * menu here. The model's `id` is the command that will be sent back, and its
 * `payload` travels with it - so nothing in the renderer knows what "Copy link
 * address" means, only that it carries `copy-link` and a URL.
 *
 * The URL in a payload always comes from Chromium's own hit test, never from
 * the page's DOM, and it is sent back to the browser rather than acted on in
 * the renderer. A page cannot put an address in this menu that is not really
 * under the pointer.
 */

const shortcuts = require('./shortcuts');

/** Addresses a menu item may act on. Anything else is not offered. */
const OPENABLE = new Set(['http:', 'https:', 'debrowser:']);

function openable(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    return OPENABLE.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** A `data:` image is savable and copyable but has no address worth showing. */
function hasAddress(url) {
  return typeof url === 'string' && url.length > 0 && !url.startsWith('data:');
}

const sep = () => ({ kind: 'separator' });

/**
 * Build the menu.
 *
 * @param {Electron.ContextMenuParams} params - Chromium's hit test
 * @param {object} state - { canGoBack, canGoForward, bookmarked, internal }
 */
function buildModel(params = {}, state = {}) {
  const items = [];
  const selection = String(params.selectionText || '').trim();
  const link = params.linkURL || '';
  const media = params.srcURL || '';
  const isImage = params.mediaType === 'image' && Boolean(media);

  // A link, an image or a selection each replace the page menu rather than
  // adding to it. A context menu that lists every command the browser has -
  // which is what appending would produce - is the thing people complain about
  // in other browsers, and the one under the pointer is usually the one item
  // they came for.
  if (openable(link)) {
    items.push(
      { id: 'open-link-tab', label: 'Open link in new tab', icon: 'plus',
        payload: { url: link } },
      { id: 'copy-link', label: 'Copy link address', icon: 'copy',
        payload: { text: link } },
      { id: 'save-link', label: 'Save link as…', icon: 'download',
        payload: { url: link } });
  }

  if (isImage) {
    if (items.length) items.push(sep());
    items.push(
      { id: 'open-link-tab', label: 'Open image in new tab', icon: 'plus',
        enabled: openable(media), payload: { url: media } },
      { id: 'save-link', label: 'Save image as…', icon: 'download',
        payload: { url: media } });
    // The picture itself, as a copy-and-paste into a chat or a document
    // expects - not only its address.
    items.push({ id: 'copy-image', label: 'Copy image', icon: 'copy' });
    if (hasAddress(media)) {
      items.push({ id: 'copy-link', label: 'Copy image address', icon: 'copy',
        payload: { text: media } });
    }
  }

  // An editable field gets the clipboard set, because that is the one place in
  // a browser where cut and paste are not the page's own business. `editFlags`
  // is Chromium's answer to what is actually possible in the field that was
  // clicked, so a read-only input offers Copy and nothing else.
  if (params.isEditable) {
    const flags = params.editFlags || {};
    if (items.length) items.push(sep());
    items.push(
      { id: 'edit-cut', label: 'Cut', icon: 'scissors', accel: 'Ctrl+X',
        enabled: flags.canCut !== false && selection.length > 0 },
      { id: 'edit-copy', label: 'Copy', icon: 'copy', accel: 'Ctrl+C',
        enabled: flags.canCopy !== false && selection.length > 0 },
      { id: 'edit-paste', label: 'Paste', icon: 'clipboard', accel: 'Ctrl+V',
        enabled: flags.canPaste !== false },
      { id: 'edit-select-all', label: 'Select all', icon: 'select', accel: 'Ctrl+A' });
  } else if (selection) {
    if (items.length) items.push(sep());
    items.push(
      { id: 'copy-text', label: 'Copy', icon: 'copy', accel: 'Ctrl+C',
        payload: { text: selection } },
      // The one item that needs the search engine, so it is worded with the
      // engine's name where there is one - "Search the web for" is what a
      // browser says when it will not tell you where it is sending you.
      { id: 'search-selection',
        label: `Search ${state.engineName || 'the web'} for “${ellipsis(selection)}”`,
        icon: 'search', payload: { text: selection } });
  }

  const inspect = {
    id: 'inspect', label: 'Inspect', icon: 'inspect',
    accel: shortcuts.accelFor('toggle-devtools'),
    // Chromium's coordinates are relative to the page, which is exactly what
    // `inspectElement` wants - so they are passed through untouched rather
    // than converted to window coordinates and back.
    payload: { x: Math.round(params.x || 0), y: Math.round(params.y || 0) }
  };

  // A link, an image, a field or a selection gets its own items and Inspect -
  // not Back, Reload, Print and the rest of the page's menu under them, which
  // made a link's menu fifteen rows long. The page's menu is for the page.
  if (items.length) {
    items.push(sep(), inspect);
    return items;
  }

  items.push(
    { id: 'back', label: 'Back', icon: 'back', accel: shortcuts.accelFor('back'),
      enabled: state.canGoBack === true },
    { id: 'forward', label: 'Forward', icon: 'forward', accel: shortcuts.accelFor('forward'),
      enabled: state.canGoForward === true },
    { id: 'reload', label: 'Reload', icon: 'reload', accel: shortcuts.accelFor('reload') },
    sep(),
    { id: 'bookmark-page', label: state.bookmarked ? 'Remove bookmark' : 'Bookmark this page',
      icon: 'star', accel: shortcuts.accelFor('bookmark-page'), enabled: !state.internal },
    { id: 'save-page', label: 'Save page as…', icon: 'download', accel: shortcuts.accelFor('save-page'),
      enabled: !state.internal },
    { id: 'print', label: 'Print…', icon: 'print', accel: shortcuts.accelFor('print') },
    { id: 'view-source', label: 'View page source', icon: 'code',
      accel: shortcuts.accelFor('view-source'), enabled: !state.internal },
    inspect);

  return items;
}

/** Enough of the selection to recognise it, and no more than a menu can hold. */
function ellipsis(text, max = 18) {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

module.exports = { buildModel };
