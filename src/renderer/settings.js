'use strict';

/**
 * Settings.
 *
 * Every control is generated from the descriptor list below. That is not
 * cleverness for its own sake: a preference otherwise has to be declared in
 * four places - the schema in prefs.js, the markup, a change handler, and the
 * code that writes the saved value back into the control on load - and the
 * fourth is the one that gets forgotten, producing a settings page that shows
 * defaults rather than what the user chose. Here there is one entry and the
 * render/apply path is shared.
 *
 * Nothing is saved locally. Every change goes to the browser process, which
 * validates it against the same schema that guards the file on disk, and comes
 * back as state - so a rejected value visibly snaps back instead of appearing
 * to have been accepted.
 */

const api = window.debrowser;

/** Set by watchSections: look again at which section is current. */
let remarkRail = () => {};

/** Why saved logins cannot be filled here, or '' - set by renderPasscode. */
let credentialsUnavailable = '';

/** A reason as a sentence: capital first, full stop last. */
function sentence(text) {
  const t = String(text).trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : '';
}

/**
 * Accent choices, and the reason none of them is bright.
 *
 * These were the six saturated primaries every colour picker offers - pure
 * blue, pure green, pure red - which is what made the browser look stock
 * whichever one you chose. Each of these is a real pigment name because each is
 * mixed like one: held around half the saturation, so the accent marks what is
 * selected without becoming the loudest thing on screen. Teal is first because
 * it is the default; the rest are what someone might actually want instead.
 */
const ACCENTS = [
  { value: '#2f857b', name: 'Petrol' },
  { value: '#6f8f5f', name: 'Moss' },
  { value: '#a8694a', name: 'Clay' },
  { value: '#b08a3c', name: 'Ochre' },
  { value: '#7b6a9c', name: 'Iris' },
  { value: '#5f7d9c', name: 'Slate' }
];

/** Tab strip colours. Muted on purpose: this is a large area, not an accent. */
const STRIP_COLORS = [
  { value: '#1b1f22', name: 'Graphite', css: '#1b1f22' },
  { value: '#1d1c22', name: 'Aubergine', css: '#1d1c22' },
  { value: '#171f1c', name: 'Pine',     css: '#171f1c' },
  { value: '#221c16', name: 'Umber',    css: '#221c16' },
  { value: '#231a1a', name: 'Oxblood',  css: '#231a1a' }
];

