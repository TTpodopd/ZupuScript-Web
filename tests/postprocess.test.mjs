/** 后处理模块测试：字典提权、候选兜底、异体记录、数量守恒、书名修复参数化 */
import { check, eq, approx, section, summary } from './helpers.mjs';
import { correctAutomatedZiJieConfusion, fillColumnStructuralChars, markAutomatedHandwrittenRankForReview, normalizeKnownMarginTitleBoxes, parseMarginTitleHint, postprocessItems, repairGenealogySequences } from '../src/recognize/postprocess.ts';
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

section('三轮共识后的严格后处理');
{
  const strict = postprocessItems([
    { id: 0, char: null, confidence: 0, note: 'blurry', candidates: ['侯'] },
    { id: 1, char: '侯', confidence: 0.6, note: 'blurry' },
    { id: 2, char: '孑', confidence: 0.72, note: 'blurry', candidates: ['子'] },
  ], { isGenealogy: true, strictConsensus: true });
  eq('严格共识不以字典候选补空字', strict[0].char, null);
  eq('严格共识不以词典提高弱证据置信度', strict[1].confidence, 0.6);
  eq('严格共识不改写已投票文字', strict[2].char, '孑');
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
    conf: 0.7, note: 'blurry', source: 'llm', edited: false, group: 'body', kind: 'text',
  });
  eq('低置信自动正文中的「孑」纠正为「子」', autoBody.text, '子');

  const consensusBody = correctAutomatedZiJieConfusion({ ...autoBody, text: '孑', conf: 0.95, note: 'ok' });
  eq('三轮共识的「孑」不被词频规则覆盖', consensusBody.text, '孑');

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

section('手写排行进入校对');
const rankBase = {
  id: 'rank-hand', text: '三', cx: 10, cy: 10, bbox: [0, 0, 20, 20], pt: 12,
  conf: 0.86, note: 'ok', source: 'llm', edited: false, group: 'rank', kind: 'text',
};
const rankReview = markAutomatedHandwrittenRankForReview(rankBase);
check('弱证据排行字保留原文字', rankReview.text === '三');
check('弱证据排行字进入校对', rankReview.conf < 0.85 && rankReview.note === 'blurry');
const bodyUntouched = markAutomatedHandwrittenRankForReview({ ...rankBase, id: 'body', group: 'body' });
check('普通正文置信度不变', bodyUntouched.conf === rankBase.conf && bodyUntouched.note === 'ok');
const manualUntouched = markAutomatedHandwrittenRankForReview({ ...rankBase, id: 'manual', edited: true, source: 'manual' });
check('人工确认排行不受影响', manualUntouched.conf === rankBase.conf && manualUntouched.note === 'ok');

section('族谱结构词修复');
const rankSequence = repairGenealogySequences([
  { ...rankBase, id: 'long', text: '长', cx: 10, cy: 20 },
  { ...rankBase, id: 'son', text: '予', conf: 0.42, cx: 34, cy: 20 },
]);
eq('排行首字恢复繁体長', rankSequence.find((c) => c.id === 'long').text, '長');
eq('低置信排行第二字修复为子', rankSequence.find((c) => c.id === 'son').text, '子');

const sanZiSequence = repairGenealogySequences([
  { ...rankBase, id: 'san', text: null, conf: 0, cx: 10, cy: 30 },
  { ...rankBase, id: 'zi', text: '子', conf: 0.9, cx: 34, cy: 30 },
]);
eq('三子首字为空时修复为三', sanZiSequence.find((c) => c.id === 'san').text, '三');

const sanShiZu = ['一', '世', '祖'].map((text, index) => ({
  ...rankBase,
  id: `san-shi-zu-${index}`,
  text,
  conf: index === 0 ? 0.2 : 0.92,
  cx: 180,
  cy: 40 + index * 34,
  group: 'title',
  kind: 'side',
}));
const repairedSanShiZu = repairGenealogySequences(sanShiZu);
eq('三世祖首字低置信时修复为三', repairedSanShiZu[0].text, '三');

