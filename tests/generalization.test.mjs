/** 泛化回归测试：提示词不含样本专有书名、版本升级、记忆项目隔离闸门 */
import { check, eq, section, summary } from './helpers.mjs';
import {
  buildGridUserPrompt,
  buildPageAnchoredUserPrompt,
  RECOGNITION_PROMPT_VERSION,
  SYSTEM_PROMPT,
  PAGE_USER_PROMPT,
} from '../src/recognize/prompt.ts';
import { memoryRecordVisible, LEGACY_CROSS_PROJECT_MIN_SIMILARITY } from '../src/recognize/memory.ts';

section('提示词版本与样本专名清理');
{
  // 版本号锁：升级 prompt.ts 的 RECOGNITION_PROMPT_VERSION 时须同步更新此断言（强制有意为之）
  eq('提示词版本升级到 v17（旧缓存自动失效）', RECOGNITION_PROMPT_VERSION, 'genealogy-ocr-v17');
  check('系统提示词不含样本书名', !SYSTEM_PROMPT.includes('倪氏宗譜'));
  check('整页提示词不含样本书名', !PAGE_USER_PROMPT.includes('倪氏宗譜'));
  check('右缘标题指引不写死「三个字」', !SYSTEM_PROMPT.includes('不得漏掉三个字') && !PAGE_USER_PROMPT.includes('不得漏掉三个字'));
}

section('B 模式拼图提示词：书名参数化');
{
  const noHint = buildGridUserPrompt(8, 8, 64, [], [], [], [], [1, 2, 3, 4]);
  check('无共识时不含任何样本书名', !noHint.includes('倪氏宗譜'));
  check('无共识时明确禁止套用固定书名', noHint.includes('严禁套用任何固定书名'));

  const withHint = buildGridUserPrompt(8, 8, 64, [], [], [], [], [1, 2, 3, 4], '王氏宗譜');
  check('有共识时注入项目书名', withHint.includes('本项目书名经共识确认为「王氏宗譜」'));
  check('有共识时仍要求以图像为准', withHint.includes('以图像为准'));

  // 无页边书名格时不产生书名段落
  const none = buildGridUserPrompt(8, 8, 64, [], [], [], [], []);
  check('无页边书名格时不产生书名提示', !none.includes('左页边书名提示'));
}

section('C 模式锚点提示词：书名参数化');
{
  const chars = [
    { cx: 100, cy: 100, kind: 'side', group: 'title' },
    { cx: 900, cy: 300 },
  ];
  const noHint = buildPageAnchoredUserPrompt(chars, 2000, 3000);
  check('锚点提示无共识时不含样本书名', !noHint.includes('倪氏宗譜'));
  check('锚点提示无共识时禁止按固定书名猜写', noHint.includes('严禁依据任何固定书名猜写'));

  const withHint = buildPageAnchoredUserPrompt(chars, 2000, 3000, '王氏宗譜');
  check('锚点提示有共识时注入书名', withHint.includes('经本项目共识确认为「王氏宗譜」'));
}

section('识别记忆项目隔离闸门');
{
  const sameProject = { projectId: 'proj-A', manualCount: 0 };
  const otherProject = { projectId: 'proj-B', manualCount: 9 };
  const legacyStrong = { manualCount: 2 }; // 无 projectId 的遗留记录
  const legacyWeak = { manualCount: 1 };

  check('同项目记录可见', memoryRecordVisible(sameProject, 'proj-A', 0.5));
  check('其他项目记录不可见（即使证据多）', !memoryRecordVisible(otherProject, 'proj-A', 0.999));
  check('遗留记录：人工证据+极高相似可跨项目', memoryRecordVisible(legacyStrong, 'proj-A', LEGACY_CROSS_PROJECT_MIN_SIMILARITY));
  check('遗留记录：相似度不足不放行', !memoryRecordVisible(legacyStrong, 'proj-A', LEGACY_CROSS_PROJECT_MIN_SIMILARITY - 0.001));
  check('遗留记录：人工证据不足不放行', !memoryRecordVisible(legacyWeak, 'proj-A', 0.999));
  check('遗留记录：无项目上下文不放行', !memoryRecordVisible(legacyStrong, undefined, 0.999));
}
summary('识别泛化回归测试');