const SECTIONS = {
  appearance: [
    {
      key: 'design',
      label: 'Design',
      hint: 'Shapes and type. Legacy is the look from before 1.8.',
      type: 'select',
      options: [
        { value: 'ledger', name: 'Ledger' },
        { value: 'paper', name: 'Paper' },
        { value: 'grid', name: 'Grid' },
        { value: 'legacy', name: 'Legacy design' }
      ]
    },
    {
      key: 'settingsLayout',
      label: 'Settings layout',
      type: 'select',
      options: [
        { value: 'pages', name: 'One section at a time' },
        { value: 'scroll', name: 'All on one page' }
      ]
    },
    {
      key: 'continueCard',
      label: 'Under the search on the new tab page',
      type: 'select',
      boolean: true,
      options: [
        { value: 'true', name: 'Recent pages' },
        { value: 'false', name: 'Favourites' }
      ],
      unavailable: (state) => (state.prefs.design === 'legacy' ? 'The legacy design shows your frequent sites instead.' : '')
    },
    {
      key: 'theme',
      label: 'Theme',
      type: 'select',
      options: [
        { value: 'system', name: 'System' },
        { value: 'light', name: 'Light' },
        { value: 'dark', name: 'Dark' }
      ]
    },
    { key: 'accent', label: 'Accent colour', type: 'accent' },
    {
      key: 'showBookmarksBar',
      label: 'Show the bookmarks bar',
      hint: 'Ctrl+Shift+B',
      type: 'checkbox',
      unavailable: (state) => (state.prefs.tabBarPosition === 'left'
        ? 'Shown with tabs across the top. Down the side, bookmarks are under Ctrl+Shift+O.' : '')
    },
    {
      key: 'tabBarPosition',
      label: 'Tab bar position',
      hint: 'Down the side keeps titles readable with many tabs open.',
      type: 'select',
      options: [
        { value: 'top', name: 'Across the top' },
        { value: 'left', name: 'Down the left' }
      ]
    },
    {
      key: 'tabWidth',
      label: 'Tab width',
      type: 'select',
      options: [
        { value: 'roomy', name: 'Roomy' },
        { value: 'compact', name: 'Compact' }
      ]
    },
    {
      key: 'tabBarColor',
      label: 'Tab strip colour',
      type: 'stripColor'
    },
    {
      key: 'windowOpacity',
      label: 'Tab bar translucency',
      hint: 'Needs a window material behind it.',
      unavailable: () => (api.platform === 'linux' ? 'Needs Windows or macOS: Linux has no window material to show through.' : ''),
      type: 'range',
      // Shown as translucency, which is what the row is called, not as the
      // opacity the preference stores: at 100% on the old scale the strip was
      // solid, so dragging towards "more" took translucency away.
      min: 0,
      max: 0.6,
      step: 0.02,
      toSlider: (opacity) => Math.round((1 - opacity) * 100) / 100,
      fromSlider: (amount) => Math.round((1 - amount) * 100) / 100,
      format: (v) => (v <= 0 ? 'Off' : `${Math.round(v * 100)}%`)
    },
    {
      key: 'backgroundMaterial',
      label: 'Window material',
      unavailable: () => (api.platform !== 'win32' ? 'Windows 11 only.' : ''),
      type: 'select',
      options: [
        { value: 'none', name: 'None' },
        { value: 'mica', name: 'Mica' },
        { value: 'acrylic', name: 'Acrylic' },
        { value: 'tabbed', name: 'Tabbed' }
      ]
    },
    {
      key: 'reduceMotion',
      label: 'Reduce motion',
      type: 'checkbox'
    },
    {
      key: 'showMemoryMeter',
      label: 'Show the memory meter',
      hint: 'Hiding it doesn’t stop tabs sleeping.',
      type: 'checkbox'
    },
    {
      key: 'showTierDots',
      label: 'Mark sleeping tabs',
      type: 'checkbox'
    },
    {
      key: 'hoverCards',
      label: 'Show a card when you rest on a tab',
      hint: 'Its whole title, its site, and how much memory it uses or gave back.',
      type: 'checkbox'
    }
  ],

  browsing: [
    // First, because it is what someone looking for "why did my tabs vanish"
    // scans for, and it was once easy to miss below the search engine.
    {
      key: 'restoreTabs',
      label: 'Reopen your tabs when you start',
      hint: 'Off starts with a fresh tab each time. Reopened tabs load when you visit them.',
      type: 'checkbox'
    },
    {
      key: 'startupSites',
      label: 'Open these sites when you start',
      hint: 'One address per line. They wait asleep until you click one, so they cost almost nothing. Pinned tabs always come back.',
      type: 'textarea',
      placeholder: 'mail.google.com\ngithub.com',
      startupFill: true
    },
    { key: 'searchEngine', label: 'Search engine', type: 'select', options: 'engines' },
    {
      key: 'siteShortcuts',
      label: 'Site search shortcuts',
      hint: 'Type the word, a space and your search in the address bar - "yt cats" searches YouTube. One per line: the word, a name, then the address with %s where the search goes.',
      type: 'textarea',
      placeholder: 'yt  YouTube  https://www.youtube.com/results?search_query=%s',
      rows: 6
    },
    {
      key: 'autoPip',
      label: 'Keep a playing video in view when you switch tabs',
      hint: 'A video playing with sound pops out into a small window over everything, and goes back when you return to its tab.',
      type: 'checkbox'
    },
    {
      key: 'inlineAutocomplete',
      label: 'Complete addresses as I type',
      hint: 'Fills in the rest of a site you’ve visited.',
      type: 'checkbox'
    },
    {
      key: 'bookmarkOpensIn',
      label: 'Clicking a bookmark',
      hint: 'Ctrl-click always opens a new tab.',
      type: 'select',
      options: [
        { value: 'new-tab', name: 'Opens a new tab' },
        { value: 'current-tab', name: 'Replaces the current tab' }
      ]
    },
    {
      key: 'homepage',
      label: 'New tab page',
      hint: 'Leave empty for the built-in page.',
      type: 'text',
      placeholder: 'https://'
    },
    {
      key: 'defaultZoom',
      label: 'Page zoom',
      hint: 'For sites you haven’t zoomed yourself.',
      type: 'select',
      numeric: true,
      options: [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
        .map((f) => ({ value: String(f), name: `${Math.round(f * 100)}%` }))
    },
    {
      key: 'clearHistoryOnExit',
      label: 'Clear history when I close the browser',
      hint: 'Bookmarks and passwords stay.',
      type: 'checkbox'
    },
    {
      key: 'warnDangerousSites',
      label: 'Warn before dangerous sites',
      hint: 'Before known phishing or malware sites, and lookalike names of sites you use. Checked on this computer.',
      type: 'checkbox'
    },
    {
      key: 'httpsMode',
      label: 'Secure connections',
      hint: 'Tries HTTPS first and asks before loading an insecure page.',
      type: 'select',
      options: [
        { value: 'upgrade', name: 'Use HTTPS where a site has it' },
        { value: 'strict', name: 'Ask before a site without it' },
        { value: 'off', name: 'Don’t upgrade' }
      ]
    },
    {
      key: 'secureDns',
      label: 'Secure DNS',
      hint: 'Looks up sites over HTTPS so your network can’t see or change them.',
      type: 'select',
      options: [
        { value: 'automatic', name: 'Automatic' },
        { value: 'cloudflare', name: 'Cloudflare' },
        { value: 'quad9', name: 'Quad9' },
        { value: 'google', name: 'Google' },
        { value: 'mullvad', name: 'Mullvad' },
        { value: 'off', name: 'Off' }
      ]
    },
    {
      key: 'blockThirdPartyCookies',
      label: 'Block other sites’ cookies',
      hint: 'Stops ad networks following you between sites. Allow them for one site from the padlock.',
      type: 'checkbox'
    },
    {
      key: 'cleanLinks',
      label: 'Take tracking out of links',
      hint: 'Strips tracking bits like utm_source and fbclid from links you open and copy.',
      type: 'checkbox'
    },
    {
      key: 'blockAds',
      label: 'Block ads and trackers',
      hint: 'Uses uBlock Origin’s lists, updated weekly. Turn it off for one site from the padlock.',
      type: 'checkbox'
    },
    {
      key: 'hideCookieBanners',
      label: 'Hide cookie notices',
      hint: 'Hides cookie banners without accepting anything.',
      type: 'checkbox'
    }
  ],

  tabs: [
    {
      key: 'newTabPosition',
      label: 'Tabs opened from links',
      type: 'select',
      options: [
        { value: 'end', name: 'Go at the end' },
        { value: 'after-current', name: 'Go next to the current tab' }
      ]
    },
    {
      key: 'linkTabsInBackground',
      label: 'Open links in the background',
      type: 'checkbox'
    },
    {
      key: 'tabCycleOrder',
      label: 'Ctrl+Tab goes to',
      hint: 'Ctrl+Page Down always goes to the next tab along.',
      type: 'select',
      options: [
        { value: 'recent', name: 'The tab you used last' },
        { value: 'strip', name: 'The next tab along' }
      ]
    },
    {
      key: 'lastTabCloses',
      label: 'Closing the last tab',
      type: 'select',
      options: [
        { value: 'quit', name: 'Closes the window' },
        { value: 'new-tab', name: 'Leaves a new tab open' }
      ]
    },
    {
      key: 'closedTabToast',
      label: 'Offer Undo when a tab closes',
      hint: 'Ctrl+Shift+T reopens a closed tab either way.',
      type: 'checkbox'
    },
    {
      key: 'confirmCloseTabs',
      label: 'Ask before closing a window with several tabs',
      type: 'checkbox'
    },
    {
      key: 'autoArchiveDays',
      label: 'Put away tabs I haven’t opened',
      hint: 'Old tabs move to an archive. Find them again with Ctrl+Shift+A.',
      type: 'select',
      numeric: true,
      options: [
        { value: '0', name: 'Never' },
        { value: '1', name: 'After a day' },
        { value: '7', name: 'After a week' },
        { value: '30', name: 'After a month' }
      ]
    },
    {
      key: 'tabCloseButton',
      label: 'Close buttons on tabs',
      type: 'select',
      options: [
        { value: 'hover', name: 'On hover and the current tab' },
        { value: 'always', name: 'Always' }
      ]
    },
    {
      key: 'preloadPages',
      label: 'Preload pages you point at',
      hint: 'Starts loading a link while you hover over it, so pages open sooner.',
      type: 'checkbox'
    },
    {
      key: 'hoverPrefetch',
      label: 'Preload tabs when I hover them',
      hint: 'Hovering a sleeping tab starts waking it.',
      type: 'checkbox'
    },
    {
      key: 'rememberWindowBounds',
      label: 'Remember the window size and position',
      hint: 'Applies after a restart.',
      type: 'checkbox'
    }
  ],

  resources: [
    {
      key: 'tabSleep',
      label: 'Put tabs to sleep',
      hint: 'A sleeping tab frees its memory and reloads when you come back. Tabs playing sound or on a call stay awake.',
      type: 'select',
      options: [
        { value: 'auto', name: 'Automatically' },
        { value: 'instant', name: 'As soon as I leave them' },
        { value: '1', name: 'After 1 minute' },
        { value: '5', name: 'After 5 minutes' },
        { value: '10', name: 'After 10 minutes' },
        { value: '15', name: 'After 15 minutes' },
        { value: '30', name: 'After 30 minutes' },
        { value: '60', name: 'After 1 hour' },
        { value: '120', name: 'After 2 hours' }
      ]
    },
    {
      key: 'batteryMode',
      label: 'Battery mode',
      hint: 'Tabs sleep sooner, background tabs use less power, and a leaf shows in the memory meter.',
      type: 'select',
      options: [
        { value: 'auto', name: 'On battery' },
        { value: 'always', name: 'Always' },
        { value: 'off', name: 'Off' }
      ]
    },
    {
      key: 'memoryBudgetMB',
      label: 'Memory budget',
      hint: 'Empty sizes it to this computer.',
      type: 'number',
      placeholder: 'Automatic',
      min: 256,
      max: 65536,
      unit: 'MB'
    },
    {
      key: 'maxLiveTabs',
      label: 'Tabs holding a renderer',
      hint: 'Tabs past this stay listed but free their memory. 0 removes the limit.',
      type: 'number',
      placeholder: 'Automatic',
      min: 0,
      max: 200
    }
  ],

  downloads: [
    {
      key: 'downloadConnections',
      label: 'Connections per download',
      hint: 'Parts downloaded at once.',
      type: 'number',
      min: 1,
      max: 16
    },
    {
      key: 'askWhereToSave',
      label: 'Ask where to save each file',
      type: 'checkbox'
    },
    {
      key: 'downloadDir',
      label: 'Save files to',
      hint: 'Empty uses your Downloads folder.',
      type: 'text',
      placeholder: 'Your Downloads folder'
    }
  ],

  private: [
    {
      key: 'incognitoSearchEngine',
      label: 'Search engine',
      hint: 'Google answers most Tor connections with a captcha.',
      type: 'select',
      options: 'engines'
    },
    {
      key: 'incognitoBridges',
      label: 'Connect to Tor',
      hint: 'Hides from your network that you use Tor.',
      type: 'select',
      options: [
        { value: 'auto', name: 'Through Snowflake (built in)' },
        { value: 'obfs4', name: 'Through obfs4 bridges (built in)' },
        { value: 'custom', name: 'Through my own bridges' },
        { value: 'none', name: 'Directly – fastest, and your ISP can see Tor' }
      ]
    },
    {
      key: 'incognitoBridgeLines',
      label: 'My bridges',
      hint: 'One per line, as your bridge provider gives them.',
      type: 'textarea',
      placeholder: 'obfs4 203.0.113.5:443 FINGERPRINT cert=… iat-mode=0'
    },
    {
      key: 'incognitoJsLevel',
      label: 'JavaScript security',
      // The costs are measured, by bench/js-levels: everyday page work (DOM,
      // JSON) runs the same at every level; heavy number-crunching and
      // WebAssembly are where the optimising compilers earn their keep.
      hint: 'Balanced keeps everyday pages fast and heavy apps about half speed. Maximum is safest and slowest.',
      type: 'select',
      options: [
        { value: 'balanced', name: 'Balanced' },
        { value: 'maximum', name: 'Maximum' },
        { value: 'full', name: 'Full speed' }
      ]
    },
    {
      key: 'incognitoKeepTorState',
      label: 'Remember Tor between sessions',
      hint: 'Connects in seconds by keeping the same entry guard. Off leaves no trace of Tor here.',
      type: 'checkbox'
    },
    {
      key: 'incognitoPreferOnion',
      label: 'Use onion addresses when sites offer them',
      type: 'checkbox'
    },
    {
      key: 'incognitoCamouflage',
      label: 'Traffic camouflage',
      hint: 'Loads a decoy site beside each real one, so your traffic is harder to read. Uses about twice the data.',
      type: 'checkbox'
    },
    {
      key: 'incognitoKeepWarm',
      label: 'Keep a private window ready',
      hint: 'Private windows open instantly. Uses about 300 MB while Debrowser is open.',
      type: 'checkbox'
    },
    {
      key: 'incognitoIdleWipeMinutes',
      label: 'Close private windows when idle',
      hint: 'Erases everything after this many idle minutes. 0 never closes them.',
      type: 'number',
      min: 0,
      max: 240,
      unit: 'min'
    }
  ],

  credentials: [
    {
      key: 'fillPasswords',
      label: 'Fill saved passwords automatically',
      hint: 'Passwords only, and only when one saved sign-in matches the site.',
      unavailable: () => credentialsUnavailable,
      type: 'checkbox'
    }
  ],

  advanced: [
    {
      key: 'hardenJavaScript',
      label: 'JavaScript security',
      hint: 'The private window’s protection, in every window. Balanced suits most pages; Maximum is slower. Applies after a restart.',
      type: 'select',
      options: [
        { value: 'full', name: 'Full speed' },
        { value: 'balanced', name: 'Balanced' },
        { value: 'maximum', name: 'Maximum' }
      ]
    },
    {
      key: 'showMemoryDetail',
      label: 'Explain the memory figures',
      type: 'checkbox'
    },
    {
      key: 'hardwareAcceleration',
      label: 'Use hardware acceleration',
      hint: 'Try this if pages flicker. Needs a restart.',
      type: 'checkbox'
    },
    {
      key: 'devToolsDock',
      label: 'Developer tools open',
      type: 'select',
      options: [
        { value: 'right', name: 'Beside the page' },
        { value: 'bottom', name: 'Under the page' },
        { value: 'window', name: 'In their own window' }
      ]
    }
  ],

  labs: [
    {
      key: 'labTabGroups',
      label: 'Tab groups',
      hint: 'Right-click a tab to start a group. Folded groups go to sleep.',
      type: 'checkbox'
    },
    {
      key: 'labQuickWindow',
      label: 'A small window for links from other apps',
      hint: 'Links from other apps open in a small window. Keep one as a tab with Open in Debrowser.',
      type: 'checkbox'
    },
    {
      key: 'labExtensions',
      label: 'Chrome and Firefox extensions',
      hint: 'Add from the Chrome Web Store, Edge or Firefox Add-ons, or from a file; popups open from the puzzle button. Never in private windows.',
      type: 'checkbox'
    }
  ],

  updates: [
    {
      key: 'autoUpdate',
      label: 'Install updates automatically',
      hint: 'Downloads only what changed.',
      unavailable: (state) => (state.updates && state.updates.available === false
        ? sentence(state.updates.reason || 'Updates aren’t available for this copy.') : ''),
      type: 'checkbox'
    },
    {
      key: 'updateChannel',
      label: 'Update channel',
      hint: 'Beta gets new releases a few weeks early.',
      type: 'select',
      options: [
        { value: 'stable', name: 'Stable' },
        { value: 'beta', name: 'Beta' }
      ]
    }
  ]
};

/**
 * How often a slider being dragged may write its value through.
 *
 * Fast enough that the browser appears to follow the thumb, slow enough that a
 * drag across the range is a handful of writes rather than one per pixel.
 */
const LIVE_SET_MS = 120;

/** Built controls, keyed by preference, so state only ever writes values. */
const controls = new Map();
let engines = [];
let built = false;

/* ------------------------------------------------------------------ */
/* Building                                                            */
/* ------------------------------------------------------------------ */

function buildAll(state = {}) {
  for (const [sectionId, rows] of Object.entries(SECTIONS)) {
    // By attribute, not id. An id named like the section is what a
    // `settings#browsing` link scrolls to by itself, and it landed on these
    // rows with the section's heading above the top of the page.
    const host = document.querySelector(`[data-rows="${sectionId}"]`);
    for (const row of rows) host.append(buildRow(row));
  }
  // Not preferences, so not descriptors: the tour to take again, and asking
  // the system to make this the default browser. Neither in a private window,
  // which is never the default and has nothing to set up.
  if (!state.incognito) {
    document.querySelector('[data-rows="appearance"]').prepend(welcomeRow());
    document.querySelector('[data-rows="browsing"]').prepend(defaultBrowserRow(), safetyRow());
    extensionRows(document.querySelector('[data-rows="labs"]'));
    const advanced = document.querySelector('[data-rows="advanced"]');
    setupRows(advanced);
    window.addEventListener('focus', () => setupRows(advanced));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) setupRows(advanced); });
  }
  built = true;
}

