'use strict';

/**
 * Answers in the address bar: sums and unit conversions, worked out here as
 * you type, with nothing sent anywhere.
 *
 *   12*7.5            = 90
 *   (3+4)^2 / 7       = 7
 *   5 km in miles     = 3.10686 miles
 *   72 f to c         = 22.2222 °C
 *
 * The sum is parsed, never evaluated as code: numbers, + - * / ^ % and
 * brackets, and nothing else. Currency is left out - a rate is a fact about
 * today that would need fetching, and a stale one would be a wrong answer.
 *
 * Pure: no Electron, no I/O.
 */

/* ---- Sums ----------------------------------------------------------------- */

/** Tokens of a sum, or null for anything that is not one. */
function tokenize(text) {
  const src = text.replace(/[×x]/g, (m, i) => (m === 'x' && !/\d\s*$/.test(text.slice(0, i)) ? 'x' : '*'))
    .replace(/÷/g, '/').replace(/,(?=\d{3}\b)/g, '').replace(/\s+/g, '');
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(rest);
    if (num) { tokens.push({ n: Number(num[0]) }); i += num[0].length; continue; }
    if ('+-*/^%()'.includes(src[i])) { tokens.push({ op: src[i] }); i += 1; continue; }
    return null;
  }
  return tokens;
}

/** Recursive descent over the tokens: the usual precedence, ^ binding right. */
function evaluate(tokens) {
  let at = 0;
  const peek = () => tokens[at];
  const take = (op) => (tokens[at] && tokens[at].op === op ? (at += 1, true) : false);
  const primary = () => {
    if (take('-')) return -power();
    if (take('+')) return power();
    if (take('(')) {
      const v = sum();
      if (!take(')')) throw new Error('bracket');
      return v;
    }
    const t = peek();
    if (!t || t.n === undefined) throw new Error('number');
    at += 1;
    // 50% is a half.
    if (take('%')) return t.n / 100;
    return t.n;
  };
  const power = () => {
    const base = primary();
    return take('^') ? base ** power() : base;
  };
  const product = () => {
    let v = power();
    for (;;) {
      if (take('*')) v *= power();
      else if (take('/')) v /= power();
      else return v;
    }
  };
  const sum = () => {
    let v = product();
    for (;;) {
      if (take('+')) v += product();
      else if (take('-')) v -= product();
      else return v;
    }
  };
  const v = sum();
  if (at !== tokens.length) throw new Error('trailing');
  return v;
}

