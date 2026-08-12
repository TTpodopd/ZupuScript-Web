import { eq, check, section, summary } from './helpers.mjs';
import { resolveFixedBookTitle, FIXED_BOOK_TITLE } from '../src/recognize/fixedTitle.ts';

function mkChar(id, cx, cy, w = 30, h = 34) {
  return { id, text: null, cx, cy, bbox: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'title', kind: 'side' };
}

section('standard title');
const width = 1000;
const chars = [mkChar('t1', 60, 100), mkChar('t2', 60, 150), mkChar('t3', 60, 200), mkChar('t4', 60, 250)];
const hit = resolveFixedBookTitle(chars, width);
eq('four title boxes', hit.assignments.size, 4);
eq('fixed title order', chars.map((c) => hit.assignments.get(c.id)).join(''), FIXED_BOOK_TITLE);

section('decoration and page number remain');
const withDecor = [...chars, mkChar('decor', 60, 330, 34, 40), mkChar('p1', 60, 700, 14, 16)];
const hit2 = resolveFixedBookTitle(withDecor, width);
eq('still four title boxes', hit2.assignments.size, 4);
check('only title ids consumed', hit2.consumedIds.has('t1') && !hit2.consumedIds.has('decor') && !hit2.consumedIds.has('p1'));

section('fragment merge');
const fragmented = [mkChar('f1a', 60, 92, 28, 20), mkChar('f1b', 60, 108, 28, 18), mkChar('f2', 60, 150), mkChar('f3', 60, 200), mkChar('f4', 60, 250)];
const hit3 = resolveFixedBookTitle(fragmented, width);
eq('fragment merged', hit3.assignments.size, 4);
eq('first fragment is title', hit3.assignments.get('f1a'), '倪');
check('second fragment consumed', hit3.consumedIds.has('f1b') && !hit3.assignments.has('f1b'));

section('invalid layouts');
const offCol = [mkChar('a', 60, 100), mkChar('b', 140, 150), mkChar('c', 60, 200), mkChar('d', 60, 250)];
eq('different column rejected', resolveFixedBookTitle(offCol, width).assignments.size, 0);
const oddSize = [mkChar('a', 60, 100), mkChar('b', 60, 150), mkChar('c', 60, 200, 30, 80), mkChar('d', 60, 260)];
eq('odd size rejected', resolveFixedBookTitle(oddSize, width).assignments.size, 0);
eq('too few rejected', resolveFixedBookTitle(chars.slice(0, 3), width).assignments.size, 0);

summary('fixed title');