/*
 * Extensions (a Lab): each installed one - its name, where it came from, and
 * Remove - then Add, from a packed file (.crx, .xpi, .zip) or an unpacked
 * folder. Shown while the Lab is on; the browser picks the file, so this
 * page never sees a path.
 */
function extensionRows(host) {
  const box = document.createElement('div');
  box.className = 'extension-rows';
  host.append(box);
  // From the preference as the browser last sent it, not the box: the first
  // state arrives after the page is built.
  let on = false;
  const toggle = () => on;
  const render = async () => {
    box.hidden = !toggle();
    if (box.hidden) return;
    const res = await api.request('extensions-list');
    const rows = ((res && res.items) || []).map((ext) => {
      const where = ext.from === 'firefox' ? 'Firefox' : 'Chrome';
      const { row, control } = simpleRow(`${ext.name} ${ext.version}`,
        ext.error ? `${where} extension. It didn’t start: ${ext.error}` : `${where} extension`);
      const remove = smallButton('Remove');
      remove.addEventListener('click', async () => {
        await api.request('extension-remove', { id: ext.id });
        render();
      });
      control.append(remove);
      return row;
    });
    const { row: addRow, note, control } = simpleRow('Add an extension',
      'A .crx from Chrome, a .xpi from Firefox, or an unpacked folder.');
    const addFile = smallButton('From a file');
    const addFolder = smallButton('From a folder');
    const add = async (folder) => {
      const r = await api.request('extension-add', { folder });
      if (r && r.ok) note.textContent = r.loadError ? `${r.name} was added but didn’t start: ${r.loadError}` : `${r.name} added.`;
      else if (r && !r.cancelled) note.textContent = r.reason || 'That couldn’t be added.';
      if (r && r.ok) render();
    };
    addFile.addEventListener('click', () => add(false));
    addFolder.addEventListener('click', () => add(true));
    control.append(addFile, addFolder);
    // From a store: the extension's page address, pasted. The browser fetches
    // and adds it, and says how it went at the foot of the window.
    const { row: storeRow, control: storeControl } = simpleRow('Add from a store',
      'Paste an extension’s page from the Chrome Web Store, Edge Add-ons or Firefox Add-ons.');
    const link = document.createElement('input');
    link.type = 'text';
    link.placeholder = 'https://chromewebstore.google.com/detail/…';
    link.setAttribute('aria-label', 'Store page address');
    const addLink = smallButton('Add');
    const go = () => {
      const url = link.value.trim();
      if (!url) return;
      api.send('add-extension-from-store', { url });
      link.value = '';
      setTimeout(render, 4000);
    };
    addLink.addEventListener('click', go);
    link.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    storeControl.append(link, addLink);
    box.replaceChildren(...rows, addRow, storeRow);
  };
  api.onState((state) => {
    const now = state?.prefs?.labExtensions === true;
    if (now !== on) { on = now; render(); }
  });
  render();
}

function welcomeRow() {
  const { row, control } = simpleRow('Welcome tour', 'Import, look, search and default browser, one step at a time.');
  const open = smallButton('Open');
  open.addEventListener('click', () => api.send('open-welcome'));
  control.append(open);
  return row;
}

/*
 * Spaces (spaces.js): one row each - its name to edit, its colour, and Remove
 * for any but Home - then the two ways to make one. Rebuilt when the list
 * changes, and never while a name is being typed.
 */
