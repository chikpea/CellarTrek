#!/usr/bin/env node
'use strict';

/* ============================================================================
 * CellarTrek — Branding Extraction Worker (proof of concept)
 *
 * Given a venue's public website URL, renders it headlessly and extracts a
 * draft theme token set: colors, fonts, logo, and hero imagery.
 * ========================================================================== */

const fs = require('fs');

function parseColor(str) {
  if (!str) return null;
  str = String(str).trim().toLowerCase();
  if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return null;

  let m = str.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const h = m[1];
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
      a: 1
    };
  }

  m = str.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const h = m[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1
    };
  }

  m = str.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some(v => Number.isNaN(v))) return null;
    return {
      r: parts[0],
      g: parts[1],
      b: parts[2],
      a: parts[3] == null || Number.isNaN(parts[3]) ? 1 : parts[3]
    };
  }

  return null;
}

function toHex(c) {
  const h = v => ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2);
  return '#' + h(c.r) + h(c.g) + h(c.b);
}

function luminance(c) {
  const f = v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrastRatio(a, b) {
  const L1 = luminance(a);
  const L2 = luminance(b);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

function colorDist(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function saturation(c) {
  const mx = Math.max(c.r, c.g, c.b);
  const mn = Math.min(c.r, c.g, c.b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

function isNeutral(c) {
  return saturation(c) < 0.12;
}

const GOOGLE_FONTS = new Set([
  'inter', 'roboto', 'open sans', 'lato', 'montserrat', 'poppins', 'raleway', 'nunito',
  'work sans', 'source sans pro', 'playfair display', 'merriweather', 'lora',
  'cormorant garamond', 'eb garamond', 'oswald', 'bebas neue', 'josefin sans', 'jost',
  'fraunces', 'libre baskerville', 'cardo', 'marcellus', 'crimson text'
]);

const COMMERCIAL_HINTS = [
  'proxima', 'gotham', 'avenir', 'futura', 'helvetica neue', 'circular', 'sofia',
  'brandon', 'sentinel', 'tungsten', 'knockout', 'gt ', 'sangbleu', 'canela', 'tiempos',
  'söhne', 'sohne', 'graphik', 'founders', 'aktiv', 'neue haas', 'din ', 'frutiger',
  'typekit', 'adobe'
];

const FREE_SUBSTITUTE = {
  'proxima nova': 'Montserrat',
  'gotham': 'Montserrat',
  'avenir': 'Nunito Sans',
  'futura': 'Jost',
  'helvetica neue': 'Inter',
  'circular': 'Inter',
  'graphik': 'Inter',
  'din': 'Oswald',
  'canela': 'Cormorant Garamond',
  'tiempos': 'Lora',
  'sangbleu': 'Playfair Display',
  'söhne': 'Inter',
  'sohne': 'Inter',
  'founders grotesk': 'Work Sans'
};

function primaryFamily(stack) {
  if (!stack) return null;
  return stack.split(',')[0].replace(/["']/g, '').trim();
}

function classifyFont(family) {
  if (!family) return null;
  const f = family.toLowerCase();

  if (GOOGLE_FONTS.has(f)) {
    return { family, license: 'free', source: 'google', substitute: null };
  }

  const commercial = COMMERCIAL_HINTS.some(h => f.includes(h));
  if (commercial) {
    let sub = null;
    for (const k of Object.keys(FREE_SUBSTITUTE)) {
      if (f.includes(k)) {
        sub = FREE_SUBSTITUTE[k];
        break;
      }
    }
    return { family, license: 'commercial', source: 'unknown', substitute: sub || 'Inter' };
  }

  if (['-apple-system', 'blinkmacsystemfont', 'system-ui', 'sans-serif', 'serif', 'arial', 'georgia', 'times'].some(s => f.includes(s))) {
    return { family, license: 'system', source: 'system', substitute: null };
  }

  return { family, license: 'unknown', source: 'unknown', substitute: 'Inter' };
}

function assignRoles(swatches, computed = {}) {
  const bg = computed.bg ? parseColor(computed.bg) : null;
  const text = computed.text ? parseColor(computed.text) : null;

  const background = bg ? toHex(bg) : '#ffffff';
  const ink = text ? toHex(text) : '#1a1a1a';
  const isDark = bg ? luminance(bg) < 0.4 : false;

  const candidates = [];
  if (computed.buttonBg) {
    const c = parseColor(computed.buttonBg);
    if (c && !isNeutral(c)) candidates.push({ c, score: 1e6 });
  }
  if (computed.link) {
    const c = parseColor(computed.link);
    if (c && !isNeutral(c)) candidates.push({ c, score: 5e5 });
  }
  for (const s of swatches || []) {
    const c = parseColor(s.hex);
    if (c && !isNeutral(c)) candidates.push({ c, score: Number(s.count) || 0 });
  }

  let accent = isDark ? '#c79a4b' : '#7a1228';
  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score);
    accent = toHex(candidates[0].c);
  }

  const accentC = parseColor(accent);
  const inkColor = parseColor(ink) || { r: 26, g: 26, b: 26 };
  const bgColor = parseColor(background) || { r: 255, g: 255, b: 255 };
  const accentDeep = toHex({ r: accentC.r * 0.78, g: accentC.g * 0.78, b: accentC.b * 0.78 });

  // Pick the on-accent color with the highest contrast against the accent.
  // Candidates: pure white, the brand ink, and the brand background. On a dark
  // venue the background (near-black) is usually the legible choice on a gold/
  // saturated accent — white alone is often too low-contrast.
  const onAccentChoices = [
    { hex: '#ffffff', c: { r: 255, g: 255, b: 255 } },
    { hex: ink, c: inkColor },
    { hex: background, c: bgColor }
  ];
  const onAccent = onAccentChoices
    .map(o => ({ ...o, ratio: contrastRatio(accentC, o.c) }))
    .sort((a, b) => b.ratio - a.ratio)[0].hex;

  const warnings = [];
  if (text && bg && contrastRatio(text, bg) < 4.5) {
    warnings.push(`Body text contrast is ${contrastRatio(text, bg).toFixed(1)}:1 (below 4.5:1 readable threshold).`);
  }
  if (contrastRatio(accentC, parseColor(onAccent)) < 3.0) {
    warnings.push('Text on the accent color is low-contrast; confirm button legibility.');
  }

  return {
    colors: { accent, accentDeep, ink, bg: background, onAccent, isDark },
    warnings
  };
}

const EXTRACT_FN = `() => {
  const body = document.body;
  const header = document.querySelector('header,[role="banner"],.header,#header,nav') || body;
  const btn = document.querySelector('button,.btn,[class*="button"],a[class*="btn"]');
  const link = document.querySelector('a[href]');
  const h1 = document.querySelector('h1,h2');

  const colorCounts = {};
  const bump = (v) => {
    if (!v) return;
    v = v.trim();
    if (!v || v === 'rgba(0, 0, 0, 0)' || v === 'transparent') return;
    colorCounts[v] = (colorCounts[v] || 0) + 1;
  };

  const sample = document.querySelectorAll('a,button,h1,h2,h3,header,nav,.btn,[class*="btn"],[class*="brand"],[class*="logo"],section,div');
  let n = 0;
  for (const el of sample) {
    if (n++ > 1200) break;
    const st = getComputedStyle(el);
    bump(st.backgroundColor);
    bump(st.color);
    bump(st.borderTopColor);
  }

  const swatches = Object.entries(colorCounts).map(([v, count]) => ({ raw: v, count }));

  const fontOf = el => (el ? getComputedStyle(el).fontFamily : null);
  const fonts = {
    heading: fontOf(h1) || fontOf(header),
    body: getComputedStyle(body).fontFamily,
    headingWeight: h1 ? getComputedStyle(h1).fontWeight : null
  };

  const computed = {
    bg: getComputedStyle(body).backgroundColor,
    text: getComputedStyle(body).color,
    link: link ? getComputedStyle(link).color : null,
    buttonBg: btn ? getComputedStyle(btn).backgroundColor : null,
    headingColor: h1 ? getComputedStyle(h1).color : null
  };

  const pickLogo = () => {
    const cand = header.querySelector('img');
    if (cand && cand.src) return cand.src;
    const og = document.querySelector('meta[property="og:image"]');
    if (og && og.content) return og.content;
    const icon = document.querySelector('link[rel*="icon"]');
    return icon ? icon.href : null;
  };

  const pickHero = () => {
    let best = null;
    let bestArea = 0;
    document.querySelectorAll('img').forEach(img => {
      const r = img.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.top < 900 && area > bestArea && area > 50000) {
        bestArea = area;
        best = img.src;
      }
    });
    const og = document.querySelector('meta[property="og:image"]');
    return best || (og ? og.content : null);
  };

  return {
    swatches,
    fonts,
    computed,
    logoUrl: pickLogo(),
    heroUrl: pickHero(),
    title: document.title,
    siteName: (document.querySelector('meta[property="og:site_name"]') || {}).content || null
  };
}`;

function quantize(rawSwatches) {
  const parsed = [];
  for (const s of rawSwatches || []) {
    const c = parseColor(s.raw);
    if (!c || c.a < 0.5) continue;
    parsed.push({ c, hex: toHex(c), count: Number(s.count) || 0 });
  }

  const merged = [];
  for (const p of parsed.sort((a, b) => b.count - a.count)) {
    const near = merged.find(m => colorDist(m.c, p.c) < 24);
    if (near) near.count += p.count;
    else merged.push({ ...p });
  }

  return merged
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
    .map(m => ({ hex: m.hex, count: m.count }));
}

function scoreConfidence(roles, hf, bf, raw) {
  let score = 0.4;
  if (raw.computed.buttonBg || raw.computed.link) score += 0.2;
  if (hf && hf.license !== 'unknown') score += 0.15;
  if (bf && bf.license !== 'unknown') score += 0.1;
  if (raw.logoUrl) score += 0.1;
  if (roles.warnings.length === 0) score += 0.05;
  return Math.min(1, Number(score.toFixed(2)));
}

// ── SSRF guard (spec §1.2): the worker fetches a venue-supplied URL, so it is
// untrusted. Reject non-http(s) schemes and any host that resolves to or is
// written as localhost / private / link-local / reserved space. This mirrors
// the validation the endpoint must also do — defense in depth, neither layer
// is the sole line of defense.
function validateUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'Malformed URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https URLs are allowed' };
  }
  const host = u.hostname.toLowerCase();

  // Block obvious local / non-routable hostnames.
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local') ||
      host.endsWith('.internal') || !host.includes('.')) {
    return { ok: false, reason: 'Host is not a public address' };
  }

  // If the host is a literal IPv4, block private / loopback / link-local / reserved ranges.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1, 5).map(Number);
    if (o.some(n => n > 255)) return { ok: false, reason: 'Invalid IPv4 address' };
    const [a, b] = o;
    const blocked =
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||                 // link-local
      (a === 172 && b >= 16 && b <= 31) ||        // private
      (a === 192 && b === 168) ||                 // private
      (a === 100 && b >= 64 && b <= 127) ||       // CGNAT
      a >= 224;                                   // multicast / reserved
    if (blocked) return { ok: false, reason: 'IP address is in a private or reserved range' };
  }

  // Block bracketed IPv6 literals outright (covers ::1, fc00::/7, fe80::/10, mapped v4).
  if (host.includes(':') || raw.includes('[')) {
    return { ok: false, reason: 'IPv6 literals are not allowed' };
  }

  return { ok: true, url: u.href };
}

