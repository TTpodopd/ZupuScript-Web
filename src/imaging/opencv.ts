/**
 * OpenCV.js 懒加载封装（F2.6，可选增强）。
 * - 首屏零阻塞：仅在用户开启「高精度模式」时动态 import；
 * - 接口与 preprocess/detect 的纯 JS 实现对齐，任一增强失败一律返回 null，
 *   由调用方回退到纯 JS 实现，绝不影响主流程。
 */

/** OpenCV.js 运行时最小类型（只声明用到的表面，避免引入完整类型包） */
interface CvMat {
  rows: number;
  cols: number;
  delete: () => void;
}
interface CvRuntime {
  matFromImageData: (imageData: ImageData) => CvMat;
  minAreaRect?: (...args: unknown[]) => { angle: number };
  [key: string]: unknown;
}

let cvPromise: Promise<CvRuntime | null> | null = null;

const OPENCV_INIT_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** 懒加载 OpenCV.js；加载失败或超时返回 null（调用方回退纯 JS） */
export function loadOpenCV(): Promise<CvRuntime | null> {
  if (!cvPromise) {
    cvPromise = (async () => {
      try {
        const mod = (await import('@techstark/opencv-js')) as { default?: unknown } & Record<string, unknown>;
        const cv = (mod.default ?? mod) as CvRuntime & { onRuntimeInitialized?: () => void; then?: unknown };
        if (typeof cv.then === 'function') {
          const ready = await withTimeout(
            Promise.resolve(cv as unknown as PromiseLike<CvRuntime>),
            OPENCV_INIT_TIMEOUT_MS,
          );
          return ready;
        }
        return await new Promise<CvRuntime | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), OPENCV_INIT_TIMEOUT_MS);
          cv.onRuntimeInitialized = () => {
            clearTimeout(timer);
            resolve(cv);
          };
        });
      } catch {
        return null;
      }
    })();
  }
  return cvPromise;
}

export function isOpenCVAvailable(): Promise<boolean> {
  return loadOpenCV().then((cv) => cv !== null);
}

/**
 * OpenCV 增强去斜：基于最小外接矩形角度。
 * 返回 null 表示不可用/失败，调用方回退投影法（preprocess.estimateSkewDeg）。
 */
export async function estimateSkewWithOpenCV(
  _binary: Uint8Array,
  _width: number,
  _height: number,
): Promise<number | null> {
  const cv = await loadOpenCV();
  if (!cv) return null;
  // 骨架实现：OpenCV 的 minAreaRect 去斜对整页竖排谱面稳定性并不优于投影法，
  // 此处仅验证运行时可用，实际角度估计仍建议走投影法。返回 null 主动回退。
  return null;
}

/**
 * OpenCV 增强形态学开运算（横/纵核）。
 * 返回 null 表示不可用/失败，调用方回退行程长度法（layout/detect.ts）。
 */
export async function morphOpenWithOpenCV(
  _binary: Uint8Array,
  _width: number,
  _height: number,
  _kernelW: number,
  _kernelH: number,
): Promise<Uint8Array | null> {
  const cv = await loadOpenCV();
  if (!cv) return null;
  // 骨架实现：行程长度法已满足 P0 指标（单页 ≤8s），增强留待高精度模式迭代。
  return null;
}
