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

/**
 * Debrowser's own icon as a PNG, for an ordinary window on Linux - where the
 * window's icon is what a desktop with no menu entry for it shows - or null.
 * Packaged, beside the app (electron-builder.yml, linux extraResources).
 */
function appIconPath() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'icon.png')]
    : [path.join(__dirname, '..', '..', 'build', 'icon.png')];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * A window's icon, from one of the files above: as the file on Windows, which
 * reads an .ico itself; elsewhere at 128px. On X11 the icon goes to the
 * window manager as one property, and from 256px up it was silently not set
 * at all - measured: every Linux window, private ones included, had none.
 */
function windowIcon(file) {
  if (!file) return null;
  if (process.platform === 'win32') return file;
  const { nativeImage } = require('electron');
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return null;
  return image.getSize().width > 128 ? image.resize({ width: 128, height: 128, quality: 'best' }) : image;
}

module.exports = { privateIconPath, appIconPath, windowIcon };
