/** 后处理模块测试：字典提权、候选兜底、异体记录、数量守恒 */
import { check, eq, approx, section, summary } from './helpers.mjs';
import { correctAutomatedZiJieConfusion, postprocessItems } from '../src/recognize/postprocess.ts';
import { DICT_HIT_CONF, DICT_CANDIDATE_CONF, DICT_LOW_CONF_MAX } from '../src/lib/constants.ts';

section('字典提权');
{
  // 命中姓氏且 conf < 0.85 → 提至 0.86
  const items = [
    { id: 0, char: '侯', confidence: 0.6, note: 'ok' },
    { id: 1, char: '張', confidence: 0.8, note: 'ok' },
    { id: 2, char: 'X', confidence: 0.5, note: 'ok' }, // 不在字典
  ];
  const out = postprocessItems(items);
  approx('姓氏「侯」提权到 0.86', out[0].confidence, DICT_HIT_CONF);
  eq('姓氏「侯」dictBoosted', out[0].dictBoosted, true);
  approx('姓氏「張」提权到 0.86', out[1].confidence, DICT_HIT_CONF);
  // 不在字典的不提权
  eq('非字典字不提权', out[2].confidence, 0.5);
  eq('非字典字不标记', out[2].dictBoosted, undefined);
}

section('字典提权边界');
{
  // conf >= 0.86 不再提权
  const items = [{ id: 0, char: '侯', confidence: 0.9, note: 'ok' }];
  const out = postprocessItems(items);
  eq('高置信不提权', out[0].confidence, 0.9);
  eq('高置信不标记', out[0].dictBoosted, undefined);
}

section('候选兜底');
{
  // conf 极低 + char=null + 候选在字典 → 采用首候选
  const items = [
    { id: 0, char: null, confidence: 0.1, note: 'blurry', candidates: ['侯', '候'] },
    { id: 1, char: null, confidence: 0.3, note: 'blurry', candidates: ['X'] }, // 候选不在字典
    { id: 2, char: null, confidence: 0.1, note: 'blurry' }, // 无候选
  ];
  const out = postprocessItems(items);
  eq('候选兜底采用首候选', out[0].char, '侯');
  approx('候选兜底 conf=0.80', out[0].confidence, DICT_CANDIDATE_CONF);
  eq('候选兜底标记', out[0].candidateUsed, true);
  // 候选不在字典 → 不采用
  eq('候选不在字典不采用', out[1].char, null);
  // 无候选 → 不采用
  eq('无候选不采用', out[2].char, null);
}

section('候选兜底边界');
{
  // conf >= DICT_LOW_CONF_MAX 不触发候选兜底
  const items = [
    { id: 0, char: null, confidence: 0.6, note: 'blurry', candidates: ['侯'] },
  ];
  const out = postprocessItems(items);
  eq('高 conf 候选不触发', out[0].char, null);
}

section('异体字记录');
{
  const items = [
    { id: 0, char: '爲', confidence: 0.9, note: 'ok' },
    { id: 1, char: '逺', confidence: 0.9, note: 'ok' },
    { id: 2, char: '侯', confidence: 0.9, note: 'ok' }, // 非异体
  ];
  const out = postprocessItems(items);
  eq('异体「爲」记录 norm', out[0].normalizedChar, '為');
  eq('异体「逺」记录 norm', out[1].normalizedChar, '遠');
  eq('非异体无 norm', out[2].normalizedChar, undefined);
  // 原字保留不变
  eq('异体原字保留', out[0].char, '爲');
}

section('子/孑定向消歧');
{
  const lowConfidence = postprocessItems([
    { id: 0, char: '孑', confidence: 0.72, note: 'blurry', candidates: ['孑', '子'] },
  ]);
  eq('族谱低置信「孑」纠正为「子」', lowConfidence[0].char, '子');
  eq('纠正后标记候选兜底', lowConfidence[0].candidateUsed, true);

  const autoBody = correctAutomatedZiJieConfusion({
    id: 'body-1', text: '孑', cx: 0, cy: 0, bbox: [0, 0, 10, 10], pt: 10,
    conf: 0.95, note: 'ok', source: 'llm', edited: false, group: 'body', kind: 'text',
  });
  eq('自动正文中的「孑」最终纠正为「子」', autoBody.text, '子');

  const manualBody = correctAutomatedZiJieConfusion({ ...autoBody, text: '孑', source: 'manual', edited: true });
  eq('手工确认的「孑」保持原字', manualBody.text, '孑');

  const title = correctAutomatedZiJieConfusion({ ...autoBody, text: '孑', group: 'title' });
  eq('标题中的「孑」保持原字', title.text, '孑');
}
section('数量守恒');
{
  const items = Array.from({ length: 50 }, (_, i) => ({
    id: i,
    char: i % 3 === 0 ? null : '侯',
    confidence: 0.5 + (i % 5) * 0.1,
    note: 'ok',
  }));
  const out = postprocessItems(items);
  eq('数量守恒：输入50 → 输出50', out.length, 50);
}

section('空数组');
{
  const out = postprocessItems([]);
  eq('空数组守恒', out.length, 0);
}

summary('后处理模块测试');
