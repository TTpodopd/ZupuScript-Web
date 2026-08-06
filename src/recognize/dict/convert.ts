/**
 * 繁简转换工具（懒加载 opencc-js + 内置 mini 表兜底）。
 * 优先动态 import('opencc-js')，失败时回退到内置 mini 转换表。
 * 暴露：initConverter()（异步初始化）、toSimplified/toTraditional/normalizeVariantChar（同步查询）。
 */
import { VARIANT_MAP } from './variants';

let openccReady = false;
let openccFailed = false;
let t2sConverter: ((s: string) => string) | null = null;
let s2tConverter: ((s: string) => string) | null = null;

/** 原始繁→简对（可能有重复，用 Map 去重） */
const _RAW_T2S: Array<[string, string]> = [
  ['張', '张'], ['劉', '刘'], ['陳', '陈'], ['趙', '赵'], ['黃', '黄'],
  ['楊', '杨'], ['鄭', '郑'], ['吳', '吴'], ['許', '许'], ['馮', '冯'],
  ['蔣', '蒋'], ['盧', '卢'], ['蘇', '苏'], ['韓', '韩'], ['蕭', '萧'],
  ['閻', '阎'], ['鍾', '钟'], ['範', '范'], ['餘', '余'], ['龍', '龙'],
  ['葉', '叶'], ['譚', '谭'], ['賴', '赖'], ['龔', '龚'], ['駱', '骆'],
  ['鄒', '邹'], ['萬', '万'], ['羅', '罗'], ['畢', '毕'], ['華', '华'],
  ['顧', '顾'], ['龐', '庞'], ['藍', '蓝'], ['閔', '闵'], ['賈', '贾'],
  ['婁', '娄'], ['顏', '颜'], ['諸', '诸'], ['鈕', '钮'], ['陸', '陆'],
  ['榮', '荣'], ['於', '于'], ['麴', '曲'], ['儲', '储'], ['烏', '乌'],
  ['車', '车'], ['宮', '宫'], ['甯', '宁'], ['欒', '栾'], ['鈄', '钭'],
  ['厲', '厉'], ['薊', '蓟'], ['懷', '怀'], ['從', '从'], ['藺', '蔺'],
  ['喬', '乔'], ['陰', '阴'], ['鬱', '郁'], ['蒼', '苍'], ['雙', '双'],
  ['聞', '闻'], ['黨', '党'], ['貢', '贡'], ['勞', '劳'], ['酈', '郦'],
  ['卻', '却'], ['壽', '寿'], ['邊', '边'], ['農', '农'], ['溫', '温'],
  ['別', '别'], ['莊', '庄'], ['連', '连'], ['習', '习'], ['魚', '鱼'],
  ['終', '终'], ['滿', '满'], ['國', '国'], ['廣', '广'], ['祿', '禄'],
  ['闕', '阙'], ['東', '东'], ['歐', '欧'], ['聶', '聂'], ['簡', '简'],
  ['饒', '饶'], ['養', '养'], ['須', '须'], ['豐', '丰'], ['關', '关'],
  ['後', '后'], ['荊', '荆'], ['紅', '红'], ['遊', '游'], ['鞏', '巩'],
  ['譜', '谱'], ['譜', '谱'], ['譜', '谱'], ['諱', '讳'], ['號', '号'],
  ['遷', '迁'], ['孫', '孙'], ['繼', '继'], ['過', '过'], ['義', '义'],
  ['舉', '举'], ['進', '进'], ['隱', '隐'], ['贈', '赠'], ['誥', '诰'],
  ['選', '选'], ['補', '补'], ['縣', '县'], ['檢', '检'], ['訓', '训'],
  ['導', '导'], ['諭', '谕'], ['學', '学'], ['職', '职'], ['議', '议'],
  ['憲', '宪'], ['資', '资'], ['顯', '显'], ['監', '监'], ['塟', '葬'],
  ['塋', '茔'], ['塚', '冢'], ['緒', '绪'], ['統', '统'], ['慶', '庆'],
  ['順', '顺'], ['歲', '岁'],
  // 异体→简
  ['爲', '为'], ['為', '为'], ['逺', '远'], ['囯', '国'], ['俻', '备'],
  ['尓', '尔'], ['卍', '万'],
];

/** 内置 mini 繁→简转换表（Map 去重后） */
const MINI_T2S: Map<string, string> = new Map(_RAW_T2S);

/** 内置 mini 简→繁转换表（反向，取首个出现） */
const MINI_S2T: Map<string, string> = new Map<string, string>();
for (const [t, s] of MINI_T2S) {
  if (!MINI_S2T.has(s)) MINI_S2T.set(s, t);
}

/** 初始化 opencc-js converter（懒加载，失败后回退内置表） */
export async function initConverter(): Promise<void> {
  if (openccReady || openccFailed) return;
  try {
    const OpenCC = await import('opencc-js');
    t2sConverter = OpenCC.Converter({ from: 'tw', to: 'cn' });
    s2tConverter = OpenCC.Converter({ from: 'cn', to: 'tw' });
    openccReady = true;
  } catch {
    openccFailed = true;
    t2sConverter = null;
    s2tConverter = null;
  }
}

/** 繁体 → 简化字 */
export function toSimplified(ch: string): string {
  if (openccReady && t2sConverter) return t2sConverter(ch);
  if (ch.length === 1) return MINI_T2S.get(ch) ?? ch;
  let result = '';
  for (const c of ch) result += MINI_T2S.get(c) ?? c;
  return result;
}

/** 简化字 → 繁体 */
export function toTraditional(ch: string): string {
  if (openccReady && s2tConverter) return s2tConverter(ch);
  if (ch.length === 1) return MINI_S2T.get(ch) ?? ch;
  let result = '';
  for (const c of ch) result += MINI_S2T.get(c) ?? c;
  return result;
}

/** 异体字归一（→ 规范繁体字） */
export function normalizeVariantChar(ch: string): string {
  return VARIANT_MAP.get(ch) ?? ch;
}

/** 判断 opencc 是否就绪 */
export function isOpenccReady(): boolean {
  return openccReady;
}