const SPACE_COLOURS = ['#2f857b', '#6f8f5f', '#a8694a', '#b08a3c', '#7b6a9c', '#5f7d9c', '#b0306a'];
let spacesDrawn = '';
let spacesPrefs = {};
function renderSpaces(spaces, prefs = {}) {
  spacesPrefs = prefs;
  const host = document.querySelector('[data-rows="spaces"]');
  const section = host && host.closest('section');
  if (!host) return;
  if (!spaces) { section.hidden = true; return; }
  const key = JSON.stringify([spaces.list, prefs.externalLinksSpace]);
  if (key === spacesDrawn || host.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  spacesDrawn = key;
  const rows = spaces.list.map((sp) => {
    const { row, control } = simpleRow('', sp.id === 'home'
      ? 'Where Debrowser starts. Spaces without cookies of their own share Home’s.'
      : sp.container
        ? 'Its own cookies and sign-ins: sites here don’t see those in your other spaces.'
        : 'Shares cookies and sign-ins with Home.');
    const name = document.createElement('input');
    name.type = 'text';
    name.value = sp.name;
    name.maxLength = 40;
    name.className = 'space-name-input';
    name.setAttribute('aria-label', `Name of the space ${sp.name}`);
    name.addEventListener('change', () => api.send('edit-space', { id: sp.id, name: name.value }));
    row.querySelector('.row-label').replaceWith(name);
    const swatches = document.createElement('div');
    swatches.className = 'space-swatches';
    for (const colour of SPACE_COLOURS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.color = colour;
      b.setAttribute('aria-label', 'Colour');
      b.setAttribute('aria-pressed', String(colour.toLowerCase() === sp.color.toLowerCase()));
      b.addEventListener('click', () => api.send('edit-space', { id: sp.id, color: colour }));
      swatches.append(b);
    }
    control.append(swatches);
    if (sp.id !== 'home') {
      const remove = smallButton('Remove', 'ghost-btn danger');
      remove.title = sp.container ? 'Its tabs move to Home and open again there, signed in as Home is.' : 'Its tabs move to Home.';
      remove.addEventListener('click', () => api.send('delete-space', { id: sp.id }));
      control.append(remove);
    }
    return row;
  });
  // Where links from other apps go: the space in front, or one of these.
  const { row: route, control: routeControl } = simpleRow('Links from other apps open in',
    'Mail, chat and documents hand their links to Debrowser; this is the space they land in.');
  const pick = document.createElement('select');
  pick.setAttribute('aria-label', 'Space for links from other apps');
  for (const [value, name] of [['current', 'The space I am in'], ...spaces.list.map((sp) => [sp.id, sp.name])]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = name;
    pick.append(option);
  }
  pick.value = spacesPrefs.externalLinksSpace && spaces.list.some((sp) => sp.id === spacesPrefs.externalLinksSpace)
    ? spacesPrefs.externalLinksSpace : 'current';
  pick.addEventListener('change', () => api.send('set-pref', { key: 'externalLinksSpace', value: pick.value }));
  routeControl.append(pick);

  const { row: add, control } = simpleRow('New space', 'Work, a project, a trip: a set of tabs you switch between. Spaces you leave go to sleep after half a minute.');
  const plain = smallButton('New space');
  plain.addEventListener('click', () => api.send('new-space', {}));
  const own = smallButton('With its own cookies');
  own.title = 'Sign in to the same site with another account';
  own.addEventListener('click', () => api.send('new-space', { container: true }));
  control.append(plain, own);
  host.replaceChildren(...rows, ...(spaces.list.length > 1 ? [route] : []), add);
}

function safetyRow() {
  const { row, control } = simpleRow('Safety check', 'Every protection in one place, with anything that needs you.');
  const open = smallButton('Open');
  open.addEventListener('click', () => api.send('open-safety'));
  control.append(open);
  return row;
}

/**
 * Installing and uninstalling, last in Advanced. Each opens its own window
 * (src/main/setup/setup-window.js); the rows appear only when there is something to
 * do - nothing to install on Windows or from the .deb, nothing to remove from
 * a copy that was never installed. Asked again whenever Settings comes back
 * into view, since an install done meanwhile leaves nothing to install.
 */
async function setupRows(host) {
  const status = await api.request('setup-status').catch(() => null);
  for (const old of host.querySelectorAll('.setup-row')) old.remove();
  if (!status) return;
  if (status.install) {
    const { row, control } = simpleRow('Install Debrowser',
      api.platform === 'darwin' ? 'Running from outside Applications, it can’t keep itself up to date.'
        : 'Add it to your apps menu, so it starts like any other app.');
    const go = smallButton(status.install);
    go.addEventListener('click', () => api.send('install-browser'));
    control.append(go);
    row.classList.add('setup-row');
    host.append(row);
  }
  if (status.uninstall) {
    const { row, control } = simpleRow('Uninstall Debrowser', 'Remove it from this computer, keeping or deleting your browsing data.');
    const go = smallButton('Uninstall…');
    go.addEventListener('click', () => api.send('uninstall-browser'));
    control.append(go);
    row.classList.add('setup-row');
    host.append(row);
  }
}

function defaultBrowserRow() {
  const { row, note, control } = simpleRow('Default browser', '');
  const make = smallButton('Make default');
  make.addEventListener('click', () => api.send('make-default'));
  control.append(make);
  const refresh = async () => {
    const res = await api.request('default-browser-status');
    const isDefault = Boolean(res && res.isDefault);
    note.textContent = isDefault
      ? 'Debrowser is your default browser.'
      : 'Links from other apps open in another browser.';
    make.hidden = isDefault;
  };
  refresh();
  // Back from the system's own settings is when it may have changed.
  window.addEventListener('focus', refresh);
  return row;
}

/**
 * Scroll to the section the address asked for, and say which one it was.
 *
 * `debrowser://settings#downloads` from the menu lands here. Done once, after
 * the page is built - the controls are generated, so before that there is
 * nothing to scroll to - and the brief highlight matters as much as the scroll:
 * a page that jumps to the middle of itself with no explanation reads as a page
 * that failed to load its top half.
 */
function revealSection() {
  const wanted = decodeURIComponent(location.hash.slice(1));
  const section = wanted && document.querySelector(`section[data-section="${CSS.escape(wanted)}"]`);
  // A section at a time: that one, or the first when none was asked for.
  if (pagesLayout()) showPage(section ? wanted : currentPage);
  if (!section) return;
  if (!pagesLayout()) {
    section.scrollIntoView({ block: 'start', behavior: 'auto' });
    holdInView(section);
  }
  section.classList.add('landed');
  // Removed rather than left on the element: it is an arrival, not a state, and
  // a highlight that never goes away is just a differently coloured section.
  setTimeout(() => section.classList.remove('landed'), 1400);
}

/**
 * Keep a section where the jump put it while the page finishes filling in.
 *
 * Passwords, bookmarks and downloads draw their lists a moment after the page
 * is built, above most sections, and each one pushed the section down by its
 * own height: `#labs` opened at Private windows, two sections short. So for a
 * moment the section is put back whenever the page changes size - until the
 * user scrolls themselves, which is their answer and not ours to undo.
 */
function holdInView(section) {
  const main = document.querySelector('main');
  // Where this put the page last. Any scroll that lands somewhere else came
  // from the reader - a wheel, a key, the scrollbar dragged, a trackpad, a
  // script - and ends the hold at once: holding against it snapped the page
  // back for two seconds after someone had scrolled it themselves.
  let placed = main ? main.scrollTop : 0;
  const put = () => {
    section.scrollIntoView({ block: 'start', behavior: 'auto' });
    if (main) placed = main.scrollTop;
  };
  const observer = new ResizeObserver(put);
  const moved = () => { if (main && Math.abs(main.scrollTop - placed) > 1) stop(); };
  const stop = () => {
    observer.disconnect();
    if (main) main.removeEventListener('scroll', moved);
    for (const type of ['wheel', 'keydown', 'pointerdown', 'touchstart']) window.removeEventListener(type, stop, true);
  };
  // The sections, not <main>: main is the scroller, so its own box never
  // changes size however much its content grows.
  for (const el of document.querySelectorAll('main > section')) observer.observe(el);
  if (main) main.addEventListener('scroll', moved, { passive: true });
  for (const type of ['wheel', 'keydown', 'pointerdown', 'touchstart']) window.addEventListener(type, stop, true);
  setTimeout(stop, 2000);
}

// Asked for a section while already open - the passwords page's "Set a
// passcode", the menu's Bookmarks: the browser changes the fragment in place.
window.addEventListener('hashchange', () => { if (built) revealSection(); });

function buildRow(spec) {
  const row = document.createElement('div');
  row.className = 'row';

  const text = document.createElement('div');
  text.className = 'row-text';

  const label = document.createElement('label');
  label.className = 'row-label';
  label.textContent = spec.label;
  text.append(label);

  let hint = null;
  if (spec.hint || spec.unavailable) {
    hint = document.createElement('span');
    hint.className = 'row-hint';
    hint.textContent = spec.hint || '';
    text.append(hint);
  }

  const holder = document.createElement('div');
  holder.className = 'row-control';
  const control = buildControl(spec);
  holder.append(control.node);
  if (control.input) {
    control.input.id = `pref-${spec.key}`;
    label.htmlFor = control.input.id;
  }

  // The startup list can be filled from the sites you go to most, which is
  // what most people would type into it anyway.
  if (spec.startupFill) {
    const fill = smallButton('Use my most-used sites');
    fill.addEventListener('click', async () => {
      const res = await api.request('top-sites', { limit: 6 });
      const urls = ((res && res.items) || []).map((item) => item.url).filter(Boolean);
      if (!urls.length) { if (hint) hint.textContent = 'Nothing yet: visit a few sites first.'; return; }
      control.input.value = urls.join('\n');
      save(spec.key, control.input.value);
    });
    holder.classList.add('row-control-stack');
    holder.append(fill);
  }

  row.append(text, holder);
  Object.assign(control, { spec, row, hint });
  controls.set(spec.key, control);
  return row;
}

function buildControl(spec) {
  switch (spec.type) {
    case 'select': {
      const select = document.createElement('select');
      // `numeric` for a choice of numbers, `boolean` for a choice between a
      // setting on and off: an option's value is always a string.
      select.addEventListener('change', () =>
        save(spec.key, spec.numeric ? Number(select.value) : spec.boolean ? select.value === 'true' : select.value));
      return {
        node: select,
        input: select,
        // Options are filled on write, because the engine list arrives with
        // state rather than being known at build time.
        write(value) {
          const options = spec.options === 'engines'
            ? engines.map((e) => ({ value: e.id, name: e.name }))
            : spec.options;
          if (select.childElementCount !== options.length) {
            select.replaceChildren(...options.map((o) => {
              const node = document.createElement('option');
              node.value = o.value;
              node.textContent = o.name;
              return node;
            }));
          }
          if (select.value !== String(value)) select.value = String(value);
        }
      };
    }

    case 'checkbox': {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => save(spec.key, box.checked));
      return {
        node: box,
        input: box,
        write(value) { if (box.checked !== value) box.checked = Boolean(value); }
      };
    }

    case 'text': {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = spec.placeholder || '';
      input.addEventListener('change', () => save(spec.key, input.value.trim()));
      return {
        node: input,
        input,
        write(value) { if (document.activeElement !== input) input.value = value || ''; }
      };
    }

    case 'textarea': {
      const input = document.createElement('textarea');
      input.rows = spec.rows || 3;
      input.spellcheck = false;
      input.placeholder = spec.placeholder || '';
      input.addEventListener('change', () => save(spec.key, input.value.trim()));
      return {
        node: input,
        input,
        write(value) { if (document.activeElement !== input) input.value = value || ''; }
      };
    }

    case 'number': {
      const input = document.createElement('input');
      input.type = 'number';
      input.placeholder = spec.placeholder || '';
      if (spec.min != null) input.min = String(spec.min);
      if (spec.max != null) input.max = String(spec.max);
      input.addEventListener('change', () => {
        // An empty field is not zero. It means "no preference" - let the browser
        // size this to the machine - and zero is a meaningful value for the tab
        // cap, so the two must not collapse into each other.
        const raw = input.value.trim();
        save(spec.key, raw === '' ? null : Number(raw));
      });

      if (!spec.unit) return { node: input, input, write: writeNumber };

      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = spec.unit;
      const wrap = document.createDocumentFragment();
      wrap.append(input, unit);
      return { node: wrap, input, write: writeNumber };

      function writeNumber(value) {
        if (document.activeElement === input) return;
        const next = value == null ? '' : String(value);
        if (input.value !== next) input.value = next;
      }
    }

    case 'range': {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      const out = document.createElement('span');
      out.className = 'unit';

      const show = (v) => { out.textContent = spec.format ? spec.format(v) : String(v); };

      /*
       * The thing being set changes as the slider moves, not when it is let go.
       *
       * Translucency is the reason this matters: it is a setting you judge by
       * looking at it, and a slider that shows a number while the browser stays
       * as it was until you release is one you have to guess with. So the value
       * is sent while dragging.
       *
       * Rate-limited rather than sent per event, because every send is a write
       * to disk and a relayout: a drag across the range fires forty of them, and
       * forty atomic file writes for one decision is exactly the kind of waste
       * this browser is about. The trailing `change` is what stores the value
       * the user actually stopped on, whichever side of the window it lands.
       */
      const toSlider = spec.toSlider || ((v) => v);
      const fromSlider = spec.fromSlider || ((v) => v);
      // The filled part of the track, which the stylesheet draws.
      const fill = () => {
        const span = Number(input.max) - Number(input.min);
        input.style.setProperty('--fill', `${span ? ((Number(input.value) - Number(input.min)) / span) * 100 : 0}%`);
      };
      // Held from press to release, whatever has focus: a drag with the mouse
      // or a finger does not always focus the slider, and the broadcast of the
      // last saved value then pulled the thumb back under the pointer.
      let held = false;
      input.addEventListener('pointerdown', () => { held = true; });
      window.addEventListener('pointerup', () => { held = false; });
      window.addEventListener('pointercancel', () => { held = false; });

      let sentAt = 0;
      let pending = null;
      const push = () => {
        pending = null;
        sentAt = Date.now();
        save(spec.key, fromSlider(Number(input.value)));
      };

      input.addEventListener('input', () => {
        show(Number(input.value));
        fill();
        if (pending) return;
        const wait = Math.max(0, LIVE_SET_MS - (Date.now() - sentAt));
        pending = setTimeout(push, wait);
      });
      input.addEventListener('change', () => {
        if (pending) { clearTimeout(pending); pending = null; }
        push();
      });

      const wrap = document.createDocumentFragment();
      wrap.append(input, out);
      return {
        node: wrap,
        input,
        write(value) {
          const v = toSlider(Number(value));
          // Neither the thumb nor its label while it is being dragged: the
          // broadcast carries the last *saved* value, and the label jumped
          // back to it on every tick.
          if (held || document.activeElement === input) return;
          input.value = String(v);
          show(v);
          fill();
        }
      };
    }

    case 'stripColor': {
      const wrap = document.createElement('div');
      wrap.className = 'swatches';

      const choices = [
        { value: 'default', name: 'Default', css: 'var(--bg)' },
        { value: 'mirror', name: 'Match the accent colour', css: 'var(--accent)' },
        ...STRIP_COLORS
      ];
      const buttons = choices.map(({ value, name, css }) => {
        const button = document.createElement('button');
        button.className = 'swatch';
        button.style.background = css;
        button.title = name;
        button.setAttribute('aria-label', name);
        button.setAttribute('aria-pressed', 'false');
        if (value === 'mirror') button.classList.add('mirror');
        button.addEventListener('click', () => save(spec.key, value));
        wrap.append(button);
        return { button, value };
      });
      return {
        node: wrap,
        input: null,
        write(value) {
          for (const { button, value: own } of buttons) {
            button.setAttribute('aria-pressed', String(own === value));
          }
        }
      };
    }

    case 'accent': {
      const wrap = document.createElement('div');
      wrap.className = 'swatches';
      const buttons = ACCENTS.map(({ value, name }) => {
        const button = document.createElement('button');
        button.className = 'swatch';
        button.style.background = value;
        button.title = name;
        button.setAttribute('aria-label', name);
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => save(spec.key, value));
        wrap.append(button);
        return { button, value };
      });
      // The system's own accent - Windows' personalisation colour, or macOS's -
      // followed as it changes. Shown only where there is one (systemAccent on
      // the state broadcast), in that colour.
      const system = document.createElement('button');
      system.className = 'swatch swatch-system';
      system.id = 'accent-system';
      system.hidden = true;
      system.title = 'Your system’s accent colour';
      system.setAttribute('aria-label', 'System accent colour');
      system.setAttribute('aria-pressed', 'false');
      system.addEventListener('click', () => api.send('set-pref', { key: 'accentFromSystem', value: true }));
      wrap.append(system);
      return {
        node: wrap,
        input: null,
        write(value) {
          const fromSystem = system.getAttribute('aria-pressed') === 'true';
          for (const { button, value: own } of buttons) {
            button.setAttribute('aria-pressed', String(!fromSystem && own === value));
          }
        }
      };
    }

    default:
      throw new Error(`unknown control type "${spec.type}"`);
  }
}

