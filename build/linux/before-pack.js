'use strict';

/**
 * electron-builder `beforePack`, Linux only: the files the .deb carries
 * outside /opt, written fresh for the version being built.
 *
 *   - dev.debrowser.app.metainfo.xml, the AppStream entry for the installed app,
 *     which GNOME Software and KDE Discover read.
 *   - debrowser.yml, the same entry as a one-app catalogue (DEP-11). Ubuntu's
 *     App Center reads only catalogues, never installed metainfo, and it is the
 *     catalogue entry that gives its page a publisher, a licence and a "last
 *     updated" date - and puts Debrowser in its list of installed apps at all.
 *     A downloaded .deb opened in App Center still shows "Unknown publisher":
 *     that page is built from the file alone, with the publisher and date left
 *     out in App Center's own code (deb/local_deb_model.dart).
 *   - archive-keyring.asc, the public key the apt repository is signed with
 *     (build/linux/archive-keyring.asc). Empty when there is none yet: the
 *     install script then adds no apt source, since one it cannot verify would
 *     fail every `apt update` on the machine.
 *
 * All go to build/linux/generated/, which the `deb.fpm` lines in
 * electron-builder.yml map into the package. Both AppStream files come from
 * APP below, so they cannot disagree.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'generated');
const RAW = 'https://raw.githubusercontent.com/Amoguslittleahhh/Debrowser/claude/master-build';
const SHOTS = `${RAW}/docs/screenshots`;

/** What software centres say about Debrowser. Validated with `appstreamcli validate --pedantic`. */
const APP = {
  id: 'dev.debrowser.app',
  package: 'debrowser',
  desktopId: 'debrowser.desktop',
  name: 'Debrowser',
  summary: "A web browser that gives your computer's memory back",
  license: 'MIT',
  developer: { id: 'io.github.amoguslittleahhh', name: 'Amoguslittleahhh' },
  about: 'Debrowser decides, every two seconds, how much memory and processor time each tab may hold, ' +
    'so a tab you are not looking at costs almost nothing, and you cannot tell.',
  points: [
    'Tabs you leave go to sleep and wake when you come back',
    'Spaces, split view, tab groups and a built-in ad and tracker blocker',
    'Private windows that go through Tor, with a circuit per site',
    'Passwords and passkeys kept encrypted on this computer'
  ],
  icon: 'debrowser',
  categories: ['Network', 'WebBrowser'],
  screenshots: [
    { file: 'hero.png', caption: 'Debrowser in its default design, on a new tab', width: 2960, height: 2356 },
    { file: 'designs.png', caption: 'The four designs to choose from', width: 2920, height: 2356 }
  ]
};

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `<p>` and `<ul>`, as both formats carry the description. */
const descriptionHtml = () =>
  `<p>${escape(APP.about)}</p><ul>${APP.points.map((p) => `<li>${escape(p)}</li>`).join('')}</ul>`;

function metainfo(pkg, date) {
  const shots = APP.screenshots.map((s, i) => `    <screenshot${i ? '' : ' type="default"'}>
      <caption>${escape(s.caption)}</caption>
      <image>${SHOTS}/${s.file}</image>
    </screenshot>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by build/linux/before-pack.js for each build. -->
<component type="desktop-application">
  <id>${APP.id}</id>
  <launchable type="desktop-id">${APP.desktopId}</launchable>
  <name>${escape(APP.name)}</name>
  <summary>${escape(APP.summary)}</summary>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>${APP.license}</project_license>
  <developer id="${APP.developer.id}">
    <name>${escape(APP.developer.name)}</name>
  </developer>
  <description>
    <p>${escape(APP.about)}</p>
    <ul>
${APP.points.map((p) => `      <li>${escape(p)}</li>`).join('\n')}
    </ul>
  </description>
  <icon type="stock">${APP.icon}</icon>
  <screenshots>
${shots}
  </screenshots>
  <categories>
${APP.categories.map((c) => `    <category>${c}</category>`).join('\n')}
  </categories>
  <url type="homepage">${escape(pkg.homepage)}</url>
  <url type="bugtracker">${escape(pkg.homepage)}/issues</url>
  <url type="vcs-browser">${escape(pkg.homepage)}</url>
  <provides>
    <binary>debrowser</binary>
  </provides>
  <supports>
    <control>pointing</control>
    <control>keyboard</control>
  </supports>
  <content_rating type="oars-1.1"/>
  <releases>
    <release version="${escape(pkg.version)}" date="${date}"/>
  </releases>
</component>
`;
}

/** The same entry as a DEP-11 catalogue holding this one app. */
function catalogue(pkg, date) {
  const yaml = require('js-yaml');
  const header = { File: 'DEP-11', Version: '1.0', Origin: 'debrowser', MediaBaseUrl: SHOTS };
  const component = {
    Type: 'desktop-application',
    ID: APP.id,
    Package: APP.package,
    Name: { C: APP.name },
    Summary: { C: APP.summary },
    Description: { C: descriptionHtml() },
    ProjectLicense: APP.license,
    // Both spellings: DeveloperName is what App Center reads, Developer what
    // newer AppStream writes.
    DeveloperName: { C: APP.developer.name },
    Developer: { id: APP.developer.id, name: { C: APP.developer.name } },
    Launchable: { 'desktop-id': [APP.desktopId] },
    // The theme's icon, which the .deb installs at every size; the published
    // one for when App Center cannot find it in the theme.
    Icon: {
      stock: APP.icon,
      remote: [{ url: `${RAW}/build/linux/icons/128x128.png`, width: 128, height: 128 }]
    },
    Categories: APP.categories,
    Url: { homepage: pkg.homepage, bugtracker: `${pkg.homepage}/issues` },
    Provides: { binaries: ['debrowser'] },
    Screenshots: APP.screenshots.map((s, i) => ({
      ...(i ? {} : { default: true }),
      caption: { C: s.caption },
      'source-image': { url: s.file, width: s.width, height: s.height }
    })),
    Releases: [{ version: pkg.version, type: 'stable', 'unix-timestamp': Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) }]
  };
  const doc = (o) => `---\n${yaml.dump(o, { lineWidth: -1, noRefs: true })}`;
  return doc(header) + doc(component);
}

function write(date = new Date().toISOString().slice(0, 10)) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'debrowser.metainfo.xml'), metainfo(pkg, date));
  fs.writeFileSync(path.join(OUT, 'debrowser.yml'), catalogue(pkg, date));
  const key = path.join(__dirname, 'archive-keyring.asc');
  fs.writeFileSync(path.join(OUT, 'archive-keyring.asc'), fs.existsSync(key) ? fs.readFileSync(key) : '');
}

module.exports = async (context) => {
  if (context.electronPlatformName === 'linux') write();
};
module.exports.write = write;
module.exports.APP = APP;