const marginTitle = [...'倪氏錯字'].map((text, index) => ({
  ...rankBase,
  id: `title-${index}`,
  text: index < 2 ? text : null,
  cx: 20,
  cy: 20 + index * 30,
  conf: index < 2 ? 0.92 : 0.3,
  group: 'title',
  kind: 'side',
}));
const repairedTitle = repairGenealogySequences(marginTitle, { knownMarginTitle: '倪氏宗譜' });
eq('提供书名共识时补齐倪氏宗譜', repairedTitle.sort((a, b) => a.cy - b.cy).map((c) => c.text).join(''), '倪氏宗譜');
const unevenTitleFrames = repairedTitle.map((char, index) => ({
  ...char,
  bbox: [10, 10 + index * 30, 10 + 12 + index * 3, 10 + index * 30 + 18 + index * 4],
}));
const normalizedTitleFrames = normalizeKnownMarginTitleBoxes(unevenTitleFrames, '倪氏宗譜', 400)
  .filter((char) => char.group === 'title')
  .sort((a, b) => a.cy - b.cy);
check('最终书名框宽度完全一致', normalizedTitleFrames.every((char) => char.bbox[2] - char.bbox[0] === normalizedTitleFrames[0].bbox[2] - normalizedTitleFrames[0].bbox[0]));
check('最终书名框高度完全一致', normalizedTitleFrames.every((char) => char.bbox[3] - char.bbox[1] === normalizedTitleFrames[0].bbox[3] - normalizedTitleFrames[0].bbox[1]));

section('书名修复参数化（泛化）');
{
  // 未提供书名 → 绝不补写（新谱书零偏见）
  const noHint = repairGenealogySequences(marginTitle.map((c) => ({ ...c })));
  check('无书名提示时不补写标题', noHint.some((c) => c.text === null) && !noHint.some((c) => c.text === '宗'));

  // 其他书名同样可修复（不绑定特定样本）
  const wangTitle = [...'王氏錯字'].map((text, index) => ({
    ...rankBase,
    id: `wang-${index}`,
    text: index < 2 ? text : null,
    cx: 20,
    cy: 20 + index * 30,
    conf: index < 2 ? 0.92 : 0.3,
    group: 'title',
    kind: 'side',
  }));
  const repairedWang = repairGenealogySequences(wangTitle, { knownMarginTitle: '王氏宗譜' });
  eq('其他书名（王氏宗譜）同样可补齐', [...repairedWang].sort((a, b) => a.cy - b.cy).map((c) => c.text).join(''), '王氏宗譜');

  // 书名与列内容无关时不误改（命中不足 2）
  const mismatched = repairGenealogySequences(wangTitle.map((c) => ({ ...c })), { knownMarginTitle: '陳氏世譜' });
  const mismatchedJoined = [...mismatched].sort((a, b) => a.cy - b.cy).map((c) => c.text ?? '').join('');
  eq('提示书名与列不匹配时不误改', mismatchedJoined, '王氏');

  // 非法/过短提示被归一化丢弃
  eq('单字提示无效', parseMarginTitleHint('倪'), undefined);
  eq('空提示无效', parseMarginTitleHint('  '), undefined);
  eq('null 提示无效', parseMarginTitleHint(null), undefined);
  eq('提示归一化：去空白', parseMarginTitleHint(' 倪氏宗譜 '), '倪氏宗譜');
  eq('提示归一化：剔除非汉字', parseMarginTitleHint('倪氏12宗譜'), '倪氏宗譜');

  const unrelatedTitle = marginTitle.map((char, index) => ({ ...char, id: `other-${index}`, text: index === 0 ? '陳' : null }));
  check('其他四字书名不被强制改写', repairGenealogySequences(unrelatedTitle, { knownMarginTitle: '倪氏宗譜' }).some((c) => c.text === null));
}
section('列尾结构字补位');
{
  const mk = (id, cx, cy, text, conf, extra = {}) => ({
    id, text, cx, cy, bbox: [cx - 10, cy - 10, cx + 10, cy + 10], pt: 12,
    conf, note: text === null ? 'empty' : 'ok', source: 'local', edited: false,
    group: 'body', kind: 'text', ...extra,
  });
  // 三列人名：两列列尾「公」已识别，第三列列尾漏检
  const chars = [
    mk('c1a', 10, 10, '子', 0.9),
    mk('c1tail', 10, 50, '公', 0.92),
    mk('c2a', 40, 10, '孫', 0.9),
    mk('c2tail', 40, 50, '公', 0.9),
    mk('c3a', 70, 10, '曾', 0.9),
    mk('c3tail', 70, 50, null, 0), // 漏检列尾
    // 第四列：列尾是 ≥0.5 的异字，不得覆盖
    mk('c4a', 100, 10, '玄', 0.9),
    mk('c4tail', 100, 50, '松', 0.7),
  ];
  const out = fillColumnStructuralChars(chars);
  const byId = (id) => out.find((c) => c.id === id);
  eq('漏检列尾补「公」', byId('c3tail').text, '公');
  approx('补位置信 0.80', byId('c3tail').conf, DICT_CANDIDATE_CONF);
  eq('≥0.5 异字列尾不覆盖', byId('c4tail').text, '松');
  eq('已识别列尾不动', byId('c1tail').text, '公');
  eq('列中人名位不碰', byId('c3a').text, '曾');
}

