/**
 * 按资料类型（扫描图 / PDF / 脚本）选择预处理与版面检测参数。
 * 图像与 PDF 分开调参，避免用 dpi>0 猜测来源。
 */
import {
  DENOISE_MIN_AREA,
  MEDIAN_RADIUS,
  PDF_RENDER_DPI,
  PDF_SEGMENT_DENOISE_MIN_AREA,
  PDF_STROKE_DILATE_RADIUS,
} from '@/lib/constants';
import type { SourceInfo, SourceKind } from '@/model/types';

export interface PreprocessProfile {
  targetDpi: number;
  sourceDpi?: number;
  binarizer: 'otsu' | 'sauvola';
  strokeDilate: number;
  denoiseMinArea: number;
  medianRadius: number;
  /** 保留去噪前二值图供版面检测（PDF 页框不被小连通域剔除） */
  dualBinary?: boolean;
  /** 分割前形态学开运算半径，0=跳过 */
  morphOpenRadius?: number;
}

export interface DetectProfile {
  minBarFill: number;
  minBarSpan: number;
  projectionCoverage: number;
  solidFrameMinLongRatio: number;
  minBorderFillRatio: number;
  minSolidThicknessScale: number;
}

const IMAGE_DETECT: DetectProfile = {
  minBarFill: 0.28,
  minBarSpan: 0.48,
  projectionCoverage: 0.72,
  solidFrameMinLongRatio: 0.46,
  minBorderFillRatio: 0.55,
  minSolidThicknessScale: 0.004,
};

const PDF_DETECT: DetectProfile = {
  minBarFill: 0.16,
  minBarSpan: 0.36,
  projectionCoverage: 0.62,
  solidFrameMinLongRatio: 0.34,
  minBorderFillRatio: 0.42,
  minSolidThicknessScale: 0.0006,
};

/** 推断资料类型（兼容旧项目无 kind 字段） */
export function resolveSourceKind(source: SourceInfo): SourceKind {
  if (source.kind) return source.kind;
  if ((source.page ?? 0) > 0) return 'pdf';
  if (/\.pdf/i.test(source.name) && source.dpi > 0) return 'pdf';
  return 'image';
}

export function preprocessProfileFor(kind: SourceKind, source: SourceInfo): PreprocessProfile {
  if (kind === 'pdf') {
    const dpi = source.dpi > 0 ? source.dpi : PDF_RENDER_DPI;
    return {
      targetDpi: dpi,
      sourceDpi: dpi,
      binarizer: 'otsu',
      strokeDilate: PDF_STROKE_DILATE_RADIUS,
      denoiseMinArea: PDF_SEGMENT_DENOISE_MIN_AREA,
      medianRadius: 0,
      dualBinary: true,
      morphOpenRadius: 1,
    };
  }
  if (kind === 'script') {
    return {
      targetDpi: 254,
      sourceDpi: undefined,
      binarizer: 'sauvola',
      strokeDilate: 0,
      denoiseMinArea: DENOISE_MIN_AREA,
      medianRadius: MEDIAN_RADIUS,
    };
  }
  return {
    targetDpi: 254,
    sourceDpi: undefined,
    binarizer: 'sauvola',
    strokeDilate: 0,
    denoiseMinArea: DENOISE_MIN_AREA,
    medianRadius: MEDIAN_RADIUS,
  };
}

export function detectProfileFor(kind: SourceKind): DetectProfile {
  return kind === 'pdf' ? PDF_DETECT : IMAGE_DETECT;
}
