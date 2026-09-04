/**
 * 同形指纹聚类与识别传播（模式 A 深度优化）。
 *
 * 族谱版面的强先验：同一页内大量字符是同字重复（倪/公/氏/善/子…）。
 * 单字 OCR 对某个位置失败，不代表同形的其他位置也失败——
 * 只要页内任一位置被可信识别，同形位置即可零成本回填。
 *
 * 流程：
 * 1. 每个待识别字生成 32×32 墨迹覆盖度指纹（闭运算修断笔 + 1px 膨胀容忍位置/粗细差）；
 * 2. 分块二值化后按汉明距离聚类（≤9.4% 位差判同形）；
 * 3. 簇内选可信种子（OCR conf≥0.85 优先；族谱字典字 conf≥0.5 次之）；
 * 4. 种子向簇内空识别/低置信位置传播。高证据的不同字、人工确认字一律不碰。
 *
 * 全部本地计算，不出网；不发明文字——种子必须来自真实识别证据。
 */
import { cropBinary } from '@/imaging/raster';
import { closeBinary, dilateBinary, scaleCoverage } from '@/segment/grid';
import { COLUMN_END_STRUCTURAL_CHARS, CONFIDENCE_THRESHOLD, DICT_CANDIDATE_CONF, DICT_LOW_CONF_MAX } from '@/lib/constants';
import { isSurnameChar } from './dict/surnames';
import { isDictChar } from './dict/genealogy';
import { isCjkGlyph } from './prompt';
import type { CharItem } from '@/model/types';
import type { LocalOcrResult } from './local/tesseract';

const STRUCTURAL_SEED_CHARS = new Set<string>(COLUMN_END_STRUCTURAL_CHARS);

export const FINGERPRINT_SIZE = 16;
/** 16×16=256 位中允许的最大差异位数（≈22%）：1px 分割抖动在下采样后 ≤1 格，配合低分辨率膨胀可吸收 */
export const FINGERPRINT_MAX_HAMMING = 56;
/** 二值化阈值：>0 即计墨位。dilateBinary 输出为 0/1，scaleCoverage 灰度也兼容（任意非零覆盖都算） */
const INK_THRESHOLD = 0;

/**
 * 单字同形指纹：源分辨率闭运算修断笔 → 面积平均下采样到 16×16（吸收 ±1px 抖动）
 * → 低分辨率 1px 膨胀（容忍粗细微差）→ 汉明比较。
 * 注意顺序：先下采样再膨胀；若在源分辨率膨胀，位移差会被放大到阈值之上。
 */
export function glyphFingerprint(
  bin: Uint8Array,
  pageWidth: number,
  pageHeight: number,
  bbox: [number, number, number, number],
): Uint8Array {
  const pad = 3;
  const crop = cropBinary(bin, pageWidth, pageHeight, bbox[0] - pad, bbox[1] - pad, bbox[2] - bbox[0] + pad * 2, bbox[3] - bbox[1] + pad * 2);
  if (crop.width === 0 || crop.height === 0) return new Uint8Array(FINGERPRINT_SIZE * FINGERPRINT_SIZE);
  const closed = closeBinary(crop.data, crop.width, crop.height, 1);
  const scaled = scaleCoverage(closed, crop.width, crop.height, FINGERPRINT_SIZE, FINGERPRINT_SIZE);
  return dilateBinary(scaled, FINGERPRINT_SIZE, FINGERPRINT_SIZE, 1);
}

/** 分块二值化汉明距离（位差计数） */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] > INK_THRESHOLD ? 1 : 0;
    const bi = b[i] > INK_THRESHOLD ? 1 : 0;
    if (ai !== bi) diff += 1;
  }
  return diff;
}

export function isSameGlyph(a: Uint8Array, b: Uint8Array): boolean {
  return hammingDistance(a, b) <= FINGERPRINT_MAX_HAMMING;
}

/** 贪心聚类：依次与已有簇代表比较，落入首个同形簇，否则新开簇 */
export function clusterFingerprints(fingerprints: Uint8Array[]): number[][] {
  const clusters: Array<{ repr: Uint8Array; members: number[] }> = [];
  fingerprints.forEach((fp, index) => {
    if (fp.every((v) => v === 0)) return; // 空裁剪不参与聚类
    const hit = clusters.find((c) => isSameGlyph(c.repr, fp));
    if (hit) hit.members.push(index);
    else clusters.push({ repr: fp, members: [index] });
  });
  return clusters.map((c) => c.members);
}

interface GlyphSeed {
  text: string;
  /** 1 = 人工确认/OCR 强证据；2 = 簇内多点共识；3 = 族谱字典弱证据 */
  tier: 1 | 2 | 3;
}

