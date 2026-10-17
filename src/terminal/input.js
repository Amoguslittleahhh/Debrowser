'use strict';

/**
 * What the terminal sends, as events.
 *
 * In raw mode a terminal hands over bytes: printable characters as UTF-8,
 * control keys as control characters, and everything else as escape
 * sequences - arrows, Page Up, Alt+key, and mouse reports in xterm's SGR form
 * (ESC [ < button ; column ; row M or m), which every terminal with a mouse
 * speaks. Pure, for the test suite.
 *
 * Events:
 *   { type: 'key', key, ctrl, alt, shift }   named keys, and Ctrl/Alt chords
 *   { type: 'text', text }                   characters to type
 *   { type: 'mouse', action, button, col, row }  1-based cells; action is
 *                                            'down', 'up', 'move' or 'wheel'
 *                                            (button 'up' or 'down' for a wheel)
 */

const CSI_KEYS = {
  A: 'Up', B: 'Down', C: 'Right', D: 'Left', H: 'Home', F: 'End'
};
const TILDE_KEYS = {
  1: 'Home', 2: 'Insert', 3: 'Delete', 4: 'End', 5: 'PageUp', 6: 'PageDown', 7: 'Home', 8: 'End'
};
const CONTROL = { 9: 'Tab', 13: 'Enter', 10: 'Enter', 127: 'Backspace', 8: 'Backspace', 27: 'Escape' };

/** Modifier parameter of a CSI sequence (1 + shift + 2*alt + 4*ctrl). */
function modifiers(param) {
  const m = Math.max(0, (Number(param) || 1) - 1);
  return { shift: Boolean(m & 1), alt: Boolean(m & 2), ctrl: Boolean(m & 4) };
}

/**
 * Parse a chunk. Returns { events, rest }: `rest` is an escape sequence cut
 * off at the end of the chunk, to be put in front of the next one.
 */
function parse(input) {
  const s = String(input);
  const events = [];
  let i = 0;
  let text = '';
  const flush = () => { if (text) { events.push({ type: 'text', text }); text = ''; } };

  while (i < s.length) {
    const c = s[i];
    const code = s.charCodeAt(i);

    if (c === '\x1b') {
      // A lone Escape, or one at the very end, is the Escape key.
      if (i + 1 >= s.length) {
        flush();
        events.push({ type: 'key', key: 'Escape', ctrl: false, alt: false, shift: false });
        i++;
        continue;
      }
      const next = s[i + 1];
      // ESC before a whole sequence: Alt with that key (Alt+← in many terminals).
      if (next === '\x1b' && (s[i + 2] === '[' || s[i + 2] === 'O')) {
        const inner = parse(s.slice(i + 1));
        flush();
        // Cut off before the sequence ended: wait for the rest, Escape and all.
        if (!inner.events.length) return { events, rest: s.slice(i) };
        if (inner.events[0].type === 'key') inner.events[0].alt = true;
        events.push(...inner.events);
        return { events, rest: inner.rest };
      }
      if (next === '[' || next === 'O') {
        // CSI (or SS3): parameters, then one final byte from @ to ~.
        let j = i + 2;
        while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
        if (j >= s.length) { flush(); return { events, rest: s.slice(i) }; }
        const body = s.slice(i + 2, j);
        const final = s[j];
        flush();
        const mouse = /^<(\d+);(\d+);(\d+)$/.exec(body);
        if (mouse && (final === 'M' || final === 'm')) {
          const b = Number(mouse[1]);
          const col = Number(mouse[2]);
          const row = Number(mouse[3]);
          if (b & 64) {
            events.push({ type: 'mouse', action: 'wheel', button: (b & 1) ? 'down' : 'up', col, row });
          } else if (b & 32) {
            events.push({ type: 'mouse', action: 'move', button: ['left', 'middle', 'right', 'none'][b & 3], col, row });
          } else {
            events.push({ type: 'mouse', action: final === 'M' ? 'down' : 'up', button: ['left', 'middle', 'right', 'none'][b & 3], col, row });
          }
        } else if (CSI_KEYS[final]) {
          const params = body.split(';');
          events.push({ type: 'key', key: CSI_KEYS[final], ...modifiers(params[1]) });
        } else if (final === '~') {
          const params = body.split(';');
          const key = TILDE_KEYS[params[0]];
          if (key) events.push({ type: 'key', key, ...modifiers(params[1]) });
        } else if (final === 'Z') {
          events.push({ type: 'key', key: 'Tab', ctrl: false, alt: false, shift: true });
        }
        i = j + 1;
        continue;
      }
      // ESC then a character: Alt+that key.
      flush();
      const after = s[i + 1];
      const named = CONTROL[s.charCodeAt(i + 1)];
      events.push({ type: 'key', key: named || after, ctrl: false, alt: true, shift: false });
      i += 2;
      continue;
    }

    if (CONTROL[code] && code !== 27) {
      flush();
      events.push({ type: 'key', key: CONTROL[code], ctrl: false, alt: false, shift: false });
      i++;
      continue;
    }
    if (code < 32) {
      // Ctrl+A is 1, Ctrl+Z is 26.
      flush();
      events.push({ type: 'key', key: String.fromCharCode(code + 96), ctrl: true, alt: false, shift: false });
      i++;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return { events, rest: '' };
}

module.exports = { parse };
