import { check, eq, section, summary } from './helpers.mjs';
import { refineCharBoxToInk } from '../src/imaging/ink.ts';
import { validateAndRefineCharPositions, scoreCharAlignment } from '../src/verify/alignment.ts';

function mkChar(id, cx, cy, w = 18, h = 18) {
  return {
    id,
    text: null,
    cx,
    cy,
    bbox: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
    pt: 0,
    conf: 0.9,
    note: 'ok',
    source: 'manual',
    edited: false,
    group: 'body',
    kind: 'text',
  };
}

function paintBlock(bin, width, x, y, w, h) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) bin[yy * width + xx] = 1;
  }
}

section('墨迹紧框定位');
const w = 200;
const h = 200;
const bin = new Uint8Array(w * h);
paintBlock(bin, w, 94, 48, 12, 16);
const loose = mkChar('a', 110, 60, 40, 40);
const tight = refineCharBoxToInk(loose, bin, w, h);
check('紧框 cx 贴近墨迹', Math.abs(tight.cx - 100) < 2);
check('紧框 cy 贴近墨迹', Math.abs(tight.cy - 56) < 2);

section('原图对齐评分');
const score = scoreCharAlignment(tight, bin, w, h);
check('对齐通过', score.aligned === true);

section('批量校验');
paintBlock(bin, w, 140, 48, 12, 16);
const chars = [tight, mkChar('b', 160, 60, 40, 40)];
const validated = validateAndRefineCharPositions(chars, bin, w, h);
eq('校验后字数不变', validated.chars.length, 2);
check('对齐统计', validated.stats.aligned >= 1);

summary('alignment');
