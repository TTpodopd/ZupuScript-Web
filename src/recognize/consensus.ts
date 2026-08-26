/**
 * 三轮识别共识：只有至少两轮对同一字达成一致，才允许自动写入。
 * 三轮皆分歧时宁可留给校对，也不把单轮猜测当作最终文字。
 */
import { CONFIDENCE_THRESHOLD } from '@/lib/constants';
import type { CharNote } from '@/model/types';
import type { RecognizedItem } from './types';

type RecognitionRound<T extends RecognizedItem> = readonly T[];

function collectCandidates<T extends RecognizedItem>(items: readonly (T | undefined)[], winner?: string | null): string[] {
  const candidates: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value || value === winner || candidates.includes(value)) return;
    candidates.push(value);
  };
  for (const item of items) {
    add(item?.char);
    for (const candidate of item?.candidates ?? []) add(candidate);
  }
  return candidates.slice(0, 3);
}

/** 统计某个字在多次独立识别中获得的相同票数。 */
export function countRecognitionVotes<T extends RecognizedItem>(
  id: number,
  text: string | null,
  rounds: readonly RecognitionRound<T>[],
): number {
  return rounds.reduce((count, round) => count + (round.find((item) => item.id === id)?.char === text ? 1 : 0), 0);
}

/** 三轮完整时执行多数表决；没有两票共识的字不自动填充。 */
export function mergeThreeRecognitionPasses<T extends RecognizedItem>(
  first: RecognitionRound<T>,
  second: RecognitionRound<T>,
  third: RecognitionRound<T>,
): T[] {
  const secondById = new Map(second.map((item) => [item.id, item]));
  const thirdById = new Map(third.map((item) => [item.id, item]));
  return first.map((initial) => {
    const votes = [initial, secondById.get(initial.id), thirdById.get(initial.id)];
    const grouped = new Map<string | null, Array<T | undefined>>();
    for (const vote of votes) {
      const key = vote?.char ?? null;
      const group = grouped.get(key) ?? [];
      group.push(vote);
      grouped.set(key, group);
    }
    const [winner, agreeing] = [...grouped.entries()]
      .sort((a, b) => b[1].length - a[1].length || (b[1][0]?.confidence ?? 0) - (a[1][0]?.confidence ?? 0))[0] ?? [null, []];
    const candidates = collectCandidates(votes, winner);

    if (agreeing.length < 2 || winner === null) {
      return {
        ...initial,
        char: null,
        confidence: 0,
        note: winner === null ? 'empty' : 'blurry',
        candidates,
      } as T;
    }

    const representative = agreeing
      .filter((item): item is T => Boolean(item))
      .sort((a, b) => b.confidence - a.confidence)[0] ?? initial;
    const meanConfidence = agreeing.reduce((sum, item) => sum + (item?.confidence ?? 0), 0) / agreeing.length;
    const confidence = agreeing.length === 3
      ? Math.min(0.99, Math.max(CONFIDENCE_THRESHOLD + 0.08, meanConfidence))
      : Math.min(0.94, Math.max(CONFIDENCE_THRESHOLD, meanConfidence - 0.03));
    return {
      ...representative,
      char: winner,
      confidence,
      note: 'ok' as CharNote,
      candidates,
    } as T;
  });
}

/** 某次复核不可用时，不将不足三轮的结果作为自动填充结论。 */
export function deferIncompleteRecognition<T extends RecognizedItem>(items: RecognitionRound<T>): T[] {
  return items.map((item) => ({
    ...item,
    char: null,
    confidence: 0,
    note: item.char === null ? 'empty' as CharNote : 'blurry' as CharNote,
    candidates: collectCandidates([item]),
  }) as T);
}