section('列尾补位：单证据不触发、人工字不碰、非列尾不碰');
{
  const mk = (id, cx, cy, text, conf, extra = {}) => ({
    id, text, cx, cy, bbox: [cx - 10, cy - 10, cx + 10, cy + 10], pt: 12,
    conf, note: text === null ? 'empty' : 'ok', source: 'local', edited: false,
    group: 'body', kind: 'text', ...extra,
  });
  // 只有一列列尾是「公」→ 证据不足，不补
  const oneTail = [
    mk('a1', 10, 10, '子', 0.9),
    mk('a2', 10, 50, '公', 0.92),
    mk('b1', 40, 10, '孫', 0.9),
    mk('b2', 40, 50, null, 0),
  ];
  const outOne = fillColumnStructuralChars(oneTail);
  eq('仅 1 处「公」列尾时不补位', outOne.find((c) => c.id === 'b2').text, null);

  // 人工确认的漏检列尾不碰（保留用户留空/待定的意图）
  const manualTail = [
    mk('m1', 10, 10, '子', 0.9),
    mk('m2', 10, 50, '公', 0.92),
    mk('m3', 40, 10, '孫', 0.9),
    mk('m4', 40, 50, '公', 0.9),
    mk('m5', 70, 10, '曾', 0.9),
    mk('m6', 70, 50, null, 0, { edited: true, source: 'manual' }),
  ];
  const outManual = fillColumnStructuralChars(manualTail);
  eq('人工字列尾不补', outManual.find((c) => c.id === 'm6').text, null);

  // 「氏」列尾同样生效（妻名列）
  const shi = [
    mk('s1', 10, 10, '王', 0.9),
    mk('s2', 10, 50, '氏', 0.9),
    mk('s3', 40, 10, '李', 0.9),
    mk('s4', 40, 50, '氏', 0.92),
    mk('s5', 70, 10, '趙', 0.9),
    mk('s6', 70, 50, null, 0),
  ];
  const outShi = fillColumnStructuralChars(shi);
  eq('妻名列尾补「氏」', outShi.find((c) => c.id === 's6').text, '氏');

  // 单字列不构成列尾（避免把孤立的空字当列尾补）
  const single = [
    mk('g1', 10, 10, '子', 0.9),
    mk('g2', 10, 50, '公', 0.9),
    mk('g3', 40, 10, '孫', 0.9),
    mk('g4', 40, 50, '公', 0.9),
    mk('lone', 70, 50, null, 0), // 独立一列，长度 1
  ];
  const outSingle = fillColumnStructuralChars(single);
  eq('单字孤立列不参与列尾补位', outSingle.find((c) => c.id === 'lone').text, null);
}

