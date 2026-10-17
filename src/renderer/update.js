'use strict';

/**
 * The update prompt, drawn by the browser.
 *
 * It used to be `dialog.showMessageBox` - a Win32 message box in the middle of
 * a window that draws everything else itself: light-themed over a dark browser,
 * in the system's typeface, with the system's buttons. The one thing a platform
 * dialog was buying here was modality, and this is already a view over the whole
 * window with a backdrop that catches the click, so it was buying nothing.
 *
 * Lives in the same sheet the app menu and the downloads flyout do. Unlike
 * those it is not anchored to a button, because nothing here was opened by
 * pressing one: it centres itself.
 */

const api = window.debrowser;

const el = {
  sheet: document.getElementById('sheet'),
  backdrop: document.getElementById('backdrop'),
  lead: document.getElementById('lead'),
  later: document.getElementById('later'),
  restart: document.getElementById('restart')
};

/**
 * Dismissing is "Later", and that is the whole of it.
 *
 * The browser keeps the downloaded update; the prompt comes back on the next
 * launch. Nothing is cancelled and nothing is thrown away, which is why this is
 * allowed to be as easy to dismiss as any other panel.
 */
function later() {
  api.send('close-menu');
}

el.later.addEventListener('click', later);
el.backdrop.addEventListener('mousedown', later);
el.restart.addEventListener('click', () => api.send('update-restart'));

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { later(); return; }

  // A tab loop that cannot leave the prompt. Without it, Tab moves focus to
  // nothing visible and the next keystroke goes somewhere nobody can see -
  // which is worse here than on a menu, because this sheet is covering the
  // window and looks like it has the keyboard.
  if (event.key !== 'Tab') return;
  const active = document.activeElement;
  if (event.shiftKey && (active === el.later || active === el.sheet)) {
    event.preventDefault();
    el.restart.focus();
  } else if (!event.shiftKey && active === el.restart) {
    event.preventDefault();
    el.later.focus();
  }
});

api.onState((state) => {
  applyThemePrefs(state.prefs);
  // The version comes from the browser rather than being passed in the URL: the
  // sheet is opened by the updater reaching a state, and the state broadcast is
  // already carrying what that state is.
  const version = state.updates && state.updates.version;
  el.lead.textContent = version
    ? `Debrowser ${version} is ready to install.`
    : 'A new version is ready to install.';
});

/*
 * The keyboard lands on "Later", not on "Restart now".
 *
 * This prompt is the one panel in the browser that appears without being asked
 * for: the updater reaches a state and the sheet opens over whatever the user
 * was doing, taking the keyboard with it. With Restart focused, an Enter or a
 * space aimed at the page - a form being submitted, a video being paused -
 * quits the browser into an installer instead. Restart is still the primary
 * button and still one Tab away; what a stray keystroke does is nothing worse
 * than dismissing a prompt that will be back on the next launch.
 */
el.later.focus();
