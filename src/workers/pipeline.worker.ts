/**
 * 图像处理与分析 Worker（Comlink expose：preprocess / analyze / segment）。
 * 全部重计算在此线程执行，不阻塞 UI；进度经 Comlink.proxy 回调上报。
 */
import * as Comlink from 'comlink';
import { preprocessPipeline, type PreprocessOptions, type PreprocessResult } from '@/imaging/preprocess';
import { detectRects, detectTreeLines } from '@/layout/detect';
import { analyzeTagRectInversions, detectArtifacts, detectNodes } from '@/layout/nodes';
import { segmentChars } from '@/segment/segment';
import type {
  ArtifactStroke,
  BorderRect,
  CharItem,
  TagRect,
  TreeLine,
  TreeNode,
} from '@/model/types';

export interface ProgressInfo {
  stage: 'deskew' | 'binarize' | 'denoise' | 'layout' | 'segment';
  percent: number;
}

export interface LayoutResult {
  borderRects: BorderRect[];
  tagRects: TagRect[];
  treeLines: TreeLine[];
  treeNodes: TreeNode[];
  artifacts: ArtifactStroke[];
}

export interface PipelineAPI {
  preprocess(
    image: ImageData,
    opts: PreprocessOptions,
    onProgress: (p: ProgressInfo) => void,
  ): Promise<PreprocessResult>;
  analyze(
    binary: Uint8Array,
    width: number,
    height: number,
    onProgress: (p: ProgressInfo) => void,
  ): Promise<LayoutResult>;
  segment(
    binary: Uint8Array,
    width: number,
    height: number,
    lines: TreeLine[],
    excludedRects?: Array<Pick<BorderRect | TagRect, 'x' | 'y' | 'w' | 'h'>>,
  ): Promise<CharItem[]>;
}

const api: PipelineAPI = {
  async preprocess(image, opts, onProgress) {
    return preprocessPipeline(image, opts, (p) =>
      onProgress({ stage: p.stage as ProgressInfo['stage'], percent: p.percent }),
    );
  },

  async analyze(binary, width, height, onProgress) {
    onProgress({ stage: 'layout', percent: 10 });
    const { borderRects, tagRects, rectMask } = detectRects(binary, width, height);
    onProgress({ stage: 'layout', percent: 35 });
    const treeLines = detectTreeLines(binary, width, height, rectMask);
    onProgress({ stage: 'layout', percent: 55 });
    const treeNodes = detectNodes(binary, width, height, treeLines);
    onProgress({ stage: 'layout', percent: 80 });
    const artifacts = detectArtifacts(binary, width, height, treeLines);
    // 装饰块内部反色分析（存在性统计，供 UI 提示）
    for (const t of tagRects) {
      analyzeTagRectInversions(binary, width, height, t);
    }
    onProgress({ stage: 'layout', percent: 100 });
    return { borderRects, tagRects, treeLines, treeNodes, artifacts };
  },

  async segment(binary, width, height, lines, excludedRects = []) {
    return segmentChars(binary, width, height, lines, excludedRects);
  },
};

Comlink.expose(api);