section('列尾补位：人名列「公」不得广播到妻名行');
{
  const mk = (id, cx, cy, text, conf, extra = {}) => ({
    id, text, cx, cy, bbox: [cx - 10, cy - 10, cx + 10, cy + 10], pt: 12,
    conf, note: text === null ? 'empty' : 'ok', source: 'local', edited: false,
    group: 'body', kind: 'text', ...extra,
  });
  // 截图回归：懷德公 / 懷川公 / 懷金公 下方是 周氏 / 江氏 / 楊氏
  const page = [
    mk('hd1', 40, 10, '懷', 0.9), mk('hd2', 40, 40, '德', 0.9), mk('hd3', 40, 70, '公', 0.92),
    mk('zhou', 40, 100, '周', 0.3), mk('zhouShi', 60, 100, null, 0),
    mk('hc1', 100, 10, '懷', 0.9), mk('hc2', 100, 40, '川', 0.9), mk('hc3', 100, 70, '公', 0.9),
    mk('jiang', 100, 100, null, 0), mk('jiangShi', 120, 100, '氏', 0.88),
    mk('hj1', 160, 10, '懷', 0.9), mk('hj2', 160, 40, '金', 0.9), mk('hj3', 160, 70, '公', 0.91),
    mk('yang', 160, 100, '楊', 0.4), mk('yangShi', 180, 100, null, 0),
  ];
  const out = fillColumnStructuralChars(page);
  const byId = (id) => out.find((c) => c.id === id);
  eq('周不被改成公', byId('zhou').text, '周');
  eq('江空位不填公', byId('jiang').text, null);
  eq('楊不被改成公', byId('yang').text, '楊');
  eq('已识别的氏不被动', byId('jiangShi').text, '氏');
  eq('与姓氏成对的空位补氏', byId('zhouShi').text, '氏');
  eq('楊旁空位补氏', byId('yangShi').text, '氏');
}

section('列尾补位：廷公下的金氏不得变成氏公');
{
  const mk = (id, cx, cy, text, conf, extra = {}) => ({
    id, text, cx, cy, bbox: [cx - 10, cy - 10, cx + 10, cy + 10], pt: 12,
    conf, note: text === null ? 'empty' : 'ok', source: 'local', edited: false,
    group: 'body', kind: 'text', ...extra,
  });
  const chars = [
    mk('ting', 10, 10, '廷', 0.9),
    mk('gong', 10, 40, '公', 0.92),
    mk('jin', 10, 70, '金', 0.3),
    mk('shi', 30, 70, '氏', 0.9),
    mk('yi', 70, 10, '儀', 0.9),
    mk('gong2', 70, 40, '公', 0.9),
    mk('hu', 70, 70, '胡', 0.9),
    mk('shi2', 90, 70, '氏', 0.9),
  ];
  const out = fillColumnStructuralChars(chars);
  const byId = (id) => out.find((c) => c.id === id);
  eq('金不被改成公', byId('jin').text, '金');
  eq('氏保持氏', byId('shi').text, '氏');
}

section('列尾补位：同页公尾与氏尾互不抢位');
{
  const mk = (id, cx, cy, text, conf, extra = {}) => ({
    id, text, cx, cy, bbox: [cx - 10, cy - 10, cx + 10, cy + 10], pt: 12,
    conf, note: text === null ? 'empty' : 'ok', source: 'local', edited: false,
    group: 'body', kind: 'text', ...extra,
  });
  const chars = [
    mk('n1', 10, 10, '子', 0.9), mk('n1t', 10, 50, '公', 0.92),
    mk('n2', 40, 10, '孫', 0.9), mk('n2t', 40, 50, '公', 0.9),
    mk('n3', 70, 10, '曾', 0.9), mk('n3t', 70, 50, null, 0),
    mk('w1', 130, 90, '王', 0.9), mk('w1t', 130, 120, '氏', 0.9),
    mk('w2', 160, 90, '李', 0.9), mk('w2t', 160, 120, '氏', 0.92),
    mk('w3', 190, 90, '趙', 0.9), mk('w3t', 190, 120, null, 0),
  ];
  const out = fillColumnStructuralChars(chars);
  const byId = (id) => out.find((c) => c.id === id);
  eq('空的人名尾仍补公', byId('n3t').text, '公');
  eq('空的妻名尾只补氏', byId('w3t').text, '氏');
}

summary('后处理模块测试');
