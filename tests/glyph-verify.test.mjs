import { check, eq, approx, section, summary } from './helpers.mjs';
import {
  normalizeGlyphBitmap,
  bitmapIoU,
  bitmapChamferNorm,
  projectionCorrelation,
  scoreGlyphMatch,
  expandGlyphCandidates,
  GLYPH_NORMALIZE_SIZE,
} from '../src/recognize/glyphVerify.ts';

function solidBlock(size, x0, y0, w, h) {
  const data = new Uint8Array(size * size);
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) data[y * size + x] = 1;
  }
  return data;
}

section('归一化位图');
const raw = solidBlock(32, 8, 4, 16, 24);
const norm = normalizeGlyphBitmap(raw, 32, 32);
eq('归一化输出 64×64', norm.length, GLYPH_NORMALIZE_SIZE * GLYPH_NORMALIZE_SIZE);
check('归一化后仍有墨迹', norm.some((v) => v === 1));

section('IoU 与倒角');
const a = solidBlock(64, 20, 10, 24, 40);
const b = solidBlock(64, 22, 12, 24, 40);
approx('相同形状 IoU 较高', bitmapIoU(a, b), 0.75, 0.05);
approx('投影相关较高', projectionCorrelation(a, b, 64), 0.85, 0.05);
approx('倒角距离小', bitmapChamferNorm(a, b, 64), 0, 0.15);
approx('相同形状得分较高', scoreGlyphMatch(a, b), 0.85, 0.05);
const c = solidBlock(64, 10, 10, 10, 10);
check('差异形状得分低于相同形状', scoreGlyphMatch(a, c) < scoreGlyphMatch(a, b));

section('形近字候选扩展');
const expanded = expandGlyphCandidates('遷', []);
check('混淆组扩展含形近字', expanded.includes('遞') || expanded.includes('邁'));

summary('glyph-verify');
