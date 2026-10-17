/*
 * A data file that will not parse is moved aside, not overwritten.
 *
 * Every store here starts empty when its file is unreadable, so the browser
 * still starts - and the next change then saved over the file, turning one bad
 * edit or a half-restored backup into the loss of every bookmark. Renamed
 * first, the original is still on disk for someone to recover.
 */

const fs = require('fs');

function setAside(file, log = () => {}) {
  const kept = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, kept);
    log(`${file} could not be read; kept as ${kept}`);
    return kept;
  } catch (err) {
    log(`${file} could not be read or moved aside (${err.message})`);
    return null;
  }
}

module.exports = { setAside };
