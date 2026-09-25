'use strict';

/**
 * What something typed into the address bar is.
 *
 * One rule, read by the two places that need it: `normaliseUrl` in main.js,
 * which decides where Enter goes, and the suggestion list, which marks the row
 * saying so. They used to be two copies, and when local addresses learned to
 * go to http the list's copy was not told - it offered to search for
 * `router:8080` while Enter opened it.
 *
 *   'url'     has a scheme already (`https://…`, `about:blank`, `file:…`)
 *   'local'   a machine on this network: an IP address, `localhost`, a `.local`
 *             or similar name, or any name given with a port - reached over
 *             plain http, as every browser does, since a router or a
 *             development server rarely has a certificate
 *   'host'    looks like a site's name; https is a guess, which is why a site
 *             that turns out not to speak it is retried over http
 *   null      words, to search for
 *
 * Pure, so the smoke suite and the list can both call it.
 */
function classifyAddress(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|blob|file):/i.test(text)) return 'url';
  const host = text.split(/[/?#]/)[0];
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(host) || /^\[[0-9a-f:.]+\](:\d+)?$/i.test(host) ||
      /^localhost(:\d+)?$/i.test(host) || /\.(local|lan|internal|home\.arpa)(:\d+)?$/i.test(host) ||
      /^[a-z0-9-]+:\d+$/i.test(host)) return 'local';
  if (/^[^\s/?#]+\.[^\s/?#]{2,}([/?#]|$)/.test(text)) return 'host';
  return null;
}

module.exports = { classifyAddress };
