// Staged columns builder (CREDITS: column-at-a-time CSV reading as in Apache Arrow / DuckDB, see docs/CREDITS.md). Same scan and type-flag rules as the row builder (rb3.c),
// but the cells are written to typed columns instead of JSON text. g_bail: 1 = a line or a type-flag change JS must handle, 2 = a cell that stays text in a number column (mixed).
#include <wasm_simd128.h>
typedef unsigned char u8; typedef unsigned int u32; typedef unsigned long long u64;
#define EXPORT(n) __attribute__((export_name(n)))
#define MAXC 64
#define DSL 40
#define DCAP 4096
#define DSLOTS 8
static u8 keybuf[8192]; static u32 keyoff[MAXC], keylen[MAXC];
static u8 isplan[MAXC], flags[MAXC], dslot[MAXC];
static u32 cnt_n[MAXC], cnt_e[MAXC];
static u32 ncols, extra; static u8 D;
static u8 dtab[DSLOTS][DCAP][DSL + 1];   // len byte then bytes; len 0 = empty slot
static u32 g_out, g_rows, g_bail;
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
static u32 hashb(const u8* p, u32 l){ u32 h = 2166136261u; for (u32 i = 0; i < l; i++) { h ^= p[i]; h *= 16777619u; } return h; }
EXPORT("cache_add") void cache_add(u32 slot, const u8* p, u32 l){
  if (l == 0 || l > DSL) return; u32 h = hashb(p, l) & (DCAP - 1);
  for (u32 k = 0; k < DCAP; k++) { u8* e = dtab[slot][(h + k) & (DCAP - 1)]; if (e[0] == 0) { e[0] = (u8)l; for (u32 q = 0; q < l; q++) e[1 + q] = p[q]; return; } if (e[0] == l) { u32 q = 0; while (q < l && e[1+q] == p[q]) q++; if (q == l) return; } }
}
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
EXPORT("build") u32 build(const u8* in, u32 len, u32 cap){
  u32 i = 0, nrows = 0; g_bail = 0;
  u32 n = ncols; u8 D0 = D;
  for (u32 c = 0; c < n; c++) { cnt_n[c] = 0; cnt_e[c] = 0; }
  while (i < len) {
    u32 fs[MAXC], fe[MAXC]; u32 col = 0, p = i; fs[0] = i; int ok = 1; u32 e = len + 1;
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
          u8 c = in[q];
          if (c == D0) { if (col + 1 >= n) { ok = 0; done = 1; break; } fe[col] = q; col++; fs[col] = q + 1; }
          else if (c == 10) { e = q; done = 1; break; }
          else { ok = 0; done = 1; break; }
        }
      }
    }
    if (!ok) { g_bail = 1; break; }
    if (e > len) break;
    u32 end = e; if (end > i && in[end-1] == 13) end--;
    if (col != n - 1 || end == i) { g_bail = 1; break; }
    fe[n-1] = end;
    if (nrows >= cap) break;
    // check every cell against the type flags before writing anything for the row
    for (u32 c = 0; c < n; c++) {
      u32 s0 = fs[c], l = fe[c] - s0; if (l == 0) continue;
      u8 f = flags[c]; if (!f) continue;
      const u8* v = in + s0; u8 nf = 0;
      int ii = 0, isn = 0;
      if (f & 3) { ii = is_int(v, l); if (f & 1) { if (ii) nf |= 1; } if (f & 2) { isn = ii ? 1 : is_num(v, l); if (isn) nf |= 2; } }
      if ((f & 4) && is_bool(v, l)) nf |= 4;
      if ((f & 8) && dslot[c] != 255 && cache_has(dslot[c], v, l)) nf |= 8;
      if (nf != f) { g_bail = 1; goto stop; }
    }
    // the number cells must read back as numbers (a text-like cell in a number column cannot live in a Float64 column)
    for (u32 c = 0; c < n; c++) {
      u8 pl = isplan[c]; if (!pl) continue;
      u32 s0 = fs[c], l = fe[c] - s0; if (l == 0) continue;
      if (pl == 1 ? !plain_int(in + s0, l) : !plain_dec(in + s0, l, pl - 16)) { g_bail = 2; goto stop; }
    }
    for (u32 c = 0; c < n; c++) {
      u32 s0 = fs[c], f0 = fe[c], l = f0 - s0; cnt_n[c]++; if (l == 0) cnt_e[c]++;
      u8 pl = isplan[c];
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
    nrows++; i = e + 1;
  }
stop:
  g_rows = nrows; return i;
}
