// Staged columns builder (CREDITS: column-at-a-time CSV reading as in Apache Arrow / DuckDB, see docs/CREDITS.md). Same scan and type-flag rules as the row builder (rb3.c),
// but the cells are written to typed columns instead of JSON text. g_bail: 1 = a line or a type-flag change JS must handle, 2 = a cell that stays text in a number column (mixed).
#include <wasm_simd128.h>
typedef unsigned char u8; typedef unsigned int u32; typedef unsigned long long u64;
#define EXPORT(n) __attribute__((export_name(n)))
#define MAXC 128
#define DSL 40
#define DCAP 4096
#define DSLOTS 8
static u8 keybuf[8192]; static u32 keyoff[MAXC], keylen[MAXC];
static u8 isplan[MAXC], flags[MAXC], dslot[MAXC];
static u32 cnt_n[MAXC], cnt_e[MAXC];
static u32 ncols, extra; static u8 D;
static u8 dtab[DSLOTS][DCAP][DSL + 1];   // len byte then bytes; len 0 = empty slot
static u32 g_out, g_rows, g_bail, g_nl;
// ---- Dictionary mode (parse-research prototype): a text column in dict mode writes a u16 code per row (colA[c] is a u16 array) instead of text; the labels (distinct values, first-seen order in this chunk)
// go to dbytes[c] with dstart[c] / dend[c] offsets. More than DMAX labels or no room in dbytes: g_bail = 4 and g_bailcol = the column (JS switches that column to text and calls again from the returned position).
#define DMAX 4096
#define DHS 8192
static u8 dmode[MAXC]; static unsigned short dhash[MAXC][DHS]; static u8* dbytes[MAXC]; static u32 dcap[MAXC], dlen_[MAXC], dn[MAXC]; static u32* dstart[MAXC]; static u32* dend[MAXC]; static u32 g_bailcol;
EXPORT("set_dict") void set_dict(u32 c, u32 on){ dmode[c] = (u8)on; }
EXPORT("set_dict_out") void set_dict_out(u32 c, void* bytes, u32 cap, void* st, void* en){ dbytes[c] = (u8*)bytes; dcap[c] = cap; dstart[c] = (u32*)st; dend[c] = (u32*)en; }
EXPORT("dict_reset") void dict_reset(u32 c){ for (u32 k = 0; k < DHS; k++) dhash[c][k] = 0; dn[c] = 0; dlen_[c] = 0; }
EXPORT("dict_n") u32 dict_n(u32 c){ return dn[c]; }
EXPORT("dict_blen") u32 dict_blen(u32 c){ return dlen_[c]; }
EXPORT("bailcol") u32 bailcol(void){ return g_bailcol; }
static u32 hashb2(const u8* p, u32 l);
static int dict_code(u32 c, const u8* p, u32 l, u32* out){
  u32 h = hashb2(p, l) ^ l;
  for (u32 k = 0; k < DHS; k++) {
    u32 s = (h + k) & (DHS - 1); u32 e = dhash[c][s];
    if (e == 0) {
      if (dn[c] >= DMAX || dlen_[c] + l > dcap[c]) return 0;
      u32 id = dn[c]++; dstart[c][id] = dlen_[c]; for (u32 q = 0; q < l; q++) dbytes[c][dlen_[c] + q] = p[q]; dlen_[c] += l; dend[c][id] = dlen_[c]; dhash[c][s] = (unsigned short)(id + 1); *out = id; return 1;
    }
    u32 id = e - 1, ls = dstart[c][id], ll = dend[c][id] - ls;
    if (ll == l) { u32 q = 0; while (q < l && dbytes[c][ls + q] == p[q]) q++; if (q == l) { *out = id; return 1; } }
  }
  return 0;
}