/* ------------------------------------------------------------------ */

function save(key, value) {
  api.send('set-pref', { key, value });
}

// Settings is a tab, so closing it closes the tab - the same thing the × on the
// tab strip does. There is no separate "close settings" concept any more, which
// is the point: the overlay that had one is what trapped the browser on it.
document.getElementById('close').addEventListener('click', () => api.send('close-tab'));
// What each field held when it was focused, so Escape can put it back.
const valueOnFocus = new WeakMap();
document.addEventListener('focusin', (event) => {
  if (event.target.matches?.('input, select, textarea')) valueOnFocus.set(event.target, event.target.value);
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  // Not from inside a field someone is filling in - the bookmark editor, the
  // homepage, a number. Escape there means "never mind this edit": the value
  // goes back to what it was before the blur, so the blur's `change` has
  // nothing to save. Closing the whole page threw away what was typed. The
  // search box has its own Escape, and is the exception.
  const t = event.target;
  if (t && t.id !== 'q' && t.matches && t.matches('input, select, textarea')) {
    // Typed fields only. A list or a slider saves as it changes, so putting
    // back its old value showed a choice that was no longer the setting.
    const typed = t.matches('textarea, input:not([type="range"]):not([type="checkbox"]):not([type="radio"])');
    if (typed && valueOnFocus.has(t)) t.value = valueOnFocus.get(t);
    t.blur();
    return;
  }
  api.send('close-tab');
});

/**
 * The line under the update switch, and the button beside it.
 *
 * `unchecked` is its own case rather than falling through to "Up to date."
 * The first check is a minute after launch, so the old fallback spent that
 * minute asserting a version comparison the browser had not made yet - and it
 * would have gone on asserting it forever with automatic updates switched off.
 */
function renderUpdateState(u) {
  const el = document.getElementById('update-state');
  const button = document.getElementById('check-updates');
  if (!el) return;

  const bar = document.getElementById('update-bar');
  // The bar under the line: hidden, a sweep while there is no figure yet, a
  // fill while bytes arrive, and full once the update is waiting to install.
  const showBar = (mode, percent = 0) => {
    if (!bar) return;
    bar.hidden = !mode;
    if (!mode) return;
    bar.dataset.mode = mode;
    bar.firstElementChild.style.width = mode === 'fill' ? `${Math.max(2, Math.min(100, percent))}%` : '';
  };
  showBar(null);

  if (!u) {
    el.textContent = '';
    if (button) button.hidden = true;
    return;
  }

  if (!u.available) {
    el.textContent = `Updates are unavailable here: ${u.reason}.`;
    if (button) button.hidden = true;
    return;
  }

  const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0);
  switch (u.state) {
    case 'checking':    el.textContent = 'Checking for a new version…'; showBar('sweep'); break;
    case 'available':   el.textContent = u.manual
      ? `${u.version} is available. Download it and drag it into Applications over this one.`
      : `${u.version} is available. Turn on automatic updates to download it.`; break;
    // A figure only once bytes are arriving: an update already on disk from an
    // earlier download goes straight to ready without any.
    case 'downloading':
      if (Number.isFinite(u.progress)) {
        el.textContent = u.bytes
          ? `Downloading ${u.version} – ${mb(u.bytes.done)} of ${mb(u.bytes.total)} MB (${u.progress}%)`
          : `Downloading ${u.version} – ${u.progress}%`;
        showBar('fill', u.progress);
      } else {
        el.textContent = `Getting ${u.version} ready…`;
        showBar('sweep');
      }
      break;
    case 'ready':
      el.textContent = `${u.version} is ready. It installs when you restart Debrowser, which takes a few seconds.`;
      showBar('done');
      break;
    case 'error':       el.textContent = `Last check failed: ${u.error}`; break;
    case 'installing':
      el.textContent = `Installing ${u.version}. Debrowser closes now and opens again by itself in a few seconds.`;
      showBar('sweep');
      break;
    case 'idle':        el.textContent = u.updatedFrom
      ? `Up to date. Updated to this version from ${u.updatedFrom}.` : 'Up to date.'; break;
    default:            el.textContent = u.updatedFrom
      ? `Updated to this version from ${u.updatedFrom}.` : 'Not checked yet.';
  }

  if (button) {
    button.hidden = false;
    // Nothing to ask while an answer is already on its way. A downloaded update
    // waiting for a restart turns the button into the restart: the prompt that
    // offered it may have been dismissed, and this is where people look.
    button.disabled = u.state === 'checking' || u.state === 'downloading' || u.state === 'installing';
    // On macOS the update is installed by hand, so the button fetches it.
    button.dataset.download = String(Boolean(u.manual && u.state === 'available'));
    button.dataset.restart = String(u.state === 'ready');
    button.textContent = button.dataset.download === 'true' ? 'Download'
      : button.dataset.restart === 'true' ? 'Restart to update'
      : u.state === 'installing' ? 'Installing…' : 'Check now';
  }
}

document.getElementById('check-updates')?.addEventListener('click', async (event) => {
  if (event.currentTarget.dataset.restart === 'true') {
    api.send('update-restart');
    return;
  }
  if (event.currentTarget.dataset.download === 'true') {
    api.send('open-link-tab', { url: 'https://github.com/amoguslittleahhh/debrowser/releases/latest', foreground: true });
    return;
  }
  renderUpdateState(await api.request('check-for-updates'));
});

// Labs feedback: a new GitHub issue, labelled so experiments' reports stay together.
document.getElementById('labs-feedback')?.addEventListener('click', () => {
  api.send('open-link-tab', {
    url: 'https://github.com/amoguslittleahhh/debrowser/issues/new?labels=labs&title=Labs%3A%20',
    foreground: true
  });
});

