/** 测试公共工具：极简断言 + 用例计数 + 最小 Page 样例工厂 */

let passed = 0;
let failed = 0;
const failures = [];

export function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

export function eq(name, actual, expected) {
  const ok = Object.is(actual, expected);
  check(name, ok, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

export function approx(name, actual, expected, tol = 1e-6) {
  check(name, Math.abs(actual - expected) <= tol, `期望 ≈${expected}，实际 ${actual}`);
}

export function section(title) {
  console.log(`\n[${title}]`);
}

export function summary(suiteName) {
  console.log(`\n=== ${suiteName}: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('失败用例: ' + failures.join('; '));
    process.exitCode = 1;
  }
}

let idSeq = 0;
const tid = () => `t-${++idSeq}`;

/** 构造一个最小但元素齐全的 Page 样例（外框/树线/节点/正文字/边栏字/破损笔画） */
export function makeSamplePage() {
  return {
    id: tid(),
    projectId: 'proj-1',
    index: 0,
    status: 'proofread',
    source: { name: 'sample-page.png', page: 1, widthPx: 2000, heightPx: 3000, dpi: 200 },
    calibration: { pxPerMm: 200 / 25.4, pageMm: [254, 381], deskewDeg: 0.3 },
    fontSizes: { body: 10.5, title: 16, pageno: 9, rank: 12 },
    borderRects: [{ id: tid(), x: 100, y: 100, w: 1800, h: 20 }],
    tagRects: [{ id: tid(), x: 900, y: 150, w: 200, h: 60 }],
    treeLines: [
      { id: tid(), x1: 500, y1: 400, x2: 500, y2: 900, widthPx: 3, orientation: 'v' },
      { id: tid(), x1: 500, y1: 900, x2: 900, y2: 900, widthPx: 3, orientation: 'h' },
    ],
    treeNodes: [{ id: tid(), cx: 500, cy: 400, r: 40, strokePx: 2 }],
    chars: [
      {
        id: tid(), text: '張', cx: 500, cy: 400, bbox: [480, 380, 520, 420],
        pt: 10.5, conf: 0.97, note: 'ok', source: 'llm', edited: false, group: 'body', kind: 'text',
      },
      {
        // 看不清的字：text=null，脚本应序列化为 None 并在绘制时跳过
        id: tid(), text: null, cx: 600, cy: 500, bbox: [580, 480, 620, 520],
        pt: 10.5, conf: 0.3, note: 'blurry', source: 'llm', edited: false, group: 'body', kind: 'text',
      },
      {
        id: tid(), text: '卷一', cx: 100, cy: 1500, bbox: [80, 1470, 120, 1530],
        pt: 9, conf: 0.92, note: 'ok', source: 'manual', edited: true, group: 'pageno', kind: 'side',
      },
    ],
    artifacts: [{ id: tid(), x1: 300, y1: 200, x2: 340, y2: 260, widthPx: 2 }],
    imageKey: '',
  };
}

export function makeSampleProject() {
  return { id: 'proj-1', name: '测试族谱', createdAt: 1700000000000, updatedAt: 1700000000000, pageIds: [] };
}
