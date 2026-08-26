import { check, eq, section, summary } from './helpers.mjs';
import { countRecognitionVotes, deferIncompleteRecognition, mergeThreeRecognitionPasses } from '../src/recognize/consensus.ts';

function item(id, char, confidence = 0.9, candidates = []) {
  return { id, char, confidence, note: char ? 'ok' : 'empty', candidates };
}

section('三轮识别共识');
{
  const first = [item(0, '倪', 0.92), item(1, '氏', 0.88)];
  const second = [item(0, '倪', 0.95), item(1, '氏', 0.9)];
  const third = [item(0, '倪', 0.93), item(1, '氐', 0.82, ['氏'])];
  const merged = mergeThreeRecognitionPasses(first, second, third);
  eq('三轮一致字保留', merged[0].char, '倪');
  check('三轮一致字通过最终阈值', merged[0].confidence >= 0.93);
  eq('两票多数选择正确字', merged[1].char, '氏');
  check('两票多数不高于三票共识', merged[1].confidence <= 0.94);
  eq('统计三票一致', countRecognitionVotes(0, '倪', [first, second, third]), 3);
  eq('统计两票多数', countRecognitionVotes(1, '氏', [first, second, third]), 2);
}

section('无共识不自动填充');
{
  const first = [item(0, '倪', 0.9)];
  const second = [item(0, '候', 0.9)];
  const third = [item(0, '侯', 0.9)];
  const merged = mergeThreeRecognitionPasses(first, second, third);
  eq('三轮各异清空文字', merged[0].char, null);
  eq('三轮各异置信度为零', merged[0].confidence, 0);
  eq('三轮各异标为待校对', merged[0].note, 'blurry');
  check('冲突候选被保留供人工核对', merged[0].candidates.includes('候') && merged[0].candidates.includes('侯'));
}

section('空字多数与未完成核验');
{
  const first = [item(0, '倪', 0.94)];
  const second = [item(0, null, 0)];
  const third = [item(0, null, 0)];
  const merged = mergeThreeRecognitionPasses(first, second, third);
  eq('两轮判空不写入单轮猜字', merged[0].char, null);
  eq('两轮判空标为空', merged[0].note, 'empty');

  const deferred = deferIncompleteRecognition(first);
  eq('缺少第三轮时不自动写入', deferred[0].char, null);
  check('缺少第三轮保留原候选', deferred[0].candidates.includes('倪'));
}

summary('recognition consensus');
