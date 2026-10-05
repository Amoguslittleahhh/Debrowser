'use strict';

/**
 * The private window's own icon (tools/make-icon.js draws it): the same frame
 * as Debrowser's on a violet tile, with a ring where the dot is. It goes on
 * the private window's taskbar button, its Dock tile and the menu entries
 * that open one, so which window is which shows before either is looked at.
 *
 * Packaged, it sits beside the app (electron-builder.yml, extraResources):
 * outside the archive, because Windows' shell and Linux menus read the file
 * themselves. From a checkout, it is in build/.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/** The file, as `.ico` (Windows) or `.png`, or null when there is none. */
function privateIconPath(ext = process.platform === 'win32' ? 'ico' : 'png') {
  const name = `icon-private.${ext}`;
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, name)]
    : [path.join(__dirname, '..', '..', 'build', name)];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

module.exports = { privateIconPath };