/*
 * Looking at the Updates section is asking the question.
 *
 * The browser used to check every six hours for the life of a window, which is
 * it reaching out to GitHub on a schedule nobody asked for. It checks on launch,
 * when you press the button, and here - because scrolling to a section headed
 * "Updates" to read whether you have one is the same request as pressing it.
 *
 * The browser rate-limits this, so scrolling past twice is one check; see
 * MIN_AUTO_INTERVAL_MS in updater.js. The observer is disconnected after the
 * first sighting anyway, since a section that has been seen once has been asked
 * about once. It is sent as `auto`, so it is held to the automatic-updates
 * switch too: with that off, looking is not asking - only the button is.
 */
{
  const section = document.querySelector('section[data-section="updates"]');
  if (section && typeof IntersectionObserver === 'function') {
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      api.request('check-for-updates', { auto: true }).then(renderUpdateState);
    }, { threshold: 0.4 });
    seen.observe(section);
  }
}

/* ------------------------------------------------------------------ */
/* Saved sign-ins and payment details                                  */
/* ------------------------------------------------------------------ */

/*
 * The passcode, and a way to the passwords page.
 *
 * The saved records themselves are not here: they live on
 * debrowser://passwords, behind the lock (src/main/data/vault.js), and this page
 * cannot ask for them. What it can do is set the passcode that turns the
 * feature on, change it, or take it away - which turns the feature off and
 * deletes what was saved.
 */
async function renderPasscode() {
  const host = document.getElementById('passcode-rows');
  const state = document.getElementById('credential-state');
  if (!host) return;
  const status = await api.request('vault-status');
  if (!status) return;

  if (!status.available) {
    credentialsUnavailable = 'Saving isn’t available on this computer.';
    state.textContent = `Saving is unavailable: ${status.reason}. Nothing is written to disk ` +
                        'unless it can be encrypted by the operating system.';
    host.replaceChildren();
    remarkControls();
    return;
  }
  credentialsUnavailable = status.configured ? '' : 'Set a passcode first.';
  state.textContent = status.configured
    ? 'Saved passwords and cards are on. They open with the passcode, or Windows Hello or Touch ID where this computer has it.'
    : 'Off until you set a passcode. Nothing is saved or filled without one.';

  const rows = [passcodeRow(status)];
  if (status.configured) rows.push(openRow());
  host.replaceChildren(...rows);
  remarkControls();
  reapplyFilter();
}

/** Redraw the controls that depend on the passcode (fill passwords). */
function remarkControls() {
  const fill = controls.get('fillPasswords');
  if (fill) markUnavailable(fill, credentialsUnavailable);
}

function simpleRow(title, hint) {
  const row = document.createElement('div');
  row.className = 'row';
  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = title;
  const note = document.createElement('span');
  note.className = 'row-hint';
  note.textContent = hint;
  text.append(label, note);
  const control = document.createElement('div');
  control.className = 'row-control';
  row.append(text, control);
  return { row, note, control };
}

function smallButton(text, className = 'ghost-btn') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  return b;
}

function openRow() {
  const { row, control } = simpleRow('Saved passwords and cards', 'See, copy, add and delete them.');
  const open = smallButton('Open');
  open.addEventListener('click', () => api.send('open-passwords'));
  control.append(open);
  return row;
}

/**
 * The passcode row: Set when there is none; Change and Remove when there is.
 * Each opens a small form in the row rather than a dialog.
 */
function passcodeRow(status) {
  const { row, note, control } = simpleRow('Passcode',
    status.configured ? 'Unlocks saved passwords when Windows Hello or Touch ID can’t.'
      : `Turns saved passwords on. At least ${status.minLength} characters.`);

  const form = document.createElement('form');
  form.className = 'passcode-form';
  form.hidden = true;
  form.autocomplete = 'off';
  const error = document.createElement('p');
  error.className = 'note error';
  error.setAttribute('role', 'alert');

  const field = (placeholder) => {
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    input.autocomplete = 'new-password';
    return input;
  };

  const openForm = (mode) => {
    form.replaceChildren();
    error.textContent = '';
    const current = status.configured ? field('Current passcode') : null;
    const next = mode === 'remove' ? null : field(status.configured ? 'New passcode' : 'Passcode');
    const again = mode === 'remove' ? null : field('Type it again');
    const submit = smallButton(mode === 'remove' ? 'Remove and delete saved items' : 'Save passcode',
      mode === 'remove' ? 'ghost-btn danger' : 'ghost-btn');
    submit.type = 'submit';
    const cancel = smallButton('Cancel');
    cancel.addEventListener('click', () => { form.hidden = true; form.replaceChildren(); });
    form.append(...[current, next, again].filter(Boolean), submit, cancel, error);
    if (mode === 'remove') {
      const warn = document.createElement('p');
      warn.className = 'note';
      warn.textContent = 'This turns saved passwords off and deletes every saved sign-in and card, ' +
        'so nobody can set a new passcode and read them.';
      form.prepend(warn);
    }
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (next && next.value !== again.value) { error.textContent = 'The two passcodes aren’t the same.'; return; }
      const res = mode === 'remove'
        ? await api.request('vault-remove', { current: current.value })
        : await api.request('vault-set', { passcode: next.value, current: current ? current.value : null });
      if (res && res.ok) { renderPasscode(); return; }
      error.textContent = res && res.waitMs
        ? `Too many tries. Wait ${Math.ceil(res.waitMs / 1000)} seconds.`
        : (res && res.reason) || 'That didn’t work.';
    };
    form.hidden = false;
    requestAnimationFrame(() => form.querySelector('input')?.focus());
  };

  if (status.configured) {
    const change = smallButton('Change');
    change.addEventListener('click', () => openForm('change'));
    const remove = smallButton('Remove', 'ghost-btn danger');
    remove.addEventListener('click', () => openForm('remove'));
    control.append(change, remove);
  } else {
    const set = smallButton('Set passcode');
    set.addEventListener('click', () => openForm('set'));
    control.append(set);
  }
  // The form sits under the row's text, inside the row.
  note.after(form);
  return row;
}

/** The bookmarks revision the list was last drawn at. */
let bookmarksShown = null;

/** The System accent swatch: there when the system has an accent, pressed while followed. */
function renderSystemAccent(state) {
  const system = document.getElementById('accent-system');
  if (!system) return;
  system.hidden = !state.systemAccent;
  if (state.systemAccent) system.style.background = state.systemAccent;
  system.setAttribute('aria-pressed', String(Boolean(state.prefs && state.prefs.accentFromSystem)));
}

api.onState((state) => {
  applyThemePrefs(state.prefs);
  if (state.prefs) applyLayout(state.prefs.settingsLayout);
  renderUpdateState(state.updates);
  renderSpaces(state.incognito ? null : state.spaces || null, state.prefs || {});
  if (!state.prefs) return;
  if (Array.isArray(state.searchEngines)) engines = state.searchEngines;
  if (!built) {
    buildAll(state); renderPasscode(); renderBookmarks();
    buildRail();
    revealSection();
  }
  renderDownloads();
  // A bookmark saved elsewhere - the star, Ctrl+D - shows here while Settings
  // is open, not after a reload. Held while someone is typing in the section,
  // which the redraw would throw away.
  if (built && state.bookmarksRevision !== bookmarksShown) {
    const typing = document.activeElement &&
      document.activeElement.closest('#bookmark-list, #bookmark-actions');
    if (!typing) {
      if (bookmarksShown !== null) renderBookmarks();
      bookmarksShown = state.bookmarksRevision;
    }
  }
  renderSystemAccent(state);
  for (const [key, control] of controls) {
    control.write(state.prefs[key]);
    if (control.spec?.unavailable) markUnavailable(control, control.spec.unavailable(state));
  }
});

/**
 * A setting that cannot do anything here - on this platform, in this layout -
 * is shown switched off and says why, instead of accepting a change that goes
 * nowhere.
 */
function markUnavailable(control, why) {
  const off = Boolean(why);
  if (control.input && control.input.disabled !== off) control.input.disabled = off;
  control.row.classList.toggle('unavailable', off);
  if (control.hint) {
    const text = off ? why : (control.spec.hint || '');
    if (control.hint.textContent !== text) control.hint.textContent = text;
  }
}

/* ------------------------------------------------------------------ */
/* The rail, and search                                                */
/* ------------------------------------------------------------------ */

/**
 * A list of the sections, built from the sections.
 *
 * Deliberately not a second list of names: the page is eight sections long now,
 * and a hand-written rail is a list that goes out of step with the page the
 * first time someone adds a heading. Each button takes its label from the
 * section's own <h2>.
 */
const railButtons = new Map();

/**
 * The sections, collected once.
 *
 * Three pieces of code wanted this list - the rail, the scroll-spy and the
 * filter - and each re-queried for it, which is three copies of one selector to
 * keep in step. Sections are static markup; they do not appear or disappear.
 */
let sections = [];

function buildRail() {
  const rail = document.getElementById('rail');
  if (!rail) return;

  sections = [...document.querySelectorAll('section[data-section]')];

  for (const section of sections) {
    const name = section.dataset.section;
    const heading = section.querySelector('h2');
    const button = document.createElement('button');
    button.className = 'rail-item';
    button.type = 'button';
    button.textContent = heading ? heading.textContent : name;
    button.addEventListener('click', () => {
      setDrawer(false);
      // A section at a time, unless a search is showing every match: then the
      // list is a way down the results, as on the long page.
      if (pagesLayout() && !document.body.classList.contains('searching')) {
        showPage(name);
        return;
      }
      section.scrollIntoView({ block: 'start', behavior: motionOk() ? 'smooth' : 'auto' });
      // Marked immediately rather than waiting for the observer: a smooth
      // scroll takes a few hundred milliseconds, and a rail that lights up
      // after the page has finished moving feels like it did not register the
      // click.
      markRail(name);
    });
    rail.append(button);
    railButtons.set(name, button);
  }

  watchSections();
}

