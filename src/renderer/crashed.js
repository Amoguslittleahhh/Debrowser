'use strict';

/** The crashed-tab notice: Reload, and follow the theme. */

const api = window.debrowser;
// Over the whole window when the toolbar and tabs kept crashing (window.js, setChromeDown).
const chrome = new URLSearchParams(location.search).get('for') === 'chrome';
if (chrome) {
  document.title = 'Debrowser\u2019s toolbar stopped working';
  document.querySelector('h1').textContent = 'The toolbar and tabs stopped working';
  document.querySelector('p').textContent = 'They crashed several times in a row, often because the computer is short of memory. ' +
    'Your tabs are still open. Closing a few other programs first may help.';
}
document.getElementById('reload').addEventListener('click', () => api.send(chrome ? 'revive-chrome' : 'reload'));
api.onState((state) => applyThemePrefs(state.prefs));
document.getElementById('reload').focus();