// Output columns (staged columns): kind per column 0 text, 1 whole numbers, 2 decimals; colA = Float64 values or u32 start offsets, colB = u32 end offsets, colT = text bytes
static u8 okind[MAXC]; static void* colA[MAXC]; static void* colB[MAXC]; static u8* colT[MAXC]; static u32 tlen[MAXC];
EXPORT("set_out") void set_out(u32 c, void* a, void* b, void* t){ colA[c] = a; colB[c] = b; colT[c] = (u8*)t; tlen[c] = 0; }
EXPORT("tlen") u32 tlen_of(u32 c){ return tlen[c]; }
EXPORT("reset_text") void reset_text(void){ for (u32 c = 0; c < MAXC; c++) tlen[c] = 0; }
EXPORT("keys_ptr") u8* keys_ptr(void){ return keybuf; }
EXPORT("flags_ptr") u8* flags_ptr(void){ return flags; }
EXPORT("cnt_n_ptr") u32* cnt_n_ptr(void){ return cnt_n; }
EXPORT("cnt_e_ptr") u32* cnt_e_ptr(void){ return cnt_e; }
EXPORT("setup") void setup(u32 n, u32 d, u32 ex){ ncols = n; D = (u8)d; extra = ex; for (u32 i = 0; i < MAXC; i++) dslot[i] = 255; }
EXPORT("set_col") void set_col(u32 i, u32 off, u32 len, u32 plan, u32 slot){ keyoff[i]=off; keylen[i]=len; isplan[i]=(u8)plan; dslot[i]=(u8)slot; }
EXPORT("set_slot") void set_slot(u32 c, u32 s){ dslot[c] = (u8)s; }
EXPORT("out_len") u32 out_len(void){ return g_out; }
EXPORT("rows") u32 rows(void){ return g_rows; }
EXPORT("bail") u32 bail(void){ return g_bail; }
// A date the JavaScript check (pattern + Date.parse) always accepts, in every engine: a real calendar day, an hour below 24, minutes and seconds below 60,
// optional fraction and a closing Z. Anything else (offsets, hour 24, odd days) returns 0 and the line goes to JavaScript, so the answers stay the same.
static int dig(const u8* v, u32 a, u32 n){ u32 r = 0; for (u32 k = 0; k < n; k++){ u8 c = v[a + k]; if (c < 48 || c > 57) return -1; r = r * 10 + (c - 48); } return (int)r; }
static int date_ok(const u8* v, u32 l){
  if (l < 10 || v[4] != 45 || v[7] != 45) return 0;
  int y = dig(v, 0, 4), mo = dig(v, 5, 2), d = dig(v, 8, 2); if (y < 1000 || mo < 1 || mo > 12 || d < 1) return 0;
  int dm = mo == 2 ? ((y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)) ? 29 : 28) : (mo == 4 || mo == 6 || mo == 9 || mo == 11) ? 30 : 31; if (d > dm) return 0;
  if (l == 10) return 1;
  if (l < 16 || (v[10] != 84 && v[10] != 32) || v[13] != 58) return 0;
  int h = dig(v, 11, 2), mi = dig(v, 14, 2); if (h < 0 || h > 23 || mi < 0 || mi > 59) return 0;
  if (l == 16) return 1;
  if (l < 19 || v[16] != 58) return 0;
  int sc = dig(v, 17, 2); if (sc < 0 || sc > 59) return 0;
  if (l == 19) return 1;
  u32 k = 19; if (v[k] == 46) { k++; u32 k0 = k; while (k < l && v[k] >= 48 && v[k] <= 57) k++; if (k == k0) return 0; }
  return k == l || (k + 1 == l && v[k] == 90);
}

