/**
 * 位图存取（L2 层）：优先 OPFS；Safari 等 OPFS 受限环境自动降级为 IndexedDB Blob。
 * 原图副本、预处理结果、预览图存这里，用户手动清理前一直保留。
 */
import { OPFS_IMAGE_DIR } from '@/lib/constants';
import { deleteBlob, getBlob, putBlob } from './db';

/** 检测 OPFS 可用性（同步启发式 + 运行时兜底降级） */
export function hasOPFS(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    typeof (navigator.storage as { getDirectory?: unknown }).getDirectory === 'function'
  );
}

async function getImageDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_IMAGE_DIR, { create: true });
}

/** 写入位图（自动选择 OPFS 或 idb 降级） */
export async function putImage(key: string, blob: Blob): Promise<void> {
  if (hasOPFS()) {
    try {
      const dir = await getImageDir();
      const fh = await dir.getFileHandle(key, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch {
      // OPFS 写入失败（配额/权限）→ 降级 idb
    }
  }
  await putBlob(key, blob);
}

export async function getImage(key: string): Promise<Blob | null> {
  if (!key) return null;
  if (hasOPFS()) {
    try {
      const dir = await getImageDir();
      const fh = await dir.getFileHandle(key);
      return await fh.getFile();
    } catch {
      // 继续尝试 idb
    }
  }
  const blob = await getBlob(key);
  return blob ?? null;
}

export async function deleteImage(key: string): Promise<void> {
  if (!key) return;
  if (hasOPFS()) {
    try {
      const dir = await getImageDir();
      await dir.removeEntry(key);
    } catch {
      /* 不存在则忽略 */
    }
  }
  await deleteBlob(key).catch(() => undefined);
}

/** 清空全部图像（一键清空本地数据用） */
export async function clearAllImages(): Promise<void> {
  if (hasOPFS()) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(OPFS_IMAGE_DIR, { recursive: true });
    } catch {
      /* 忽略 */
    }
  }
}

/** 将 ImageData / canvas 编码为 PNG Blob 后存储，返回 key */
export async function putCanvasImage(key: string, canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
  let blob: Blob;
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } else {
    const htmlCanvas = canvas as HTMLCanvasElement;
    blob = await new Promise<Blob>((resolve, reject) => {
      htmlCanvas.toBlob((b: Blob | null) => (b ? resolve(b) : reject(new Error('canvas 编码失败'))), 'image/png');
    });
  }
  await putImage(key, blob);
}

/** 读取图像为 ImageBitmap（即用即取即释放，调用方负责 close()） */
export async function getImageBitmap(key: string): Promise<ImageBitmap | null> {
  const blob = await getImage(key);
  if (!blob) return null;
  return createImageBitmap(blob);
}

/** 读取原图为 ImageData（预处理输入；即用即取即释放） */
export async function getPageImageData(imageKey: string): Promise<ImageData | null> {
  const bmp = await getImageBitmap(imageKey);
  if (!bmp) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, bmp.width, bmp.height);
  } finally {
    bmp.close();
  }
}

/** 把二值矩阵编码为 PNG 存入 OPFS（预处理结果持久化） */
export async function putBinaryImage(key: string, bin: Uint8Array, width: number, height: number): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let i = 0, j = 0; j < bin.length; i += 4, j++) {
    const v = bin[j] ? 0 : 255;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  await putCanvasImage(key, canvas);
}

/** 读回二值矩阵（识别/质检用）；不存在返回 null */
export async function getBinaryImage(
  key: string | undefined,
): Promise<{ bin: Uint8Array; width: number; height: number } | null> {
  if (!key) return null;
  const bmp = await getImageBitmap(key);
  if (!bmp) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const bin = new Uint8Array(bmp.width * bmp.height);
    for (let i = 0, j = 0; j < bin.length; i += 4, j++) {
      bin[j] = img.data[i] < 128 ? 1 : 0;
    }
    return { bin, width: bmp.width, height: bmp.height };
  } finally {
    bmp.close();
  }
}
