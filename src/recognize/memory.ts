import { cropBinary } from '@/imaging/raster';
import { fnv1a } from '@/lib/utils';
import type { CharItem } from '@/model/types';
import type { Page } from '@/model/types';
import {
  getMemoryByAspect,
  getMemoryByFingerprint,
  saveMemoryRecord,
  type RecognitionMemoryRecord,
} from '@/storage/db';
import { scaleCoverage } from '@/segment/grid';
import { getBinaryImage } from '@/storage/opfs';

const SIGNATURE_SIZE = 20;
const MAX_HAMMING_DISTANCE = 28;

export type MemoryEvidenceSource = 'manual' | 'model' | 'local';

export interface GlyphFingerprint {
  fingerprint: string;
  signature: string;
  aspectBucket: number;
}

export interface RecalledGlyph {
  text: string;
  confidence: number;
  similarity: number;
  evidenceCount: number;
  manualCount: number;
}

export function createGlyphFingerprint(
  char: CharItem,
  bin: Uint8Array,
  width: number,
  height: number,
): GlyphFingerprint | null {
  const [x0, y0, x1, y1] = char.bbox;
  const pad = Math.max(2, Math.round(Math.min(x1 - x0, y1 - y0) * 0.08));
  const crop = cropBinary(bin, width, height, x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2);
  if (crop.width <= 0 || crop.height <= 0 || crop.data.every((value) => value === 0)) return null;
  const coverage = scaleCoverage(crop.data, crop.width, crop.height, SIGNATURE_SIZE, SIGNATURE_SIZE);
  const signature = Array.from(coverage, (value) => (value >= 72 ? '1' : '0')).join('');
  const aspectBucket = Math.round(Math.log2(crop.width / Math.max(1, crop.height)) * 4);
  return {
    fingerprint: fnv1a(`${aspectBucket}:${signature}`),
    signature,
    aspectBucket,
  };
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) distance += 1;
  return distance;
}

async function findCandidates(fingerprint: GlyphFingerprint): Promise<Array<{ record: RecognitionMemoryRecord; similarity: number }>> {
  const exact = await getMemoryByFingerprint(fingerprint.fingerprint);
  const approximate = exact.length > 0
    ? exact
    : (await Promise.all([
        getMemoryByAspect(fingerprint.aspectBucket - 1),
        getMemoryByAspect(fingerprint.aspectBucket),
        getMemoryByAspect(fingerprint.aspectBucket + 1),
      ])).flat();
  return approximate
    .map((record) => {
      const distance = hammingDistance(fingerprint.signature, record.signature);
      return { record, similarity: 1 - distance / fingerprint.signature.length };
    })
    .filter(({ similarity }) => (1 - similarity) * fingerprint.signature.length <= MAX_HAMMING_DISTANCE);
}

export async function recallCharacter(
  char: CharItem,
  bin: Uint8Array,
  width: number,
  height: number,
): Promise<RecalledGlyph | null> {
  const fingerprint = createGlyphFingerprint(char, bin, width, height);
  if (!fingerprint) return null;
  const candidates = await findCandidates(fingerprint);
  const grouped = new Map<string, { score: number; similarity: number; total: number; manual: number; confidenceSum: number }>();
  for (const { record, similarity } of candidates) {
    const averageConfidence = record.confidenceSum / Math.max(1, record.totalCount);
    const evidenceWeight = record.manualCount * 4 + record.modelCount * 2 + record.localCount * 0.5;
    const current = grouped.get(record.char) ?? { score: 0, similarity: 0, total: 0, manual: 0, confidenceSum: 0 };
    current.score += Math.pow(similarity, 4) * evidenceWeight * averageConfidence;
    current.similarity = Math.max(current.similarity, similarity);
    current.total += record.totalCount;
    current.manual += record.manualCount;
    current.confidenceSum += record.confidenceSum;
    grouped.set(record.char, current);
  }
  const ranked = [...grouped.entries()].sort((a, b) => b[1].score - a[1].score);
  const [best, second] = ranked;
  if (!best) return null;
  const [text, evidence] = best;
  const averageConfidence = evidence.confidenceSum / Math.max(1, evidence.total);
  const decisive = !second || evidence.score >= second[1].score * 1.6;
  const trustedManual = evidence.manual >= 2 && evidence.similarity >= 0.93;
  const trustedMixed = evidence.manual >= 1 && evidence.total >= 3 && evidence.similarity >= 0.95 && averageConfidence >= 0.9;
  const trustedRepeated = evidence.total >= 6 && evidence.similarity >= 0.97 && averageConfidence >= 0.92;
  if (!decisive || (!trustedManual && !trustedMixed && !trustedRepeated)) return null;
  const confidence = trustedManual ? 0.97 : trustedMixed ? 0.94 : 0.9;
  return { text, confidence, similarity: evidence.similarity, evidenceCount: evidence.total, manualCount: evidence.manual };
}

export async function recallCharacters(
  chars: CharItem[],
  bin: Uint8Array,
  width: number,
  height: number,
): Promise<Map<string, RecalledGlyph>> {
  const entries = await Promise.all(chars.map(async (char) => [char.id, await recallCharacter(char, bin, width, height)] as const));
  return new Map(entries.filter((entry): entry is readonly [string, RecalledGlyph] => entry[1] !== null));
}

export async function learnCharacter(
  char: CharItem,
  text: string,
  confidence: number,
  source: MemoryEvidenceSource,
  bin: Uint8Array,
  width: number,
  height: number,
  evidenceKey: string,
): Promise<void> {
  const fingerprint = createGlyphFingerprint(char, bin, width, height);
  if (!fingerprint || [...text].length !== 1) return;
  const id = `${fingerprint.fingerprint}:${text}`;
  const existing = (await getMemoryByFingerprint(fingerprint.fingerprint)).find((record) => record.id === id);
  const evidenceKeys = existing?.evidenceKeys ?? [];
  if (evidenceKeys.includes(evidenceKey)) return;
  const record: RecognitionMemoryRecord = existing ?? {
    id,
    ...fingerprint,
    char: text,
    totalCount: 0,
    manualCount: 0,
    modelCount: 0,
    localCount: 0,
    confidenceSum: 0,
    lastSeen: 0,
    evidenceKeys,
  };
  record.totalCount += 1;
  record.manualCount += source === 'manual' ? 1 : 0;
  record.modelCount += source === 'model' ? 1 : 0;
  record.localCount += source === 'local' ? 1 : 0;
  record.confidenceSum += Math.max(0, Math.min(1, confidence));
  record.lastSeen = Date.now();
  record.evidenceKeys = [...evidenceKeys, evidenceKey].slice(-80);
  await saveMemoryRecord(record);
}

export async function learnCharacters(
  chars: CharItem[],
  bin: Uint8Array,
  width: number,
  height: number,
  pageId: string,
): Promise<void> {
  const trusted = chars.filter((char) => char.text && char.conf >= 0.9 && !char.edited);
  await Promise.all(trusted.map((char) => learnCharacter(
    char,
    char.text!,
    char.conf,
    char.source === 'llm' ? 'model' : 'local',
    bin,
    width,
    height,
    `${pageId}:${char.id}:${char.source}`,
  )));
}

export async function learnManualCorrection(page: Page, charId: string, text: string): Promise<void> {
  const char = page.chars.find((item) => item.id === charId);
  if (!char || [...text].length !== 1) return;
  const stored = await getBinaryImage(page.binaryKey);
  if (!stored) return;
  await learnCharacter(
    char,
    text,
    1,
    'manual',
    stored.bin,
    stored.width,
    stored.height,
    `${page.id}:${char.id}:manual:${text}`,
  );
}
