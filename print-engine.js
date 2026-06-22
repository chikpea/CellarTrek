// CellarTrek Event Print Engine
// Generates browser-printable HTML for all event materials.
// Used by both cellartrek_v12.html and venue-admin.html
// All functions return an HTML string that can be opened in a new tab and printed to PDF.

const CT_PRINT = (() => {

  // ── Style definitions ─────────────────────────────────────────
  const STYLES = {
    classic: {
      bg:'#2a150e', cardBg:'#3a1e10', accent:'#c8a04c', accentDim:'rgba(200,160,76,.2)',
      text:'#f5ede0', textDim:'rgba(245,237,224,.65)', textFaint:'rgba(245,237,224,.35)',
      border:'rgba(200,160,76,.35)', titleFont:"'Cormorant Garamond',Georgia,serif",
      bodyFont:"'Cormorant Garamond',Georgia,serif", sanFont:"'Montserrat',system-ui,sans-serif",
      wineTypes:{ red:'#8b2240', white:'#c8a04c', rose:'#d4789a', sparkling:'#7ab8d4', dessert:'#9c7a3c' }
    },
    modern: {
      bg:'#0e1420', cardBg:'#161e2e', accent:'#3a7bd4', accentDim:'rgba(58,123,212,.2)',
      text:'#e8eef8', textDim:'rgba(232,238,248,.65)', textFaint:'rgba(232,238,248,.35)',
      border:'rgba(58,123,212,.35)', titleFont:"'Montserrat',system-ui,sans-serif",
      bodyFont:"'Montserrat',system-ui,sans-serif", sanFont:"'Montserrat',system-ui,sans-serif",
      wineTypes:{ red:'#c05070', white:'#70b8d0', rose:'#d090b0', sparkling:'#70c0e0', dessert:'#c0a060' }
    },
    rustic: {
      bg:'#1a130a', cardBg:'#261a0e', accent:'#b87c42', accentDim:'rgba(184,124,66,.2)',
      text:'#f0e8d8', textDim:'rgba(240,232,216,.65)', textFaint:'rgba(240,232,216,.35)',
      border:'rgba(184,124,66,.35)', titleFont:"'Cormorant Garamond',Georgia,serif",
      bodyFont:"'Cormorant Garamond',Georgia,serif", sanFont:"'Montserrat',system-ui,sans-serif",
      wineTypes:{ red:'#8b3020', white:'#b89060', rose:'#c07868', sparkling:'#80a090', dessert:'#907040' }
    },
  };

  function getStyle(styleName, brandColor) {
    const st = STYLES[styleName || 'classic'];
    if (brandColor) {
      return { ...st, accent: brandColor, border: brandColor + '55' };
    }
    return st;
  }

  // ── Shared HTML shell ─────────────────────────────────────────
  function shell(pageSize, orientation, content, styleName, brandColor, extraCss='') {
    const st = getStyle(styleName, brandColor);
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Montserrat:wght@300;400;500;600&display=swap" rel="stylesheet"/>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: ${pageSize} ${orientation}; margin: 0; }
html, body { width: 100%; height: 100%; background: ${st.bg}; color: ${st.text}; font-family: ${st.bodyFont}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
${extraCss}
</style>
</head>
<body>${content}</body>
</html>`;
  }

  // ── Date formatting ───────────────────────────────────────────
  function fmtDate(d) {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  }
  function fmtTime(t) {
    if (!t) return '';
    const [h, m] = t.split(':');
    const hour = parseInt(h);
    return `${hour > 12 ? hour - 12 : hour || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
  }
  function detectStyle(invDesign) {
    if (!invDesign) return 'classic';
    const d = (invDesign || '').toLowerCase();
    if (d.includes('modern') || d.includes('minimal')) return 'modern';
    if (d.includes('rustic') || d.includes('earthy')) return 'rustic';
    return 'classic';
  }

  // ══════════════════════════════════════════════════════════════
  // 1. EVENT POSTER  (A3 portrait)
  // ══════════════════════════════════════════════════════════════
  function poster(ev, opts = {}) {
    const styleName = opts.style || detectStyle(ev.invitation_design);
    const st = getStyle(styleName, opts.brandColor);
    const logoHtml = opts.logoUrl
      ? `<img src="${opts.logoUrl}" style="height:50px;object-fit:contain;display:block;margin:0 auto 18px" alt=""/>`
      : `<div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:${st.accent};margin-bottom:18px">${opts.venueName || 'CellarTrek'}</div>`;

    const content = `
<div style="width:297mm;min-height:420mm;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40mm 25mm;text-align:center;position:relative">
  <div style="position:absolute;top:0;left:0;right:0;height:6px;background:${st.accent}"></div>
  <div style="position:absolute;bottom:0;left:0;right:0;height:3px;background:${st.accent};opacity:.5"></div>

  <div style="border:1px solid ${st.border};padding:4mm 8mm;margin-bottom:12mm;display:inline-block">
    <div style="font-size:9pt;letter-spacing:.18em;text-transform:uppercase;color:${st.accent};font-family:${st.sanFont}">You are invited</div>
  </div>

  ${logoHtml}

  <div style="font-size:48pt;font-weight:300;font-family:${st.titleFont};line-height:1.15;margin-bottom:8mm;color:${st.text}">${ev.title}</div>

  ${ev.invitation_text ? `
  <div style="font-size:13pt;font-style:italic;line-height:1.8;color:${st.textDim};max-width:200mm;margin-bottom:10mm;font-family:${st.bodyFont}">"${ev.invitation_text}"</div>
  ` : ev.description ? `
  <div style="font-size:13pt;line-height:1.8;color:${st.textDim};max-width:200mm;margin-bottom:10mm">${ev.description}</div>
  ` : ''}

  <div style="width:40mm;height:1px;background:${st.accent};opacity:.5;margin:6mm auto"></div>

  <div style="font-size:16pt;color:${st.text};margin-bottom:4mm;font-family:${st.sanFont};font-weight:300">${fmtDate(ev.event_date)}</div>
  ${ev.event_time ? `<div style="font-size:13pt;color:${st.textDim};margin-bottom:4mm;font-family:${st.sanFont}">${fmtTime(ev.event_time)}</div>` : ''}
  ${ev.venue_name ? `<div style="font-size:13pt;color:${st.textDim};margin-bottom:2mm;font-family:${st.sanFont}">${ev.venue_name}</div>` : ''}
  ${ev.venue_address ? `<div style="font-size:11pt;color:${st.textFaint};font-family:${st.sanFont}">${ev.venue_address}</div>` : ''}

  ${ev.pairing_menu && ev.pairing_menu.length ? `
  <div style="margin-top:10mm;border-top:1px solid ${st.border};padding-top:8mm;width:100%">
    <div style="font-size:9pt;letter-spacing:.15em;text-transform:uppercase;color:${st.accent};margin-bottom:5mm;font-family:${st.sanFont}">Menu</div>
    ${JSON.parse(typeof ev.pairing_menu === 'string' ? ev.pairing_menu : JSON.stringify(ev.pairing_menu)).map(c =>
      `<div style="font-size:11pt;color:${st.textDim};margin-bottom:3mm;font-family:${st.bodyFont}">${c.course ? `<span style="color:${st.textFaint}">${c.course} — </span>` : ''}${c.dish}${c.wine ? ` <span style="color:${st.accent}">· ${c.wine}</span>` : ''}</div>`
    ).join('')}
  </div>` : ''}

  <div style="position:absolute;bottom:12mm;font-size:8pt;color:${st.textFaint};letter-spacing:.1em;font-family:${st.sanFont}">PRESENTED BY CELLARTREK</div>
</div>`;
    return shell('297mm 420mm', 'portrait', content, styleName, opts.brandColor);
  }

  // ══════════════════════════════════════════════════════════════
  // 2. NAME CARDS  (A7 landscape, tent-fold style)
  // One per guest, all on the same HTML page for efficient printing
  // ══════════════════════════════════════════════════════════════
  function nameCards(ev, guests, opts = {}) {
    const styleName = opts.style || detectStyle(ev.invitation_design);
    const st = getStyle(styleName, opts.brandColor);

    const cardHtml = guests.filter(g => g.rsvp !== 'no' && g.name).map(g => `
<div class="name-card">
  <div class="top-half">
    <div class="guest-name">${g.name}</div>
    <div class="event-name">${ev.title}</div>
  </div>
  <div class="divider-line"></div>
  <div class="bottom-half">
    <div class="guest-name" style="transform:rotate(180deg)">${g.name}</div>
    <div class="event-name" style="transform:rotate(180deg)">${ev.title}</div>
  </div>
</div>`).join('');

    const css = `
.name-card {
  width: 105mm; height: 74mm;
  display: inline-flex; flex-direction: column;
  background: ${st.cardBg}; border: 1px solid ${st.border};
  page-break-inside: avoid; margin: 3mm; overflow: hidden;
}
.top-half, .bottom-half {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; padding: 4mm 6mm;
}
.divider-line {
  height: 1px; background: ${st.accent}; opacity: .5; margin: 0 8mm;
  border-top: 1px dashed ${st.accent};
}
.guest-name {
  font-size: 22pt; font-weight: 400; font-family: ${st.titleFont};
  color: ${st.text}; text-align: center; line-height: 1.2; margin-bottom: 2mm;
}
.event-name {
  font-size: 7pt; letter-spacing: .12em; text-transform: uppercase;
  color: ${st.accent}; font-family: ${st.sanFont}; text-align: center;
}`;

    return shell('A4', 'landscape',
      `<div style="padding:5mm">${cardHtml}</div>`,
      styleName, opts.brandColor, css);
  }

  // ══════════════════════════════════════════════════════════════
  // 3. WINE DISPLAY CARDS  (A6 portrait)
  // One per wine in the pairing menu
  // ══════════════════════════════════════════════════════════════
  function wineCards(ev, opts = {}) {
    const styleName = opts.style || detectStyle(ev.invitation_design);
    const st = getStyle(styleName, opts.brandColor);
    const menu = typeof ev.pairing_menu === 'string'
      ? JSON.parse(ev.pairing_menu)
      : (ev.pairing_menu || []);

    const wines = menu.filter(c => c.wine);

    const cardHtml = wines.map(c => {
      const wineType = (c.wine_type || 'red').toLowerCase();
      const typeColor = st.wineTypes[wineType] || st.accent;
      return `
<div class="wine-card">
  <div style="height:5px;background:${typeColor};width:100%"></div>
  <div style="padding:8mm 7mm;display:flex;flex-direction:column;height:calc(100% - 5px)">
    <div style="font-size:7pt;letter-spacing:.15em;text-transform:uppercase;color:${typeColor};margin-bottom:3mm;font-family:${st.sanFont}">${c.course || ev.title}</div>
    <div style="font-size:18pt;font-weight:400;font-family:${st.titleFont};color:${st.text};line-height:1.2;margin-bottom:1mm">${c.wine}</div>
    ${c.vintage ? `<div style="font-size:11pt;color:${st.accent};font-family:${st.bodyFont};margin-bottom:4mm">${c.vintage}</div>` : ''}
    ${c.region ? `<div style="font-size:9pt;color:${st.textDim};font-family:${st.sanFont};margin-bottom:4mm;letter-spacing:.05em">${c.region}</div>` : ''}
    <div style="flex:1;border-top:1px solid ${st.border};padding-top:4mm;margin-top:auto">
      ${c.tasting_note ? `<div style="font-size:9pt;font-style:italic;line-height:1.7;color:${st.textDim};font-family:${st.bodyFont}">${c.tasting_note}</div>` :
        `<div style="font-size:9pt;color:${st.textFaint};font-family:${st.bodyFont}">Paired with: ${c.dish || '—'}</div>`}
    </div>
    <div style="margin-top:4mm;font-size:7pt;color:${st.textFaint};letter-spacing:.1em;font-family:${st.sanFont}">CELLARTREK · WINE SELECTION</div>
  </div>
</div>`;
    }).join('');

    const css = `.wine-card { width:105mm; height:148mm; display:inline-flex; flex-direction:column; background:${st.cardBg}; border:1px solid ${st.border}; page-break-inside:avoid; margin:3mm; overflow:hidden; vertical-align:top; }`;

    return shell('A4', 'portrait',
      `<div style="padding:5mm">${wines.length ? cardHtml : `<div style="padding:20mm;color:${st.textFaint};text-align:center;font-family:${st.sanFont}">No wines in pairing menu</div>`}</div>`,
      styleName, opts.brandColor, css);
  }

  // ══════════════════════════════════════════════════════════════
  // 4. MENU CARD  (A5 portrait)
  // ══════════════════════════════════════════════════════════════
  function menuCard(ev, opts = {}) {
    const styleName = opts.style || detectStyle(ev.invitation_design);
    const st = getStyle(styleName, opts.brandColor);
    const menu = typeof ev.pairing_menu === 'string'
      ? JSON.parse(ev.pairing_menu)
      : (ev.pairing_menu || []);
    const logoHtml = opts.logoUrl
      ? `<img src="${opts.logoUrl}" style="height:30px;object-fit:contain;display:block;margin:0 auto 6mm" alt=""/>`
      : '';

    const content = `
<div style="width:148mm;min-height:210mm;padding:14mm 12mm;display:flex;flex-direction:column;background:${st.cardBg}">
  <div style="text-align:center;margin-bottom:8mm">
    ${logoHtml}
    <div style="font-size:8pt;letter-spacing:.18em;text-transform:uppercase;color:${st.accent};margin-bottom:3mm;font-family:${st.sanFont}">${fmtDate(ev.event_date)}${ev.event_time ? ' · ' + fmtTime(ev.event_time) : ''}</div>
    <div style="font-size:22pt;font-weight:400;font-family:${st.titleFont};color:${st.text};line-height:1.2;margin-bottom:2mm">${ev.title}</div>
    ${ev.venue_name ? `<div style="font-size:9pt;color:${st.textDim};font-family:${st.sanFont}">${ev.venue_name}</div>` : ''}
  </div>

  <div style="width:100%;height:1px;background:${st.accent};opacity:.4;margin-bottom:8mm"></div>

  ${menu.length ? `
  <div style="flex:1">
    <div style="font-size:7pt;letter-spacing:.15em;text-transform:uppercase;color:${st.accent};margin-bottom:5mm;text-align:center;font-family:${st.sanFont}">Menu</div>
    ${menu.map(c => `
    <div style="margin-bottom:6mm">
      ${c.course ? `<div style="font-size:7pt;letter-spacing:.12em;text-transform:uppercase;color:${st.accent};margin-bottom:1mm;font-family:${st.sanFont}">${c.course}</div>` : ''}
      <div style="font-size:12pt;font-family:${st.bodyFont};color:${st.text};margin-bottom:1mm">${c.dish}</div>
      ${c.wine ? `<div style="font-size:9pt;font-style:italic;color:${st.textDim};font-family:${st.bodyFont}">${c.wine}${c.vintage ? ' ' + c.vintage : ''}</div>` : ''}
    </div>`).join('')}
  </div>` : `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:${st.textFaint};font-size:10pt;font-family:${st.bodyFont};font-style:italic">An evening of fine wine</div>`}

  <div style="margin-top:auto;padding-top:6mm;border-top:1px solid ${st.border};text-align:center">
    <div style="font-size:7pt;color:${st.textFaint};letter-spacing:.1em;font-family:${st.sanFont}">PRESENTED BY CELLARTREK</div>
  </div>
</div>`;

    return shell('148mm 210mm', 'portrait', content, styleName, opts.brandColor);
  }

  // ══════════════════════════════════════════════════════════════
  // 5. TABLE NUMBERS  (A7 portrait, tent cards)
  // ══════════════════════════════════════════════════════════════
  function tableNumbers(ev, count, opts = {}) {
    const styleName = opts.style || detectStyle(ev.invitation_design);
    const st = getStyle(styleName, opts.brandColor);
    const n = Math.max(1, Math.min(parseInt(count) || 10, 50));

    const cards = Array.from({length: n}, (_, i) => i + 1).map(num => `
<div class="table-card">
  <div class="top-half">
    <div class="table-num">${num}</div>
    <div class="table-label">${ev.title}</div>
  </div>
  <div style="height:1px;background:${st.accent};opacity:.4;border-top:1px dashed ${st.accent};margin:0 6mm"></div>
  <div class="bottom-half">
    <div class="table-num" style="transform:rotate(180deg)">${num}</div>
    <div class="table-label" style="transform:rotate(180deg)">${ev.title}</div>
  </div>
</div>`).join('');

    const css = `
.table-card { width:74mm; height:105mm; display:inline-flex; flex-direction:column; background:${st.cardBg}; border:1px solid ${st.border}; page-break-inside:avoid; margin:3mm; overflow:hidden; vertical-align:top; }
.top-half,.bottom-half { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:4mm; }
.table-num { font-size:42pt; font-weight:300; font-family:${st.titleFont}; color:${st.accent}; line-height:1; }
.table-label { font-size:6pt; letter-spacing:.14em; text-transform:uppercase; color:${st.textFaint}; font-family:${st.sanFont}; text-align:center; margin-top:2mm; }`;

    return shell('A4', 'portrait',
      `<div style="padding:5mm">${cards}</div>`,
      styleName, opts.brandColor, css);
  }

  // ══════════════════════════════════════════════════════════════
  // Helper: open print page in new tab
  // ══════════════════════════════════════════════════════════════
  function openPrint(html, filename) {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (win) {
      win.addEventListener('load', () => {
        setTimeout(() => win.print(), 500);
      });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Helper: download as HTML file
  // ══════════════════════════════════════════════════════════════
  function download(html, filename) {
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return { poster, nameCards, wineCards, menuCard, tableNumbers, openPrint, download, detectStyle, STYLES };
})();
