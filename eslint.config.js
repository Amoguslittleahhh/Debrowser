'use strict';

/**
 * Lint, deliberately narrow.
 *
 * This is not a style checker and must not become one. The project has a house
 * style and it is enforced by reading the code, not by a tool with opinions
 * about quote marks.
 *
 * It exists for one class of fault, which this codebase has produced twice:
 * a name used in a scope that does not have it. Under `'use strict'` that is a
 * `ReferenceError` at runtime, on whatever path happens to touch it - so
 * `node --check` passes, the app starts, the suite goes green, and the
 * function is simply broken for anyone who calls it.
 *
 * Both instances were silent in exactly that way:
 *
 *   - `prefs` was read inside `wireRequests`, which never received it. Every
 *     request to reveal a saved password threw, so the credential store could
 *     not be read at all - and nothing failed anywhere a test was looking.
 *   - `now` was read inside `runHeapLimits`, which does not declare it, after a
 *     search-and-replace matched a second identical anchor. It threw out of the
 *     governor tick, taking budget enforcement with it.
 *
 * So: `no-undef` and `no-unused-vars`, and nothing else. `no-unused-vars` earns
 * its place as the other half of the same signal - a name that is declared and
 * never read is usually the remains of an edit that half happened.
 */

module.exports = [
  {
    files: ['src/**/*.js', 'tools/*.js', 'bench/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        // Node, which every file here runs under.
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        queueMicrotask: 'readonly',
        URL: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      // Arguments are exempt: a handler that ignores its first parameter still
      // has to declare it to reach the second, which is not a mistake.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }]
    }
  },
  {
    // Renderers and preloads run in a page, not in Node.
    files: ['src/renderer/*.js', 'src/preload/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        getComputedStyle: 'readonly',
        matchMedia: 'readonly',
        URL: 'readonly',
        Image: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        performance: 'readonly',
        location: 'readonly',
        history: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        CSS: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLInputElement: 'readonly',
        // Defined in theme.js, which every one of these pages loads with its
        // own <script> tag before its own file. A real shared global rather
        // than a missing import.
        applyThemePrefs: 'readonly',
        siteHue: 'readonly',
        iconSrc: 'readonly',
        anchorSheet: 'readonly',
        watchTransientInput: 'readonly',
        URLSearchParams: 'readonly',
        IntersectionObserver: 'readonly',
        // Preloads only.
        require: 'readonly',
        module: 'writable',
        process: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }]
    }
  }
];
