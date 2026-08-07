/**
 * segment/grid.ts：拼图分批 ≤100、编号打乱后 id 映射可逆、批哈希稳定。
 * Node 无 DOM，用最小 OffscreenCanvas mock 满足画布依赖（只验证数据逻辑，不验证像素）。
 */

// ---- 最小 Canvas mock（buildGridBatch 只用到这些 API） ----
class FakeImageData {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
}
class FakeCtx {
  constructor(canvas) { this.canvas = canvas; this.fillStyle = ''; this.font = ''; this.textBaseline = ''; }
  fillRect() {}
  fillText() {}
  createImageData(w, h) { return new FakeImageData(w, h); }
  putImageData() {}
}
class FakeOffscreenCanvas {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return new FakeCtx(this); }
  async convertToBlob() { return new Blob(new Uint8Array([1, 2, 3]), { type: 'image/png' }); }
}
globalThis.OffscreenCanvas = FakeOffscreenCanvas;

const { buildGridBatch, buildAllGrids, hashBatch } = await import('../src/segment/grid.ts');
const { GRID_BATCH_SIZE, GRID_COLS } = await import('../src/lib/constants.ts');
const { check, eq, section, summary } = await import('./helpers.mjs');

section('常量契约');
eq('每批上限 64', GRID_BATCH_SIZE, 64);
eq('网格列数 8', GRID_COLS, 8);

const mkChars = (n) => Array.from({ length: n }, (_, i) => ({
  id: `c${i}`, text: null, cx: 100 + i, cy: 100, bbox: [100 + i * 20, 100, 118 + i * 20, 140],
  pt: 0, conf: 0, note: 'ok', source: 'llm', edited: false, group: 'body', kind: 'text',
}));

// 页内二值图：足够大，让所有 bbox 都在范围内
const W = 6000, H = 400;
const bin = new Uint8Array(W * H);
for (let i = 0; i < bin.length; i += 7) bin[i] = 1; // 撒点墨迹

section('单批：编号打乱 + id 映射可逆');
const n = 37;
const chars = mkChars(n);
const batch = await buildGridBatch(chars, bin, W, H, 0);
eq('ids 长度 = 字符数', batch.ids.length, n);
const sorted = [...batch.ids].sort((a, b) => a - b);
check('ids 是 0..n-1 的置换（可逆映射）', sorted.every((v, i) => v === i));
check('每个显示编号唯一', new Set(batch.ids).size === n);
// 可逆性：显示编号 d → chars[ids[d]]，反查 chars 下标 i → 显示编号 ids.indexOf(i)，一一对应
const inverseOk = chars.every((_, i) => batch.ids[batch.ids.indexOf(i)] === i);
check('正反映射双射一致', inverseOk);
check('返回 base64 PNG', typeof batch.imageBase64Png === 'string' && batch.imageBase64Png.length > 0);
eq('batchIndex 透传', batch.batchIndex, 0);

// 多跑几次，至少出现一次与顺序不同的打乱（随机性冒烟；理论上可能偶然全同序，概率极低）
let sawShuffled = false;
for (let t = 0; t < 5; t++) {
  const b = await buildGridBatch(chars, bin, W, H, 0);
  if (b.ids.some((v, i) => v !== i)) { sawShuffled = true; break; }
}
check('编号确实被打乱（5 次内至少 1 次非顺序）', sawShuffled);

section('分批：250 字 → 4 批，每批 ≤64');
const all = mkChars(250);
const batches = await buildAllGrids(all, bin, W, H);
eq('250 字分 4 批', batches.length, 4);
check('每批 ≤64', batches.every((b) => b.ids.length <= GRID_BATCH_SIZE));
eq('各批 64/64/64/58', batches.map((b) => b.ids.length).join(','), '64,64,64,58');
check('批内 ids 仍是合法置换', batches.every((b) => {
  const s = [...b.ids].sort((x, y) => x - y);
  return s.every((v, i) => v === i);
}));
eq('batchIndex 递增', batches.map((b) => b.batchIndex).join(','), '0,1,2,3');

section('批哈希（缓存键）');
eq('同批同参哈希稳定', hashBatch(chars, 0), hashBatch(chars, 0));
check('不同 batchIndex 哈希不同', hashBatch(chars, 0) !== hashBatch(chars, 1));
const chars2 = mkChars(n);
chars2[0].bbox = [0, 0, 10, 10];
check('bbox 变化哈希不同', hashBatch(chars, 0) !== hashBatch(chars2, 0));

summary('grid');