// ---- Date-number mode (parse-research prototype): a column in date mode whose cells are exactly YYYY-MM-DDTHH:MM:SS.mmm (23 bytes, the format the Chicago file uses) writes milliseconds since 1970-01-01 UTC as a Float64 in colA[c]
// (an 8-byte-per-row array, like a number column). Any other cell (empty, other format): build() stops BEFORE the row with bail = 5 and bailcol = the column; JS turns the column back to text.
// Reading back: new Date(ms).toISOString().slice(0, 23) gives the original text for every accepted cell (digits-only fields, valid calendar date, year 1000-9999).
static u8 dtmode[MAXC];
EXPORT("set_datenum") void set_datenum(u32 c, u32 on){ dtmode[c] = (u8)on; }
static int iso_ms(const u8* v, u32 l, double* out){
  if (l != 23 || v[4] != 45 || v[7] != 45 || v[10] != 84 || v[13] != 58 || v[16] != 58 || v[19] != 46) return 0;
  int y = 0, mo = 0, d = 0, h = 0, mi = 0, sc = 0, ms = 0; u32 k;
  for (k = 0; k < 4; k++) { u8 c = v[k]; if (c < 48 || c > 57) return 0; y = y * 10 + (c - 48); }
  for (k = 5; k < 7; k++) { u8 c = v[k]; if (c < 48 || c > 57) return 0; mo = mo * 10 + (c - 48); }
  for (k = 8; k < 10; k++) { u8 c = v[k]; if (c < 48 || c > 57) return 0; d = d * 10 + (c - 48); }
  for (k = 11; k < 13; k++) { u8 c = v[k]; if (c < 48 || c > 57) return 0; h = h * 10 + (c - 48); }
  for (k = 14; k < 16; k++) { u8 c = v[k]; if (c < 48 || c > 57) return 0; mi = mi * 10 + (c - 48); }
  for (k = 17; k < 19; k++) { u8 c = v[k]; if (c < 48 || c > 57) return 0; sc = sc * 10 + (c - 48); }
  for (k = 20; k < 23; k++) { u8 c = v[k]; if (c < 48 || c > 57) return 0; ms = ms * 10 + (c - 48); }
  if (y < 1000 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sc > 59) return 0;
  int dm = mo == 2 ? ((y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)) ? 29 : 28) : (mo == 4 || mo == 6 || mo == 9 || mo == 11) ? 30 : 31; if (d > dm) return 0;
  // days from civil (H. Hinnant)
  int yy = mo <= 2 ? y - 1 : y; int era = yy / 400; int yoe = yy - era * 400; int doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1; int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  long long days = (long long)era * 146097 + doe - 719468;
  *out = (double)(((days * 24 + h) * 60 + mi) * 60 + sc) * 1000.0 + ms; return 1;
}
EXPORT("nlines") u32 nlines(void){ return g_nl; }
static u32 hashb(const u8* p, u32 l){ u32 h = 2166136261u; for (u32 i = 0; i < l; i++) { h ^= p[i]; h *= 16777619u; } return h; }
EXPORT("cache_add") void cache_add(u32 slot, const u8* p, u32 l){
  if (l == 0 || l > DSL) return; u32 h = hashb(p, l) & (DCAP - 1);
  for (u32 k = 0; k < DCAP; k++) { u8* e = dtab[slot][(h + k) & (DCAP - 1)]; if (e[0] == 0) { e[0] = (u8)l; for (u32 q = 0; q < l; q++) e[1 + q] = p[q]; return; } if (e[0] == l) { u32 q = 0; while (q < l && e[1+q] == p[q]) q++; if (q == l) return; } }
}
static u32 hashb2(const u8* p, u32 l){ u32 h = 2166136261u; for (u32 i = 0; i < l; i++) { h ^= p[i]; h *= 16777619u; } return h ^ (h >> 15); }
static int cache_has(u32 slot, const u8* p, u32 l){
  if (l > DSL) return 0; u32 h = hashb(p, l) & (DCAP - 1);
  for (u32 k = 0; k < DCAP; k++) { const u8* e = dtab[slot][(h + k) & (DCAP - 1)]; if (e[0] == 0) return 0; if (e[0] == l) { u32 q = 0; while (q < l && e[1+q] == p[q]) q++; if (q == l) return 1; } }
  return 0;
}
static int is_int(const u8* b, u32 l){   // -?(0|[1-9]\d{0,14})
  u32 p = 0; if (b[0] == 45) p++; if (p >= l) return 0;
  if (b[p] == 48) return p + 1 == l;
  if (b[p] < 49 || b[p] > 57) return 0;
  if (l - p > 15) return 0;
  for (p++; p < l; p++) if (b[p] < 48 || b[p] > 57) return 0;
  return 1;
}
static int plain_int(const u8* b, u32 l){   // typedCell: a whole number stored as a number
  u32 neg = b[0] == 45; if (l <= neg) return 0; u8 c0 = b[neg];
  if (c0 == 48) return l == 1;
  if (c0 < 49 || c0 > 57) return 0;
  if (l - neg > 15) return 0;
  for (u32 p = neg + 1; p < l; p++) if (b[p] < 48 || b[p] > 57) return 0;
  return 1;
}
static int plain_dec(const u8* b, u32 l, u32 d){   // typedDecimal: a plain decimal with exactly d digits after the point, at most 15 digits, not "-0.00"
  u32 neg = b[0] == 45; if (l < neg + d + 2) return 0; u32 dot = l - d - 1;
  if (dot <= neg || b[dot] != 46) return 0;
  if (b[neg] == 48 && dot - neg > 1) return 0;
  if (l - neg - 1 > 15) return 0;
  int nz = 0;
  for (u32 p = neg; p < l; p++) { if (p == dot) continue; u8 c = b[p]; if (c < 48 || c > 57) return 0; if (c != 48) nz = 1; }
  if (neg && !nz) return 0;
  return 1;
}
static int is_num(const u8* b, u32 l){   // -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?
  u32 p = 0, f = l; if (b[p] == 45) p++; if (p >= f) return 0;
  if (b[p] == 48) p++; else if (b[p] >= 49 && b[p] <= 57) { p++; while (p < f && b[p] >= 48 && b[p] <= 57) p++; } else return 0;
  if (p < f && b[p] == 46) { p++; u32 q = p; while (p < f && b[p] >= 48 && b[p] <= 57) p++; if (p == q) return 0; }
  if (p < f && (b[p] == 101 || b[p] == 69)) { p++; if (p < f && (b[p] == 43 || b[p] == 45)) p++; u32 q = p; while (p < f && b[p] >= 48 && b[p] <= 57) p++; if (p == q) return 0; }
  return p == f;
}
typedef double f64;
static int is_bool(const u8* b, u32 l){
  if (l == 4) return (b[0]|32)=='t' && (b[1]|32)=='r' && (b[2]|32)=='u' && (b[3]|32)=='e';
  if (l == 5) return (b[0]|32)=='f' && (b[1]|32)=='a' && (b[2]|32)=='l' && (b[3]|32)=='s' && (b[4]|32)=='e';
  return 0;
}
// A line with bytes above 127 is copied as bytes only when it is valid UTF-8 (the character parser would turn bad bytes into U+FFFD).
static int utf8_ok(const u8* p, u32 l){
  u32 i = 0;
  while (i < l) {
    u8 c = p[i];
    if (c < 0x80) { i++; continue; }
    u32 n; u32 minv; u32 cp;
    if ((c & 0xE0) == 0xC0) { n = 1; cp = c & 0x1F; minv = 0x80; }
    else if ((c & 0xF0) == 0xE0) { n = 2; cp = c & 0x0F; minv = 0x800; }
    else if ((c & 0xF8) == 0xF0) { n = 3; cp = c & 0x07; minv = 0x10000; }
    else return 0;
    for (u32 k = 1; k <= n; k++) { if (i + k >= l) return 0; u8 d = p[i + k]; if ((d & 0xC0) != 0x80) return 0; cp = (cp << 6) | (d & 0x3F); }
    if (cp < minv || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return 0;
    i += n + 1;
  }
  return 1;
}
EXPORT("build") u32 build(const u8* in, u32 len, u32 cap){
  u32 i = 0, nrows = 0; g_bail = 0; g_nl = 0;
  u32 n = ncols; u8 D0 = D;
  for (u32 c = 0; c < n; c++) { cnt_n[c] = 0; cnt_e[c] = 0; }
  while (i < len) {
    u32 fs[MAXC], fe[MAXC]; u8 fq[MAXC], esc[MAXC]; u32 col = 0, p = i; fs[0] = i; fq[0] = 0; esc[0] = 0; int ok = 1, inq = 0, hi8 = 0; u32 e = len + 1, nl = 0, qend = 0, skipq = 0xffffffffu;
    {
      v128_t vd = wasm_i8x16_splat((int8_t)D0), vnl = wasm_i8x16_splat(10), vq = wasm_i8x16_splat(34), vbs = wasm_i8x16_splat(92), v31 = wasm_i8x16_splat(31), v126 = wasm_i8x16_splat(126);
      int done = 0;
      for (; p < len && !done; p += 16) {
        v128_t v = wasm_v128_load(in + p);
        v128_t hit = wasm_v128_or(wasm_v128_or(wasm_i8x16_eq(v, vd), wasm_i8x16_eq(v, vq)), wasm_v128_or(wasm_i8x16_eq(v, vbs), wasm_v128_or(wasm_u8x16_le(v, v31), wasm_u8x16_gt(v, v126))));
        u32 m = (u32)wasm_i8x16_bitmask(hit);
        while (m) {
          u32 q = p + (u32)__builtin_ctz(m); m &= m - 1;
          if (q >= len) { done = 1; break; }
          if (q == skipq) continue;   // the second quote of an empty quoted cell
          u8 c = in[q];
          if (c == 92) { ok = 0; done = 1; break; }   // backslash stays with the character parser
          if (c > 126) { hi8 = 1; continue; }   // non-ASCII: the whole line is checked as UTF-8 below (invalid bytes stay with the character parser, which replaces them)
          if (inq) {
            if (c == 34) {   // inside a quoted field: a quote is either an escaped quote ("" -> the line goes to the character parser) or the closing quote
              if (q + 1 >= len) { done = 1; break; }   // cannot tell yet: wait for more bytes
              u8 nb = in[q + 1];
              if (nb == 34) { esc[col] = 1; skipq = q + 1; continue; }   // an escaped quote (""): the cell is unescaped in place below
              if (nb != D0 && nb != 10 && !(nb == 13 && q + 2 < len && in[q + 2] == 10)) { if (q + 2 >= len && nb == 13) { done = 1; break; } ok = 0; done = 1; break; }
              inq = 0; fe[col] = q; qend = 1;
            } else if (c == 10) nl++;   // a line break inside quotes is part of the cell
            continue;   // a delimiter, tab or other control character inside quotes is cell text
          }
          if (c == 34) {
            if (q != fs[col] || fq[col]) { ok = 0; done = 1; break; }
            if (q + 2 < len && in[q + 1] == 34) { u8 a = in[q + 2]; if (a == D0 || a == 10 || (a == 13 && q + 3 < len && in[q + 2 + 1] == 10)) { fq[col] = 1; fs[col] = fe[col] = q + 1; skipq = q + 1; continue; } }   // "" followed by a delimiter or line end: an empty quoted cell
            inq = 1; fq[col] = 1; fs[col] = q + 1; continue;
          }   // an opening quote must start the cell
          if (c == D0) { if (col + 1 >= n) { ok = 0; done = 1; break; } if (!fq[col]) fe[col] = q; col++; fs[col] = q + 1; fq[col] = 0; esc[col] = 0; }
          else if (c == 10) { e = q; nl++; done = 1; break; }
          else if (c == 13 && q + 1 < len && in[q + 1] == 10) continue;   // CRLF: the line break comes next
          else { ok = 0; done = 1; break; }
        }
      }
    }
    if (!ok) { g_bail = 1; break; }
    if (e > len) break;
    u32 end = e; if (end > i && in[end-1] == 13) end--;
    if (col != n - 1 || end == i) { g_bail = 1; break; }
    if (!fq[n-1]) fe[n-1] = end;
    (void)qend;
    if (hi8 && !utf8_ok(in + i, end - i)) { g_bail = 1; break; }
    for (u32 c = 0; c < n; c++) if (esc[c]) { u32 w = fs[c], r = fs[c], z = fe[c]; while (r < z) { u8 ch = in[r++]; ((u8*)in)[w++] = ch; if (ch == 34) r++; } fe[c] = w; }
    if (nrows >= cap) break;
    // check every cell against the type flags before writing anything for the row
    for (u32 c = 0; c < n; c++) {
      u32 s0 = fs[c], l = fe[c] - s0; if (l == 0) continue;
      u8 f = flags[c]; if (!f) continue;
      const u8* v = in + s0; u8 nf = 0;
      int ii = 0, isn = 0;
      if (f & 3) { ii = is_int(v, l); if (f & 1) { if (ii) nf |= 1; } if (f & 2) { isn = ii ? 1 : is_num(v, l); if (isn) nf |= 2; } }
      if ((f & 4) && is_bool(v, l)) nf |= 4;
      if ((f & 8) && (date_ok(v, l) || (dslot[c] != 255 && cache_has(dslot[c], v, l)))) nf |= 8;
      if (nf != f) { g_bail = 1; goto stop; }
    }
    // the number cells must read back as numbers (a text-like cell in a number column cannot live in a Float64 column)
    for (u32 c = 0; c < n; c++) {
      u8 pl = isplan[c]; if (!pl) continue;
      u32 s0 = fs[c], l = fe[c] - s0; if (l == 0) continue;
      if (pl == 1 ? !plain_int(in + s0, l) : !plain_dec(in + s0, l, pl - 16)) { g_bail = 2; goto stop; }
    }
    double dnum[MAXC];
    for (u32 c = 0; c < n; c++) if (dtmode[c] && !isplan[c]) { if (!iso_ms(in + fs[c], fe[c] - fs[c], &dnum[c])) { g_bail = 5; g_bailcol = c; goto stop; } }
    u32 dcode[MAXC];
    for (u32 c = 0; c < n; c++) if (dmode[c] && !isplan[c]) { if (!dict_code(c, in + fs[c], fe[c] - fs[c], &dcode[c])) { g_bail = 4; g_bailcol = c; goto stop; } }
    for (u32 c = 0; c < n; c++) {
      u32 s0 = fs[c], f0 = fe[c], l = f0 - s0; cnt_n[c]++; if (l == 0) cnt_e[c]++;
      u8 pl = isplan[c];
      if (!pl && dtmode[c]) { ((double*)colA[c])[nrows] = dnum[c]; continue; }
      if (!pl && dmode[c]) { ((unsigned short*)colA[c])[nrows] = (unsigned short)dcode[c]; continue; }
      if (!pl) { u32 t = tlen[c]; u8* tb = colT[c]; for (u32 q = 0; q < l; q++) tb[t + q] = in[s0 + q]; ((u32*)colA[c])[nrows] = t; t += l; ((u32*)colB[c])[nrows] = t; tlen[c] = t; continue; }
      f64 v;
      if (l == 0) v = __builtin_nan("");
      else {
        u32 neg = in[s0] == 45, dd = pl == 1 ? 0 : pl - 16; u64 m = 0;
        for (u32 q = s0 + neg; q < f0; q++) { u8 ch = in[q]; if (ch == 46) continue; m = m * 10 + (ch - 48); }
        (void)dd; v = (f64)m; if (neg) v = -v;
      }
      ((f64*)colA[c])[nrows] = v;
    }
    nrows++; g_nl += nl; i = e + 1;
  }
stop:
  g_rows = nrows; return i;
}
