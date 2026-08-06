/**
 * 导出前前端语法自检（F7.5）：失败则不输出。
 * 检查项：BOM / 括号配对 / 引号闭合 / 缩进（禁 Tab）/ 非法控制字符 / 数据条数守恒。
 */

export interface LintIssue {
  level: 'error' | 'warning';
  message: string;
  line?: number;
}

export interface LintExpected {
  borderRects: number;
  tagRects: number;
  treeLines: number;
  treeNodes: number;
  sideChars: number;
  textChars: number;
  artifacts: number;
}

/** 统计某名称前缀（如 "C0001"）在数据区出现次数（条数守恒校验） */
function countNames(code: string, prefix: string): number {
  const re = new RegExp(`"${prefix}\\d+"`, 'g');
  return (code.match(re) ?? []).length;
}

export function lintScript(code: string, expected?: LintExpected): LintIssue[] {
  const issues: LintIssue[] = [];

  // 1. BOM 与非法字符（F7.1：UTF-8 无 BOM）
  if (code.charCodeAt(0) === 0xfeff) {
    issues.push({ level: 'error', message: '脚本包含 BOM（U+FEFF），必须移除' });
  }
  if (/\r/.test(code)) {
    issues.push({ level: 'error', message: '脚本包含 CR 字符，应统一为 LF 换行' });
  }
  // 控制字符（允许 \n \t，但 Tab 单独报错）
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    if ((c < 0x20 && c !== 0x0a && c !== 0x09) || c === 0x7f) {
      const line = code.slice(0, i).split('\n').length;
      issues.push({ level: 'error', message: `存在非法控制字符 U+${c.toString(16).padStart(4, '0')}`, line });
      break;
    }
  }

  // 2. 逐行检查：Tab 缩进、引号闭合、括号配对（含字符串/注释状态机）
  const stack: Array<{ ch: string; line: number }> = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let inString: '"' | "'" | null = null;
  let inTriple: '"' | "'" | null = null;
  let escaped = false;
  let lineNo = 1;
  let lineStart = true;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\n') {
      lineNo++;
      lineStart = true;
      escaped = false;
      continue;
    }
    if (lineStart) {
      if (ch === '\t') {
        issues.push({ level: 'error', message: '禁止使用 Tab 缩进（PEP8 四空格）', line: lineNo });
      }
      if (ch !== ' ') lineStart = false;
    }
    if (inTriple) {
      if (ch === inTriple && code.slice(i, i + 3) === inTriple.repeat(3)) {
        inTriple = null;
        i += 2;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    // 注释
    if (ch === '#') {
      while (i < code.length && code[i] !== '\n') i++;
      i--; // 让主循环处理换行
      continue;
    }
    // 三引号
    if ((ch === '"' || ch === "'") && code.slice(i, i + 3) === ch.repeat(3)) {
      inTriple = ch;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ ch, line: lineNo });
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack.pop();
      if (!top || top.ch !== pairs[ch]) {
        issues.push({ level: 'error', message: `括号不配对：多余的 "${ch}"`, line: lineNo });
      }
    }
  }
  if (inString) issues.push({ level: 'error', message: `字符串引号未闭合（${inString}）`, line: lineNo });
  if (inTriple) issues.push({ level: 'error', message: '三引号文档字符串未闭合', line: lineNo });
  for (const rest of stack) {
    issues.push({ level: 'error', message: `括号未闭合："${rest.ch}"`, line: rest.line });
  }

  // 3. 七段结构关键锚点
  for (const anchor of ['import scribus', 'haveDoc()', 'def main():', 'main()', 'resolve_font', 'apply_font']) {
    if (!code.includes(anchor)) {
      issues.push({ level: 'error', message: `缺少必要结构锚点：${anchor}` });
    }
  }

  // 4. 数据条数守恒（生成数据 vs 页面数据）
  if (expected) {
    const checks: Array<[string, number, number]> = [
      ['R', countNames(code, 'R'), expected.borderRects],
      ['T', countNames(code, 'T'), expected.tagRects],
      ['L', countNames(code, 'L'), expected.treeLines],
      ['N', countNames(code, 'N'), expected.treeNodes],
      ['S', countNames(code, 'S'), expected.sideChars],
      ['C', countNames(code, 'C'), expected.textChars],
    ];
    const labels: Record<string, string> = {
      R: '外框', T: '装饰块', L: '连线', N: '节点圆', S: '竖排字', C: '正文字符',
    };
    for (const [prefix, actual, want] of checks) {
      if (actual !== want) {
        issues.push({
          level: 'error',
          message: `数据条数不守恒：${labels[prefix]} 期望 ${want} 条，脚本内 ${actual} 条`,
        });
      }
    }
  }

  return issues;
}

export function hasLintError(issues: LintIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
