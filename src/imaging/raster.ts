/**
 * 光栅基础：ImageData ↔ 灰度/二值矩阵、直方图、旋转/缩放、连通域标记。
 * 纯 JS + Uint8Array，无 React 依赖，可在 Worker 与主线程复用。
 *
 * 约定：二值矩阵 Uint8Array，1 = 墨迹（黑），0 = 背景（白）。
 * （实现说明：架构文档备注「1bpp 打包」，实际采用未打包 0/1 矩阵以换取
 *  算法实现的可读性与可靠性，单页约 6MB，在内存预算内。）
 */

/** ImageData → 灰度（Rec.601 亮度） */
export function toGray(image: ImageData): Uint8Array {
  const { data, width, height } = image;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return gray;
}

export function grayToImageData(gray: Uint8Array, width: number, height: number): ImageData {
  const out = new ImageData(width, height);
  const d = out.data;
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    const v = gray[j];
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  return out;
}

export function binaryToImageData(bin: Uint8Array, width: number, height: number): ImageData {
  const out = new ImageData(width, height);
  const d = out.data;
  for (let i = 0, j = 0; j < bin.length; i += 4, j++) {
    const v = bin[j] ? 0 : 255;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  return out;
}

export function histogram(gray: Uint8Array): Uint32Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  return hist;
}

/** 双线性缩放灰度图（DPI 归一用） */
export function resizeGray(gray: Uint8Array, width: number, height: number, scale: number): {
  data: Uint8Array;
  width: number;
  height: number;
} {
  if (Math.abs(scale - 1) < 1e-6) return { data: gray, width, height };
  const nw = Math.max(1, Math.round(width * scale));
  const nh = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(height - 1, y / scale);
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(width - 1, x / scale);
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      const v00 = gray[y0 * width + x0];
      const v10 = gray[y0 * width + x1];
      const v01 = gray[y1 * width + x0];
      const v11 = gray[y1 * width + x1];
      out[y * nw + x] =
        v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
    }
  }
  return { data: out, width: nw, height: nh };
}

/** 最近邻旋转二值图（绕中心，背景填 0/白，保持原尺寸） */
export function rotateBinaryNearest(bin: Uint8Array, width: number, height: number, deg: number): Uint8Array {
  if (Math.abs(deg) < 1e-6) return bin;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      // 逆变换取样
      const sx = Math.round(dx * cos + dy * sin + cx);
      const sy = Math.round(-dx * sin + dy * cos + cy);
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
        out[y * width + x] = bin[sy * width + sx];
      }
    }
  }
  return out;
}

/** 裁剪二值图（带 padding，越界自动截断） */
export function cropBinary(
  bin: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): { data: Uint8Array; width: number; height: number } {
  const cx0 = Math.max(0, Math.floor(x0));
  const cy0 = Math.max(0, Math.floor(y0));
  const cx1 = Math.min(width, Math.ceil(x0 + w));
  const cy1 = Math.min(height, Math.ceil(y0 + h));
  const cw = Math.max(0, cx1 - cx0);
  const ch = Math.max(0, cy1 - cy0);
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    out.set(bin.subarray((cy0 + y) * width + cx0, (cy0 + y) * width + cx0 + cw), y * cw);
  }
  return { data: out, width: cw, height: ch };
}

export interface ComponentBox {
  label: number;
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
}

/**
 * 连通域标记（8 连通，两遍法 + 并查集）。
 * 返回标签矩阵与每个连通域的包围盒/面积。
 */
export function connectedComponents(
  bin: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; boxes: ComponentBox[] } {
  const labels = new Int32Array(width * height);
  const parent: number[] = [0]; // 并查集，0 = 背景
  let nextLabel = 1;

  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root];
    // 路径压缩
    while (parent[a] !== root) {
      const p = parent[a];
      parent[a] = root;
      a = p;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const newLabel = (): number => {
    parent.push(parent.length);
    return nextLabel++;
  };

  // 第一遍：临时标签
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!bin[idx]) continue;
      const neighbors: number[] = [];
      if (x > 0 && labels[idx - 1]) neighbors.push(labels[idx - 1]);
      if (y > 0) {
        if (labels[idx - width]) neighbors.push(labels[idx - width]);
        if (x > 0 && labels[idx - width - 1]) neighbors.push(labels[idx - width - 1]);
        if (x < width - 1 && labels[idx - width + 1]) neighbors.push(labels[idx - width + 1]);
      }
      if (neighbors.length === 0) {
        labels[idx] = newLabel();
      } else {
        let min = neighbors[0];
        for (const n of neighbors) {
          const r = find(n);
          if (r < min) min = r;
        }
        labels[idx] = min;
        for (const n of neighbors) union(min, n);
      }
    }
  }

  // 第二遍：归一并统计包围盒
  const stat = new Map<number, ComponentBox>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!labels[idx]) continue;
      const root = find(labels[idx]);
      labels[idx] = root;
      let box = stat.get(root);
      if (!box) {
        box = { label: root, x, y, w: 1, h: 1, area: 1 };
        stat.set(root, box);
      } else {
        if (x < box.x) {
          box.w += box.x - x;
          box.x = x;
        }
        if (y < box.y) {
          box.h += box.y - y;
          box.y = y;
        }
        if (x >= box.x + box.w) box.w = x - box.x + 1;
        if (y >= box.y + box.h) box.h = y - box.y + 1;
        box.area++;
      }
    }
  }
  return { labels, boxes: [...stat.values()] };
}
