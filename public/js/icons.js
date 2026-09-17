// Minimal inline icon set (24x24, stroke-based) so the app ships with zero assets.
const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

// Payment apps carry their own mark, in their own colours, so a cashier picks
// one out of the row at a glance. A shop can replace either with the logo file
// itself (Lists → Payment methods → Upload a logo).
const whish =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<rect width="24" height="24" rx="5.5" fill="#E81B45"/>' +
  '<path d="M2.6 9.9h6M3.4 12h5.2M4.6 14.1h4.4" stroke="#fff" stroke-width="1.15" stroke-linecap="round"/>' +
  '<path d="M9.4 8.7l1.7 6.6 1.9-4.5 1.9 4.5 1.7-6.6" stroke="#fff" stroke-width="2.7" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';
const omt =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<rect x="1" y="6" width="22" height="12" rx="6" fill="#FFE500"/>' +
  '<text x="12" y="15.7" text-anchor="middle" font-family="Inter, Segoe UI, system-ui, sans-serif" ' +
  'font-size="7.6" font-weight="800" font-style="italic" fill="#111">OMT</text></svg>';

export const icons = {
  whish,
  omt,
  dashboard: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  pos: svg('<rect x="2" y="4" width="20" height="12" rx="2"/><path d="M2 20h20M7 8h4M7 12h2"/><circle cx="17" cy="11" r="1.6"/>'),
  box: svg('<path d="m21 8-9-5-9 5v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>'),
  truck: svg('<path d="M10 17h4V5H2v12h3M20 17h2v-5l-3-4h-5v9h2"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>'),
  receipt: svg('<path d="M4 2v20l2.5-1.6L9 22l3-1.6L15 22l2.5-1.6L20 22V2l-2.5 1.6L15 2l-3 1.6L9 2 6.5 3.6z"/><path d="M8 8h8M8 12h8M8 16h4"/>'),
  wallet: svg('<path d="M20 12V8a2 2 0 0 0-2-2H5a2 2 0 0 1 0-4h13v4"/><path d="M3 6v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/><circle cx="17" cy="14" r="1.2"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="m7 14 3-4 3 3 5-7"/>'),
  users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .33 1.76l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.76-.33 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.11a1.6 1.6 0 0 0-1-1.47 1.6 1.6 0 0 0-1.77.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.11a1.6 1.6 0 0 0 1.47-1 1.6 1.6 0 0 0-.33-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.6 1.6 1.6 0 0 0 10 3.13V3a2 2 0 1 1 4 0v.11a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.4 9v.05a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.11a1.6 1.6 0 0 0-1.47 1z"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  trash: svg('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  edit: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>'),
  barcode: svg('<path d="M3 5v14M7 5v14M11 5v10M15 5v14M19 5v14"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  menu: svg('<path d="M3 6h18M3 12h18M3 18h18"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>'),
  print: svg('<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>'),
  trendUp: svg('<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>'),
  trendDown: svg('<path d="m22 17-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>'),
  coins: svg('<circle cx="8" cy="8" r="6"/><path d="M18.1 10.4A6 6 0 1 1 13.6 20"/><path d="M7 6h2M6 10h4"/>'),
  cart: svg('<circle cx="9" cy="20" r="1.6"/><circle cx="18" cy="20" r="1.6"/><path d="M1 1h3l2.7 12.4a2 2 0 0 0 2 1.6h8.7a2 2 0 0 0 2-1.6L21 6H5"/>'),
  key: svg('<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.5 12.5 8-8M17 8l2 2M14.5 10.5l2 2"/>'),
  refresh: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>'),
  clipboard: svg('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>'),
  adjust: svg('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M12 9v6"/><path d="M9 18h6"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
  camera: svg('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>'),
  sliders: svg('<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>'),
  history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>'),
  package: svg('<path d="M16.5 9.4 7.5 4.2"/><path d="m21 16-9 5-9-5V8l9-5 9 5z"/><path d="m3 8 9 5 9-5"/>'),
  card: svg('<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20M6 15h4"/>'),
  transfer: svg('<path d="M4 8h13l-3-3M20 16H7l3 3"/>'),
  phone: svg('<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18.5h2"/>'),
  bank: svg('<path d="M3 10h18L12 4 3 10z"/><path d="M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18"/>'),
  star: svg('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
  gift: svg('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M12 8v13"/><path d="M12 8S10.5 3 8 3a2.5 2.5 0 0 0 0 5M12 8s1.5-5 4-5a2.5 2.5 0 0 1 0 5"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>'),
  back: svg('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
  maximize: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/>'),
  minimize: svg('<path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M21 16h-3a2 2 0 0 0-2 2v3M3 16h3a2 2 0 0 1 2 2v3"/>'),
  database: svg('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
};

export const icon = (name) => icons[name] || '';