/**
 * 同形传播：全页同形簇内，高证据种子 → 空识别/低置信同形位置。
 *
 * 种子来源（tier 越小越可信）：
 * - tier1：人工确认/已编辑字（最可信的标注）；或 OCR conf≥0.85 的强结果；
 * - tier2：簇内同字在 ≥2 个不同位置独立读出（conf≥0.5）——单点低置信是噪声，
 *   多点一致即强证据（「公」两处 0.55 互证 ≫ 单处 0.9）；
 * - tier3：单点 OCR conf≥0.5 且命中族谱字典。
 *
 * 目标仅限本轮识别结果（results 内）且非人工字：
 * - 空识别：填种子字，conf = 0.88 / 0.86 / 0.80（按 tier）；
 * - 同字低置信：conf 提至 max(0.88, 原+0.35)，上限 0.95；
 * - 异字且 conf<0.5：仅 tier1/2 可覆盖（conf 0.85）；结构字「公/氏」只填空框，不覆盖已有汉字；
 * - conf≥0.5 的异字、conf≥0.85 的结果：一律不碰。
 * 返回被改善的位置数。
 */
export function propagateLocalGlyphs(
  allChars: CharItem[],
  results: Map<string, LocalOcrResult>,
  bin: Uint8Array,
  pageWidth: number,
  pageHeight: number,
): number {
  const fingerprints = allChars.map((c) => glyphFingerprint(bin, pageWidth, pageHeight, c.bbox));
  const clusters = clusterFingerprints(fingerprints);
  let improved = 0;
  // 证据读取：本轮识别结果优先，重跑场景回退到历史写回值（c.text/c.conf）
  const readEvidence = (c: CharItem): { text: string | null; confidence: number } => {
    const r = results.get(c.id);
    if (r) return { text: r.text, confidence: r.confidence };
    if (!c.edited && c.source !== 'manual') return { text: c.text, confidence: c.conf };
    return { text: null, confidence: 0 };
  };
  for (const members of clusters) {
    if (members.length < 2) continue;
    const evidence: GlyphSeed[] = [];
    // tier1a：人工确认/已编辑（同簇内即视作该字形的权威标注）
    for (const i of members) {
      const c = allChars[i];
      if ((c.edited || c.source === 'manual') && c.text && isCjkGlyph(c.text)) evidence.push({ text: c.text, tier: 1 });
    }
    // tier1b：OCR 强结果（本轮或历史）
    for (const i of members) {
      const c = allChars[i];
      if (c.edited || c.source === 'manual') continue;
      const e = readEvidence(c);
      if (e.text && e.confidence >= CONFIDENCE_THRESHOLD) evidence.push({ text: e.text, tier: 1 });
    }
    // tier2：簇内多点共识（≥2 处同字，conf≥0.5）
    const counts = new Map<string, number>();
    for (const i of members) {
      const c = allChars[i];
      if (c.edited || c.source === 'manual') continue;
      const e = readEvidence(c);
      if (e.text && e.confidence >= DICT_LOW_CONF_MAX) counts.set(e.text, (counts.get(e.text) ?? 0) + 1);
    }
    for (const [text, n] of counts) if (n >= 2) evidence.push({ text, tier: 2 });
    // tier3：字典弱证据
    for (const i of members) {
      const c = allChars[i];
      if (c.edited || c.source === 'manual') continue;
      const e = readEvidence(c);
      if (e.text && e.confidence >= DICT_LOW_CONF_MAX && e.confidence < CONFIDENCE_THRESHOLD && (isSurnameChar(e.text) || isDictChar(e.text))) {
        evidence.push({ text: e.text, tier: 3 });
      }
    }
    if (evidence.length === 0) continue;
    const bestTier = Math.min(...evidence.map((e) => e.tier)) as 1 | 2 | 3;
    const bestTexts = [...new Set(evidence.filter((e) => e.tier === bestTier).map((e) => e.text))];
    // 同级证据冲突（如人工「王」与强 OCR「公」同簇）：指纹可能误并异形，保守跳过整簇
    if (bestTexts.length !== 1) continue;
    const seed = { text: bestTexts[0], tier: bestTier };
    for (const i of members) {
      const c = allChars[i];
      if (c.edited || c.source === 'manual') continue;
      const target = results.get(c.id);
      if (!target || target.confidence >= CONFIDENCE_THRESHOLD) continue;
      if (target.text === null) {
        target.text = seed.text;
        target.confidence = bestTier === 1 ? 0.88 : bestTier === 2 ? 0.86 : DICT_CANDIDATE_CONF;
        target.candidates = [seed.text, ...target.candidates].slice(0, 3);
        improved += 1;
      } else if (target.text === seed.text) {
        target.confidence = Math.min(0.95, Math.max(0.88, target.confidence + 0.35));
        improved += 1;
      } else if (
        target.confidence < DICT_LOW_CONF_MAX
        && bestTier <= 2
        && !STRUCTURAL_SEED_CHARS.has(seed.text)
      ) {
        target.candidates = [seed.text, target.text, ...target.candidates].slice(0, 3);
        target.text = seed.text;
        target.confidence = 0.85;
        improved += 1;
      }
    }
  }
  return improved;
}
