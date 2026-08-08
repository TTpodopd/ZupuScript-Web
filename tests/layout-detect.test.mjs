import { check, eq, section, summary } from './helpers.mjs';
import { detectRects, detectTreeLines } from '../src/layout/detect.ts';
import { isSolidGraphicBlock, isTextLikeBlock } from '../src/layout/graphicBlock.ts';
import { detectNodes } from '../src/layout/nodes.ts';

function block(bin, width, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) bin[yy * width + xx] = 1;
  }
}

section('细谱系线与实心边条分流');
const width = 400;
const height = 300;
const bin = new Uint8Array(width * height);
block(bin, width, 20, 50, 360, 3);
block(bin, width, 20, 180, 360, 90);

const rects = detectRects(bin, width, height);
eq('细横线不进入边框矩形', rects.borderRects.filter((rect) => rect.y < 100).length, 0);
eq('厚实心装饰块归入 tagRects', rects.tagRects.length, 1);
eq('页框矩形不为正文区横条', rects.borderRects.filter((rect) => rect.y > 100).length, 0);

const lines = detectTreeLines(bin, width, height, rects.rectMask);
check('细横线进入谱系线集合', lines.some((line) => line.orientation === 'h' && Math.abs(line.y1 - 51.5) < 3));
check('实心边条被掩码排除', !lines.some((line) => line.y1 > 170));

section('竖线端点空心圆');
const nodeWidth = 180;
const nodeHeight = 180;
const nodeBin = new Uint8Array(nodeWidth * nodeHeight);
const nodeCx = 90;
const nodeCy = 125;
const nodeRadius = 9;
for (let y = 0; y < nodeHeight; y += 1) {
  for (let x = 0; x < nodeWidth; x += 1) {
    const distance = Math.hypot(x - nodeCx, y - nodeCy);
    if (distance >= nodeRadius - 1.5 && distance <= nodeRadius + 1.5) nodeBin[y * nodeWidth + x] = 1;
  }
}
block(nodeBin, nodeWidth, nodeCx - 1, 60, 3, 57);
const nodes = detectNodes(nodeBin, nodeWidth, nodeHeight, [
  { id: 'line', x1: nodeCx, y1: 60, x2: nodeCx, y2: 116, widthPx: 3, orientation: 'v' },
]);
check('与竖线相连的圆圈仍能检测', nodes.some((node) => Math.hypot(node.cx - nodeCx, node.cy - nodeCy) <= 4));
eq('一个自由端点最多生成一个圆圈', nodes.length, 1);

const junctionBin = new Uint8Array(nodeWidth * nodeHeight);
block(junctionBin, nodeWidth, 20, 70, 140, 3);
block(junctionBin, nodeWidth, nodeCx - 1, 70, 3, 55);
const junctionNodes = detectNodes(junctionBin, nodeWidth, nodeHeight, [
  { id: 'horizontal', x1: 20, y1: 71.5, x2: 160, y2: 71.5, widthPx: 3, orientation: 'h' },
  { id: 'vertical', x1: nodeCx, y1: 71.5, x2: nodeCx, y2: 125, widthPx: 3, orientation: 'v' },
]);
eq('横竖线交叉点不会生成假圆圈', junctionNodes.length, 0);

section('PDF 矢量细页框');
const pdfW = 800;
const pdfH = 1100;
const pdfBin = new Uint8Array(pdfW * pdfH);
block(pdfBin, pdfW, 0, 0, pdfW, 4);
block(pdfBin, pdfW, 0, 0, 4, pdfH);
block(pdfBin, pdfW, pdfW - 4, 0, 4, pdfH);
block(pdfBin, pdfW, 0, pdfH - 4, pdfW, 4);
const pdfRects = detectRects(pdfBin, pdfW, pdfH);
check('页边 4px 细框可被检出', pdfRects.borderRects.length >= 1);
check('不会把整页误判为实心黑块', pdfRects.borderRects.every((r) => r.w * r.h < pdfW * pdfH * 0.12));

section('扫描件厚页框（内缩白边）');
const scanW = 2400;
const scanH = 3200;
const scanBin = new Uint8Array(scanW * scanH);
const frameX = 120;
const frameY = 80;
const frameW = 2000;
const frameH = 3000;
const thick = 48;
block(scanBin, scanW, frameX, frameY, frameW, thick);
block(scanBin, scanW, frameX, frameY + frameH - thick, frameW, thick);
block(scanBin, scanW, frameX, frameY, thick, frameH);
block(scanBin, scanW, frameX + frameW - thick, frameY, thick, frameH);
const scanRects = detectRects(scanBin, scanW, scanH);
check('厚页框四边均可检出', scanRects.borderRects.length >= 4);
check('厚页框不会整页涂黑', scanRects.borderRects.every((r) => r.w * r.h < scanW * scanH * 0.12));

section('正文竖列不应被误判为边框');
const colW = 800;
const colH = 1100;
const colBin = new Uint8Array(colW * colH);
for (let col = 0; col < 5; col += 1) {
  const x = 80 + col * 120;
  for (let row = 0; row < 40; row += 1) {
    block(colBin, colW, x, 120 + row * 22, 18, 18);
  }
}
block(colBin, colW, 0, 0, colW, 4);
block(colBin, colW, 0, 0, 4, colH);
const colRects = detectRects(colBin, colW, colH);
check('竖排正文列不进入边框', colRects.borderRects.every((r) => Math.min(r.w, r.h) <= 12));

section('空白页边噪声不应生成竖条');
const marginW = 800;
const marginH = 1100;
const marginBin = new Uint8Array(marginW * marginH);
block(marginBin, marginW, 0, 0, marginW, 4);
block(marginBin, marginW, 0, 0, 4, marginH);
block(marginBin, marginW, 0, marginH - 4, marginW, 4);
block(marginBin, marginW, marginW - 30, 40, 2, 2);
block(marginBin, marginW, marginW - 28, marginH - 60, 2, 2);
const marginRects = detectRects(marginBin, marginW, marginH);
check('右侧空白仅噪声时不生成竖条', !marginRects.borderRects.some((r) => r.x > marginW * 0.9 && r.h > marginH * 0.5));

section('装饰块与文字分流');
const textColBin = new Uint8Array(120 * 400);
for (let i = 0; i < 8; i += 1) block(textColBin, 120, 40, 30 + i * 42, 36, 32);
const solidBin = new Uint8Array(120 * 400);
block(solidBin, 120, 35, 40, 50, 180);
check('竖排文字列不应判为装饰块', isTextLikeBlock(textColBin, 120, 400, { x: 30, y: 20, w: 60, h: 360 }));
check('实心书标块应判为装饰图形', isSolidGraphicBlock(solidBin, 120, 400, { x: 30, y: 35, w: 55, h: 190 }));

summary('layout detect pdf');