/*
 * One section at a time (`settingsLayout: 'pages'`, the default), as Chrome's
 * settings are: the list picks the section, and the page is only that one. A
 * search still shows every match from every section, since that is the point
 * of searching. `scroll` is the one long page, with the list following along.
 */
let currentPage = 'appearance';
const pagesLayout = () => document.body.dataset.settingsLayout === 'pages';

function showPage(name) {
  const section = sections.find((s) => s.dataset.section === name) || sections[0];
  if (!section) return;
  currentPage = section.dataset.section;
  for (const s of sections) s.classList.toggle('on', s === section);
  const main = document.querySelector('main');
  if (main) main.scrollTop = 0;
  markRail(currentPage);
}

/** The layout preference arrived, or changed while the page was open. */
function applyLayout(layout) {
  const next = layout === 'scroll' ? 'scroll' : 'pages';
  if (document.body.dataset.settingsLayout === next) return;
  // Wherever the reader was, they stay: the section they were on becomes the
  // page, or the long page opens at it.
  const here = document.querySelector('.rail-item.current');
  const name = [...railButtons].find(([, b]) => b === here)?.[0] || currentPage;
  document.body.dataset.settingsLayout = next;
  if (!sections.length) return;
  if (next === 'pages') showPage(name);
  else sections.find((s) => s.dataset.section === name)?.scrollIntoView({ block: 'start' });
  remarkRail();
}

/** The section list as a drawer, in a window too narrow to keep it beside the page. */
function setDrawer(open) {
  document.body.classList.toggle('rail-open', open);
  document.getElementById('rail-toggle')?.setAttribute('aria-expanded', String(open));
  if (open) document.querySelector('.rail-item.current, .rail-item')?.focus();
}
document.getElementById('rail-toggle')?.addEventListener('click', () =>
  setDrawer(!document.body.classList.contains('rail-open')));
// Away from it closes it, and Escape does before it closes Settings.
document.querySelector('main')?.addEventListener('pointerdown', () => setDrawer(false));
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !document.body.classList.contains('rail-open')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  setDrawer(false);
  document.getElementById('rail-toggle')?.focus();
}, true);
matchMedia('(max-width: 860px)').addEventListener('change', (q) => { if (!q.matches) setDrawer(false); });

function markRail(name) {
  for (const [key, button] of railButtons) {
    button.classList.toggle('current', key === name);
  }
}

/**
 * Which section the reader is in.
 *
 * The topmost section still intersecting the viewport wins, which is what makes
 * the mark move *as* you scroll rather than jumping when a section's midpoint
 * crosses some line. An observer rather than a scroll handler: this fires only
 * when a boundary is crossed, where a scroll listener would run on every frame
 * of every scroll for the life of the page.
 *
 * Whether a section is on screen is recorded on the section, so the callback
 * does not keep a second collection in step with the first.
 */
function watchSections() {
  const main = document.querySelector('main');
  if (!main) return;

  /*
   * The section being read is the last one whose heading has passed a line a
   * quarter of the way down the page.
   *
   * Short sections at the end would reach that line late or never - the page
   * runs out of scroll first - so the page is given room below the last
   * section for its heading to get there. Sharing the last stretch of scroll
   * between them instead, as this once did, named Advanced while the rows on
   * screen were still Private windows'.
   */
  let queued = false;
  // Whether the page was at its end when last marked. A section shrinking
  // there clamps the scroll short of the new end once the room below grows
  // back, so a reader who was at the end is put back at it.
  let wasAtEnd = false;
  const atEnd = () => main.scrollTop + main.clientHeight >= main.scrollHeight - 2;
  const mark = () => {
    queued = false;
    // A section at a time: the list says which, and nothing scrolls past it.
    if (pagesLayout() && !document.body.classList.contains('searching')) {
      if (main.style.paddingBottom) main.style.paddingBottom = '';
      markRail(currentPage);
      return;
    }
    const shown = sections.filter((s) => !s.hidden);
    if (!shown.length) return;
    const line = main.clientHeight * 0.25;
    const last = shown[shown.length - 1];
    const room = `${Math.max(0, Math.round(main.clientHeight - line - last.offsetHeight))}px`;
    if (main.style.paddingBottom !== room) {
      main.style.paddingBottom = room;
      if (wasAtEnd && !atEnd()) main.scrollTop = main.scrollHeight;
    }
    wasAtEnd = atEnd();
    const top = main.getBoundingClientRect().top;
    let current = shown[0];
    for (const s of shown) if (s.getBoundingClientRect().top - top <= line + 1) current = s;
    // At the very end it is the last section, whatever the line says: a section
    // that changes height after the room was measured (Updates fills in late)
    // can otherwise leave its heading short of the line with no scroll left.
    if (wasAtEnd) current = last;
    markRail(current.dataset.section);
  };
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(mark);
  };
  main.addEventListener('scroll', soon, { passive: true });
  window.addEventListener('resize', soon);
  // A section growing or shrinking moves every heading below it without a
  // scroll - an update check finishing, a download list filling in.
  if (typeof ResizeObserver === 'function') {
    const resized = new ResizeObserver(soon);
    for (const s of sections) resized.observe(s);
  }
  remarkRail = soon;
  soon();
}

/**
 * Filter the rows to the ones that match what was typed.
 *
 * Over the rows that are already on the page rather than over a list of
 * settings kept for the purpose: there is one list of settings in this file,
 * and a second one written for search is a second one to forget to update. A
 * row's whole text is matched - label and hint both - because people search for
 * what a setting does at least as often as for what it is called.
 *
 * The text is taken once, when a row is filtered for the first time, and kept
 * on the row. `textContent` walks the row's whole subtree and allocates a
 * string, and this page can hold five hundred bookmark rows.
 */
function filterSettings(query) {
  requestAnimationFrame(() => remarkRail());
  const needle = query.trim().toLowerCase();
  // Searching shows every section's matches, whichever layout this is; done
  // searching, a section at a time again, the one that was open.
  const searching = Boolean(needle);
  if (document.body.classList.contains('searching') !== searching) {
    document.body.classList.toggle('searching', searching);
    if (!searching && pagesLayout()) showPage(currentPage);
  }
  let shown = 0;

  for (const section of sections) {
    let any = false;
    for (const row of section.querySelectorAll('.row')) {
      if (row.dataset.find === undefined) row.dataset.find = row.textContent.toLowerCase();
      const hit = !needle || row.dataset.find.includes(needle);
      // Written only on a change: `hidden` is an attribute, and setting it
      // invalidates style for the row whether or not the value moved.
      if (row.hidden === hit) row.hidden = !hit;
      if (hit) { any = true; shown += 1; }
    }
    // A section whose rows have all gone takes its heading and its notes with
    // it. A page of empty headings is a worse answer than a short list.
    const gone = Boolean(needle) && !any;
    if (section.hidden !== gone) section.hidden = gone;
    const button = railButtons.get(section.dataset.section);
    if (button && button.hidden !== gone) button.hidden = gone;
  }

  const note = document.getElementById('no-match');
  note.hidden = !needle || shown > 0;
  note.textContent = shown ? '' : `No setting matches “${query.trim()}”.`;
}

/**
 * Re-run the current filter over rows that have just been rebuilt.
 *
 * Called by the three lists that rebuild themselves, not by the state
 * broadcast: that arrives twice a second for the life of the tab, and nothing
 * else in it touches a row.
 */
function reapplyFilter() {
  const search = document.getElementById('q');
  if (search && search.value.trim()) filterSettings(search.value);
}

{
  const search = document.getElementById('q');
  if (search) {
    search.addEventListener('input', () => filterSettings(search.value));
    // Escape clears the field first; the page's own Escape closes it only
    // when there is nothing to clear. See `clearOnEscape` in theme.js.
    clearOnEscape(search);
  }
}

/* ------------------------------------------------------------------ */
/* Bookmarks                                                           */
/* ------------------------------------------------------------------ */

/**
 * The bookmark list and the import controls.
 *
 * Importing is deliberately two offers rather than one. "Import from a browser
 * on this machine" is the path that needs no work from the user, and it is
 * tried first; "open an exported file" is the one that always works, including
 * for browsers whose bookmarks live in a database we will not read while it is
 * locked. Offering only the first would strand Firefox, Zen and every fork of
 * them; offering only the second would make the easy case needlessly manual.
 */
/**
 * The downloads list.
 *
 * Re-rendered from the browser's state rather than kept here, because progress
 * arrives on the state broadcast and a copy in this page would be a second
 * thing to keep in step with it.
 */
/*
 * Keyed rows, updated in place.
 *
 * This runs on every state broadcast, and it used to rebuild the list each
 * time - so a Cancel pressed across a tick was lost with the button it was
 * pressed on, and keyboard focus fell off the list twice a second. A sequence
 * number drops answers that arrive after a newer one.
 */
const downloadRows = new Map();
let downloadsAsked = 0;

async function renderDownloads() {
  const host = document.getElementById('download-list');
  if (!host) return;
  const asked = ++downloadsAsked;
  const res = await api.request('list-downloads');
  if (asked !== downloadsAsked) return;
  const items = (res && res.items) || [];

  const live = new Set(items.map((item) => item.id));
  for (const [id, node] of downloadRows) {
    if (!live.has(id)) { node.row.remove(); downloadRows.delete(id); }
  }
  items.forEach((item, index) => {
    let node = downloadRows.get(item.id);
    if (!node) { node = downloadRow(item.id); downloadRows.set(item.id, node); }
    updateDownloadRow(node, item);
    if (host.children[index] !== node.row) host.insertBefore(node.row, host.children[index] || null);
  });
  // A new row has never been filtered, and this list redraws itself while a
  // search is on screen.
  reapplyFilter();
}