async function extract(url, opts = {}) {
  const check = validateUrl(url);
  if (!check.ok) {
    return { ok: false, error: check.reason, diagnostics: { url, rejected: true } };
  }
  url = check.url;
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const diagnostics = { url, startedAt: new Date().toISOString() };

  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(20000);

    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 }).catch(async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });

    await page.waitForTimeout(1200);

    let raw;
    try {
      raw = await page.evaluate('(' + EXTRACT_FN + ')()');
    } catch (evalErr) {
      throw new Error('page.evaluate failed: ' + evalErr.message);
    }
    if (!raw) throw new Error('Page loaded but returned no data — the site may have blocked the browser or rendered no content');
    if (opts.shot) await page.screenshot({ path: opts.shot, fullPage: false });

    const swatches = quantize(raw.swatches);
    const roles = assignRoles(swatches, raw.computed);

    const headingFamily = primaryFamily(raw.fonts.heading);
    const bodyFamily = primaryFamily(raw.fonts.body);
    const headingFont = classifyFont(headingFamily);
    const bodyFont = classifyFont(bodyFamily);

    const abs = u => {
      try {
        return u ? new URL(u, url).href : null;
      } catch {
        return null;
      }
    };

    const theme = {
      schema_version: 1,
      source: {
        url,
        title: raw.title,
        siteName: raw.siteName,
        extractedAt: new Date().toISOString()
      },
      colors: roles.colors,
      palette: swatches,
      fonts: {
        display: headingFont ? { family: headingFamily, ...headingFont, weight: raw.fonts.headingWeight || null } : null,
        body: bodyFont ? { family: bodyFamily, ...bodyFont } : null
      },
      assets: { logoUrl: abs(raw.logoUrl), heroUrl: abs(raw.heroUrl) },
      warnings: roles.warnings,
      confidence: scoreConfidence(roles, headingFont, bodyFont, raw)
    };

    diagnostics.finishedAt = new Date().toISOString();
    return { ok: true, theme, diagnostics };
  } catch (e) {
    diagnostics.finishedAt = new Date().toISOString();
    diagnostics.error = e && e.message ? e.message : String(e);
    return { ok: false, error: diagnostics.error, diagnostics };
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const shotIdx = args.indexOf('--shot');

  if (!url) {
    console.error('Usage: node branding-worker.js <url> [--out theme.json] [--shot shot.png]');
    process.exit(1);
  }

  const opts = {};
  if (shotIdx >= 0 && args[shotIdx + 1]) opts.shot = args[shotIdx + 1];

  extract(url, opts)
    .then(result => {
      const json = JSON.stringify(result, null, 2);
      if (outIdx >= 0 && args[outIdx + 1]) {
        fs.writeFileSync(args[outIdx + 1], json);
        console.error('Wrote', args[outIdx + 1]);
      }
      console.log(json);
      process.exit(result.ok ? 0 : 2);
    })
    .catch(err => {
      console.error(err && err.stack ? err.stack : String(err));
      process.exit(2);
    });
}

module.exports = { extract, validateUrl, assignRoles, classifyFont, quantize, parseColor, contrastRatio, primaryFamily };
