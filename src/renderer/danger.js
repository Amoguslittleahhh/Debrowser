'use strict';

/**
 * The warning page. What was stopped and why come in the address; the page
 * only ever asks the browser to go back, to go to the site it was mistaken
 * for, or - from Details - to open the stopped site for this session.
 */

const api = window.debrowser;
const params = new URLSearchParams(location.search);
const target = params.get('url') || '';
const kind = params.get('kind');
const like = params.get('like') || '';

let host = '';
try { host = new URL(target).hostname; } catch { /* nothing to name */ }
const $ = (id) => document.getElementById(id);
$('host').textContent = host;

const TEXT = {
  phishing: ['This site may try to steal your information',
    'It is on a list of sites that pretend to be banks, shops, email and other services to get passwords, card numbers and codes.',
    'Listed by Phishing Army (phishing.army), which collects reports from several phishing feeds. Lists are sometimes wrong; if you are sure this site is safe, you can open it.'],
  malware: ['This site may harm your computer',
    'It is on a list of sites currently spreading malware – programs that steal from or damage the computers that run them.',
    'Listed by URLhaus (urlhaus.abuse.ch), a project of abuse.ch that tracks malware distribution. Lists are sometimes wrong; if you are sure this site is safe, you can open it.'],
  lookalike: ['Did you mean ' + like + '?',
    `You have never been to ${host}, but its name is one letter from ${like}, which you use often. Sites like this are often set up to catch a mistyped address or a misleading link.`,
    'Debrowser compared the name with the sites in your own history; nothing was sent anywhere. If you meant to come here, you can open it.']
};
const [title, lead, why] = TEXT[kind] || TEXT.phishing;
document.title = kind === 'lookalike' ? 'Check the address' : 'Warning';
$('title').textContent = title;
$('lead').textContent = lead;
$('why').textContent = why;

if (kind === 'lookalike' && like) {
  $('like').hidden = false;
  $('like').textContent = `Go to ${like}`;
  $('like').addEventListener('click', () => api.send('navigate', { url: `https://${like}/` }));
}
$('back').addEventListener('click', () => api.send('back'));
$('go').addEventListener('click', () => api.send('allow-danger', { url: target }));
$('back').focus();

api.onState((state) => applyThemePrefs(state.prefs));
