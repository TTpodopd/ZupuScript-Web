import { check, eq, section, summary } from './helpers.mjs';
import { detectRects, detectTreeLines } from '../src/layout/detect.ts';
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
eq('厚实心边条只保留一个矩形', rects.borderRects.length, 1);

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

summary('layout detect');