/** A sum someone typed, or null when the text is not one. */
function sumOf(text) {
  const t = text.replace(/^=\s*/, '').replace(/\s*=$/, '').trim();
  // Must hold an operator between numbers: "2024" alone is a search, and so
  // is a phone number or a date written with dashes.
  if (!/\d/.test(t) || !/[\d)%]\s*[-+*/^×x÷]\s*[\d(.-]|^\(|\d%$/.test(t)) return null;
  if (/^\d{1,4}([-/.])\d{1,2}\1\d{1,4}$/.test(t) || /^\+?\d[\d\s-]{6,}$/.test(t)) return null;
  const tokens = tokenize(t);
  if (!tokens || tokens.length < 2) return null;
  try {
    const v = evaluate(tokens);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/* ---- Units ---------------------------------------------------------------- */

/** Each unit: its kind, its size in the kind's base unit, and how to say it. */
const UNITS = {};
function unit(kind, factor, name, plural, ...aliases) {
  const u = { kind, factor, name, plural };
  for (const a of [name, plural, ...aliases]) UNITS[a.toLowerCase()] = u;
}
// Length, in metres.
unit('length', 0.001, 'mm', 'mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres');
unit('length', 0.01, 'cm', 'cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres');
unit('length', 1, 'm', 'm', 'meter', 'meters', 'metre', 'metres');
unit('length', 1000, 'km', 'km', 'kilometer', 'kilometers', 'kilometre', 'kilometres');
unit('length', 0.0254, 'inch', 'inches', 'in', '"');
unit('length', 0.3048, 'foot', 'feet', 'ft', "'");
unit('length', 0.9144, 'yard', 'yards', 'yd', 'yds');
unit('length', 1609.344, 'mile', 'miles', 'mi');
// Mass, in grams.
unit('mass', 0.001, 'mg', 'mg', 'milligram', 'milligrams');
unit('mass', 1, 'g', 'g', 'gram', 'grams');
unit('mass', 1000, 'kg', 'kg', 'kilo', 'kilos', 'kilogram', 'kilograms');
unit('mass', 28.349523125, 'oz', 'oz', 'ounce', 'ounces');
unit('mass', 453.59237, 'lb', 'lb', 'lbs', 'pound', 'pounds');
unit('mass', 6350.29318, 'stone', 'stone', 'st');
// Volume, in millilitres.
unit('volume', 1, 'ml', 'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres');
unit('volume', 1000, 'litre', 'litres', 'l', 'liter', 'liters');
unit('volume', 3785.411784, 'gallon', 'gallons', 'gal');
unit('volume', 236.5882365, 'cup', 'cups');
unit('volume', 29.5735295625, 'fl oz', 'fl oz', 'floz');
// Speed, in metres a second.
unit('speed', 1 / 3.6, 'km/h', 'km/h', 'kmh', 'kph');
unit('speed', 0.44704, 'mph', 'mph');
unit('speed', 1, 'm/s', 'm/s');
unit('speed', 0.514444, 'knot', 'knots', 'kn', 'kt');
// Data, in bytes - and both ways of counting them, named as they are.
unit('data', 1, 'byte', 'bytes', 'b');
unit('data', 1e3, 'KB', 'KB', 'kb', 'kilobyte', 'kilobytes');
unit('data', 1e6, 'MB', 'MB', 'mb', 'megabyte', 'megabytes');
unit('data', 1e9, 'GB', 'GB', 'gb', 'gigabyte', 'gigabytes');
unit('data', 1e12, 'TB', 'TB', 'tb', 'terabyte', 'terabytes');
unit('data', 1024, 'KiB', 'KiB', 'kib');
unit('data', 1024 ** 2, 'MiB', 'MiB', 'mib');
unit('data', 1024 ** 3, 'GiB', 'GiB', 'gib');
unit('data', 1024 ** 4, 'TiB', 'TiB', 'tib');
// Temperature: not a factor, a formula; handled apart.
const TEMPS = {
  c: '°C', '°c': '°C', celsius: '°C', centigrade: '°C',
  f: '°F', '°f': '°F', fahrenheit: '°F',
  k: 'K', kelvin: 'K', kelvins: 'K'
};
const toKelvin = { '°C': (v) => v + 273.15, '°F': (v) => (v - 32) * 5 / 9 + 273.15, K: (v) => v };
const fromKelvin = { '°C': (v) => v - 273.15, '°F': (v) => (v - 273.15) * 9 / 5 + 32, K: (v) => v };

const CONVERSION = /^(-?[\d.,]+(?:e[+-]?\d+)?)\s*(.+?)\s+(?:in|to|as|into|=)\s+(.+?)\s*\??$/i;

/** "5 km in miles", or null. */
function conversionOf(text) {
  const m = CONVERSION.exec(text.trim());
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const from = m[2].toLowerCase().replace(/^degrees?\s+/, '');
  const to = m[3].toLowerCase().replace(/^degrees?\s+/, '');
  if (TEMPS[from] && TEMPS[to]) {
    const a = TEMPS[from];
    const b = TEMPS[to];
    return { value: fromKelvin[b](toKelvin[a](value)), unit: b, from: `${format(value)} ${a}` };
  }
  const a = UNITS[from];
  const b = UNITS[to];
  if (!a || !b || a.kind !== b.kind) return null;
  const out = value * a.factor / b.factor;
  return {
    value: out,
    unit: Math.abs(out) === 1 ? b.name : b.plural,
    from: `${format(value)} ${Math.abs(value) === 1 ? a.name : a.plural}`
  };
}

/* ---- Saying it ------------------------------------------------------------ */

/** Six significant figures, no trailing zeros, no exponent for everyday sizes. */
function format(v) {
  if (Object.is(v, -0)) v = 0;
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) return v.toPrecision(6).replace(/\.?0+e/, 'e');
  const rounded = Number(v.toPrecision(abs >= 1 ? Math.max(6, Math.ceil(Math.log10(abs + 1))) : 6));
  const [whole, frac] = String(rounded).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/**
 * The answer to what was typed, or null.
 *
 * @returns {{ title: string, copy: string, detail: string } | null}
 *   title - what the row shows ("= 90"), copy - what a click copies ("90"),
 *   detail - what it was worked out from
 */
function answer(text) {
  const typed = String(text || '').trim();
  if (!typed || typed.length > 200) return null;
  const conv = conversionOf(typed);
  if (conv) {
    const shown = `${format(conv.value)} ${conv.unit}`;
    return { title: `= ${shown}`, copy: format(conv.value).replace(/,/g, ''), detail: conv.from };
  }
  const v = sumOf(typed);
  if (v === null) return null;
  return { title: `= ${format(v)}`, copy: format(v).replace(/,/g, ''), detail: typed.replace(/^=\s*/, '').replace(/\s*=$/, '') };
}

module.exports = { answer, sumOf, conversionOf, format };
