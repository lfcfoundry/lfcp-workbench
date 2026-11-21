// Page-side generator for a 116-column, SBA-shaped CSV (training-style synthetic data, no byte of any real file).
// Shape: 44 always-quoted 311-style text columns with empty unquoted cells, 20 variable-decimal money columns, 12 ISO date columns,
// 20 zero-padded numeric code columns, 20 quoted text columns with commas, doubled quotes and non-ASCII. Fill rates 2% to 90% per column. CRLF rows.
// Use: import { WIDE_HEADER, wideRows, makeWideCsvFile } from './wide-csv-generator.mjs'; const file = await makeWideCsvFile('wide.csv', 158038);
// Written by the CSV parse thread, Fri Nov 20, 2026, Detroit. Catalog: ingest-formats / wide-csv-generator.
const T44 = ['award_id_fain','created_date','closed_date','agency','agency_name','complaint_type','descriptor','descriptor_2','location_type','incident_zip','incident_address','street_name','cross_street_1','cross_street_2','intersection_street_1','intersection_street_2','address_type','city','landmark','facility_type','status','due_date','resolution_description','resolution_action_updated_date','community_board','council_district','police_precinct','bbl','recipient_state_code','x_coordinate_state_plane','y_coordinate_state_plane','open_data_channel_type','park_facility_name','park_borough','vehicle_type','taxi_company_borough','taxi_pick_up_location','bridge_highway_name','bridge_highway_direction','road_ramp','bridge_highway_segment','latitude','longitude','location'];
const seq = (p, n) => Array.from({ length: n }, (_, i) => p + (i + 1));
export const WIDE_NAMES = [...T44, 'face_value_of_loan', ...seq('amount_', 19).map((x, i) => 'amount_' + (i + 2)).slice(0, 19), ...seq('action_date_', 12), ...seq('code_', 20), ...seq('note_', 20)];
export const WIDE_HEADER = WIDE_NAMES.map((n) => '"' + n + '"').join(',');
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WORDS = ['Park', 'Street', 'Avenue', 'Maintenance', 'Facility', 'Structure', 'Outdoors', 'Gate', 'Closed', 'Open', 'Pending', 'Department', 'Parks', 'Recreation', 'Bronx', 'Brooklyn', 'Queens', 'Manhattan', 'Island', 'Bridge', 'Highway', 'North', 'South', 'East', 'West'];
const ODD = ['Café', 'Müller', 'Niño', 'Zürich', "O'Brien", 'Smith, Jones & Co', '"Big" Co.', 'Ltd.'];
const pad = (n, w) => String(n).padStart(w, '0');
export function* wideRows(n, seed = 20261120) {
  const r = rng(seed), ncol = WIDE_NAMES.length, fill = [], pool = [], kind = [];
  for (let c = 0; c < ncol; c++) {
    fill.push(0.02 + r() * 0.88);
    if (c < 44) { kind.push(c === 0 || c === 9 || c === 27 ? 'id' : c === 1 || c === 2 || c === 21 || c === 23 ? 'ts' : 'w'); pool.push(Array.from({ length: c % 3 === 0 ? 6 : c % 3 === 1 ? 300 : 4000 }, () => WORDS[Math.floor(r() * WORDS.length)] + ' ' + WORDS[Math.floor(r() * WORDS.length)] + (r() < 0.3 ? ' ' + Math.floor(r() * 99) : ''))); }
    else if (c < 64) { kind.push('money'); pool.push(null); }
    else if (c < 76) { kind.push('date'); pool.push(null); }
    else if (c < 96) { kind.push('code'); pool.push([3, 5, 10][c % 3]); }
    else { kind.push('note'); pool.push(null); }
  }
  yield WIDE_HEADER + '\r\n';
  let ts0 = Date.UTC(2018, 0, 1);
  for (let i = 0; i < n; i++) {
    const out = new Array(ncol);
    for (let c = 0; c < ncol; c++) {
      if (r() >= fill[c]) { out[c] = ''; continue; }
      const k = kind[c];
      if (k === 'w') { const p = pool[c]; out[c] = '"' + p[Math.floor(r() * p.length)] + '"'; }
      else if (k === 'id') out[c] = '"' + (c === 9 ? pad(10000 + Math.floor(r() * 400), 5) : c === 27 ? pad(Math.floor(r() * 1e10), 10) : String(40000000 + i)) + '"';
      else if (k === 'ts') out[c] = '"' + new Date(ts0 + Math.floor(r() * 2.2e8) * 10).toISOString().slice(0, 23) + '"';
      else if (k === 'money') { const d = [0, 2, 4][Math.floor(r() * 3)], v = r() * r() * [1, 10, 100, 1000][c % 4]; out[c] = d ? v.toFixed(d) : String(Math.round(v)); }
      else if (k === 'date') out[c] = new Date(ts0 + Math.floor(r() * 2.5e8) * 10).toISOString().slice(0, 10);
      else if (k === 'code') out[c] = pad(Math.floor(r() * Math.pow(10, Math.min(pool[c], 9))), pool[c]);
      else { const a = r() < 0.5 ? ODD[Math.floor(r() * ODD.length)] : WORDS[Math.floor(r() * WORDS.length)]; const b = r() < 0.5 ? ODD[Math.floor(r() * ODD.length)] + ' ' + WORDS[Math.floor(r() * WORDS.length)] : ''; out[c] = '"' + (a + (b ? ' ' + b : '')).replace(/"/g, '""') + '"'; }
    }
    yield out.join(',') + '\r\n';
  }
}
export async function makeWideCsvFile(name, rows, seed, onProgress) {   // writes the file in the page's private storage and returns it as a File
  const dir = await navigator.storage.getDirectory(), fh = await dir.getFileHandle(name, { create: true }), w = await fh.createWritable({ keepExistingData: false });
  let buf = [], n = 0; for (const line of wideRows(rows, seed)) { buf.push(line); if (++n % 4000 === 0) { await w.write(buf.join('')); buf = []; if (onProgress) onProgress(n, rows); } }
  if (buf.length) await w.write(buf.join('')); await w.close(); return fh.getFile();
}