function downloadRow(id) {
  const row = document.createElement('div');
  row.className = 'row';

  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('span');
  label.className = 'row-label';
  const hint = document.createElement('span');
  hint.className = 'row-hint';
  text.append(label, hint);

  const control = document.createElement('div');
  control.className = 'row-control';
  const button = document.createElement('button');
  const node = { row, label, hint, button, running: null };
  button.addEventListener('click', async () => {
    await api.request(node.running ? 'cancel-download' : 'clear-download', { id });
    renderDownloads();
  });
  control.append(button);

  row.append(text, control);
  return node;
}

function updateDownloadRow(node, item) {
  const running = item.state === 'running' || item.state === 'starting';
  // Written only on a change: this runs for every row on every broadcast.
  const label = item.filename || item.url;
  const hint = describeDownload(item);
  if (node.label.textContent !== label) node.label.textContent = label;
  if (node.hint.textContent !== hint) node.hint.textContent = hint;
  if (node.running !== running) {
    node.running = running;
    node.button.className = running ? 'ghost-btn danger' : 'ghost-btn';
    node.button.textContent = running ? 'Cancel' : 'Clear';
  }
}

async function renderBookmarks() {
  const host = document.getElementById('bookmark-list');
  const actions = document.getElementById('bookmark-actions');
  const state = document.getElementById('bookmark-state');
  if (!host || !actions) return;

  // Built once. This runs again after every add, edit and remove, and
  // rebuilding threw away whatever was half-typed into the Add form - and,
  // with it gone, left the page reporting unsaved input it no longer had.
  if (!actions.childElementCount) actions.replaceChildren(
    // First, because adding one by hand is the thing a bookmarks page is for.
    // Importing is a once-a-year operation and sat above it until now.
    bookmarkForm(),
    bookmarkAction(
      'Import from a browser on this machine',
      'Looks for Chrome, Edge, Brave, Vivaldi, Arc, Firefox, Zen and their relatives.',
      'Find browsers',
      async (button) => {
        button.disabled = true;
        const res = await api.request('bookmark-profiles');
        button.disabled = false;
        const profiles = (res && res.profiles) || [];
        if (!profiles.length) {
          state.textContent = 'No other browsers found on this computer. ' +
            'Export a bookmarks file from the browser you use and choose it below.';
          return;
        }
        renderProfiles(profiles, state, host);
      }),
    bookmarkAction(
      'Import an exported file',
      'The bookmarks HTML that every browser exports, or a Chromium Bookmarks file.',
      'Choose file…',
      async (button) => {
        button.disabled = true;
        const res = await api.request('import-bookmark-file');
        button.disabled = false;
        if (!res || res.cancelled) return;
        state.textContent = res.ok
          ? `Imported ${res.added} from ${res.browser}${res.skipped ? `, skipped ${res.skipped} already saved or unsupported` : ''}.`
          : `Couldn’t import: ${res.reason}`;
        renderBookmarks();
      })
  );

  const res = await api.request('list-bookmarks');
  const items = (res && res.items) || [];

  if (!items.length) {
    host.replaceChildren();
    if (!state.textContent) {
      state.textContent = 'Nothing saved yet. The star in the toolbar saves the page you are on.';
    }
    return;
  }

  host.replaceChildren(...items.slice(0, 500).map(bookmarkRow));
  if (items.length > 500) {
    const more = document.createElement('div');
    more.className = 'row';
    more.textContent = `…and ${items.length - 500} more, saved but not listed here.`;
    host.appendChild(more);
  }
  reapplyFilter();
}

function bookmarkAction(title, hint, buttonText, onClick) {
  const row = document.createElement('div');
  row.className = 'row';
  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = title;
  const sub = document.createElement('span');
  sub.className = 'row-hint';
  sub.textContent = hint;
  text.append(label, sub);

  const control = document.createElement('div');
  control.className = 'row-control';
  const button = document.createElement('button');
  button.className = 'ghost-btn';
  button.textContent = buttonText;
  button.addEventListener('click', () => onClick(button));
  control.append(button);

  row.append(text, control);
  return row;
}

/**
 * One row per profile found, each with its own button.
 *
 * A Firefox-family profile gets a button too, and it explains rather than
 * imports - saying "Zen: not supported" would be worse than useless when the
 * answer is one export away, and the reason comes from the browser rather than
 * being guessed at here.
 */
function renderProfiles(profiles, state, host) {
  state.textContent = `Found ${profiles.length} profile${profiles.length === 1 ? '' : 's'}.`;
  const rows = profiles.map((profile) => bookmarkAction(
    profile.browser,
    profile.kind === 'firefox' ? 'Firefox-family profile' : 'Chromium-family profile',
    'Import',
    async (button) => {
      button.disabled = true;
      const res = await api.request('import-from-profile', { path: profile.path });
      button.disabled = false;
      if (res && res.ok) {
        state.textContent = `Imported ${res.added} from ${res.browser}` +
          `${res.skipped ? `, skipped ${res.skipped} already saved or unsupported` : ''}.`;
        renderBookmarks();
      } else {
        state.textContent = (res && res.reason) || 'That import didn’t work.';
      }
    }));
  host.replaceChildren(...rows);
}

function bookmarkRow(item) {
  const row = document.createElement('div');
  row.className = 'row bookmark-row';
  // The site's mark, as on the bar, so a long list can be scanned by eye.
  row.append(siteChip(item.url, { icon: item.icon }));

  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = item.title;
  const hint = document.createElement('span');
  hint.className = 'row-hint';
  hint.textContent = item.folder ? `${item.folder} – ${item.url}` : item.url;
  text.append(label, hint);

  const control = document.createElement('div');
  control.className = 'row-control';
  const open = document.createElement('button');
  open.className = 'ghost-btn';
  open.textContent = 'Open';
  open.addEventListener('click', () => api.send('new-tab', { url: item.url }));
  const edit = document.createElement('button');
  edit.className = 'ghost-btn';
  edit.textContent = 'Edit';
  // The form replaces the row it edits rather than opening beside it, so the
  // list never shows a bookmark twice and nothing below it moves.
  edit.addEventListener('click', () => row.replaceWith(bookmarkForm(item)));
  const remove = document.createElement('button');
  remove.className = 'ghost-btn danger';
  remove.textContent = 'Remove';
  remove.addEventListener('click', async () => {
    await api.request('remove-bookmark', { id: item.id });
    renderBookmarks();
  });
  control.append(open, edit, remove);

  row.append(text, control);
  return row;
}

/**
 * The editor, for both jobs it has.
 *
 * With an item it edits that one; without, it adds a new bookmark and stays
 * open so several can be typed in a row. One function for both because they
 * are the same two fields with the same validation behind them, and two
 * near-identical forms is how the add path ends up accepting something the
 * edit path refuses.
 *
 * Nothing is validated here. The address is handed to the browser and the
 * answer comes back: `bookmarks.js` is the one place that decides what may be
 * stored - it is what refuses `javascript:` in an imported file - and a second
 * opinion in a renderer would eventually disagree with it.
 */
function bookmarkForm(item = null) {
  const row = document.createElement('div');
  row.className = 'row bookmark-form';

  const fields = document.createElement('div');
  fields.className = 'row-text bookmark-fields';

  // Two unlabelled boxes at the top of a page are a puzzle; every other row in
  // Settings says what it is, and this one has to as well.
  const heading = document.createElement('span');
  heading.className = 'row-label';
  heading.textContent = item ? 'Editing this bookmark' : 'Add a bookmark';
  fields.append(heading);

  const title = document.createElement('input');
  title.type = 'text';
  title.placeholder = 'Name';
  title.value = item ? item.title : '';
  // Typed and unsent, so the governor knows not to discard this page under it.
  title.setAttribute('data-transient', '');

  const url = document.createElement('input');
  url.type = 'text';
  url.placeholder = 'https://';
  url.value = item ? item.url : '';
  url.setAttribute('data-transient', '');

  const problem = document.createElement('span');
  problem.className = 'row-hint';

  fields.append(title, url, problem);

  const control = document.createElement('div');
  control.className = 'row-control';

  const save = document.createElement('button');
  save.className = 'ghost-btn';
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    save.disabled = true;
    const res = await api.request('save-bookmark', {
      id: item ? item.id : '',
      url: url.value.trim(),
      title: title.value.trim() || url.value.trim()
    });
    save.disabled = false;
    if (!res || !res.ok) {
      problem.textContent = (res && res.reason) || 'That couldn’t be saved.';
      return;
    }
    // Adding leaves the form up with empty fields; editing closes it, because
    // the row it came from is what the user wants to see again.
    if (!item) { title.value = ''; url.value = ''; problem.textContent = ''; }
    await renderBookmarks();
    // Cleared or replaced without an input event; say the page is clean.
    reportTransient();
  });

  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = item ? 'Cancel' : 'Clear';
  cancel.addEventListener('click', () => {
    if (item) row.replaceWith(bookmarkRow(item));
    else { title.value = ''; url.value = ''; problem.textContent = ''; }
    reportTransient();
  });

  control.append(save, cancel);
  row.append(fields, control);

  // Enter saves, from either field. A two-field form where the keyboard does
  // nothing is a form that has to be finished with the mouse.
  // Escape is Cancel, and handled: the page's own Escape would otherwise put
  // back the value the field had on focus, undoing the Clear.
  row.addEventListener('keydown', (event) => {
    // From the fields only: Enter on a focused button is that button's own
    // press, and taking it for Save saved the edit someone Tabbed to Cancel.
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); save.click(); }
    else if (event.key === 'Escape') { event.preventDefault(); cancel.click(); }
  });

  return row;
}

// The bookmark editor's fields are `data-transient`: a half-typed bookmark
// keeps this page off the reclaim ladder, as a half-typed search does
// elsewhere. See theme.js.
const reportTransient = watchTransientInput(api);
