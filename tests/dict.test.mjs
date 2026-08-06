/** 字典模块测试：姓氏命中、异体映射、繁简转换往返 */
import { check, eq, section, summary } from './helpers.mjs';
import { SURNAMES, isSurnameChar, CONFUSABLE_PAIRS } from '../src/recognize/dict/surnames.ts';
import { GENEALOGY_TERMS, ALL_DICT_CHARS, isDictChar } from '../src/recognize/dict/genealogy.ts';
import { VARIANT_MAP, isVariant, normalizeVariant } from '../src/recognize/dict/variants.ts';
import { toSimplified, toTraditional, normalizeVariantChar } from '../src/recognize/dict/convert.ts';

section('姓氏表完整性');
check('姓氏 ≥ 200 条', SURNAMES.length >= 200);
check('姓氏表含「侯」', SURNAMES.includes('侯'));
check('姓氏表含「張」', SURNAMES.includes('張'));
check('姓氏表含「於」', SURNAMES.includes('於'));
check('姓氏表含「蕭」', SURNAMES.includes('蕭'));
check('易混对 ≥ 10 条', CONFUSABLE_PAIRS.length >= 10);

section('姓氏单字命中');
eq('侯命中姓氏', isSurnameChar('侯'), true);
eq('張命中姓氏', isSurnameChar('張'), true);
eq('趙命中姓氏', isSurnameChar('趙'), true);
eq('X不命中姓氏', isSurnameChar('X'), false);
eq('Q不命中姓氏', isSurnameChar('Q'), false);

section('族谱高频词');
check('高频词 ≥ 100 条', GENEALOGY_TERMS.length >= 100);
check('含「長子」', GENEALOGY_TERMS.includes('長子'));
check('含「庠生」', GENEALOGY_TERMS.includes('庠生'));
check('含「誥授」', GENEALOGY_TERMS.includes('誥授'));
check('含「生於」', GENEALOGY_TERMS.includes('生於'));
check('含「諱」', GENEALOGY_TERMS.includes('諱'));
check('字典字符集 ≥ 250', ALL_DICT_CHARS.size >= 250);
eq('公命中字典', isDictChar('公'), true);
eq('諱命中字典', isDictChar('諱'), true);
eq('X不命中字典', isDictChar('X'), false);

section('异体映射表');
check('异体映射 ≥ 150 条', VARIANT_MAP.size >= 150);
eq('爲→為', normalizeVariant('爲'), '為');
eq('逺→遠', normalizeVariant('逺'), '遠');
eq('囯→國', normalizeVariant('囯'), '國');
eq('尓→爾', normalizeVariant('尓'), '爾');
eq('爲是异体', isVariant('爲'), true);
eq('A不是异体', isVariant('A'), false);
eq('A归一不变', normalizeVariant('A'), 'A');

section('繁简转换（内置 mini 表）');
eq('張→张', toSimplified('張'), '张');
eq('劉→刘', toSimplified('劉'), '刘');
eq('陳→陈', toSimplified('陳'), '陈');
eq('趙→赵', toSimplified('趙'), '赵');
eq('张→張', toTraditional('张'), '張');
eq('刘→劉', toTraditional('刘'), '劉');
eq('陈→陳', toTraditional('陈'), '陳');
eq('未覆盖字原样', toSimplified('X'), 'X');
eq('未覆盖字原样2', toTraditional('X'), 'X');
eq('异体爲归一', normalizeVariantChar('爲'), '為');
eq('异体逺归一', normalizeVariantChar('逺'), '遠');
eq('非异体不变', normalizeVariantChar('A'), 'A');

section('转换往返一致性');
const testChars = ['张', '刘', '陈', '赵', '黄', '杨', '郑', '吴', '许', '邓'];
let roundTripOk = true;
for (const s of testChars) {
  const t = toTraditional(s);
  const back = toSimplified(t);
  if (back !== s) {
    roundTripOk = false;
    console.log(`  往返失败：${s} → ${t} → ${back}`);
  }
}
check('简→繁→简 往返一致', roundTripOk);

summary('字典模块测试');
