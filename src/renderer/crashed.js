'use strict';

/** The crashed-tab notice: Reload, and follow the theme. */

const api = window.debrowser;
document.getElementById('reload').addEventListener('click', () => api.send('reload'));
api.onState((state) => applyThemePrefs(state.prefs));
document.getElementById('reload').focus();
