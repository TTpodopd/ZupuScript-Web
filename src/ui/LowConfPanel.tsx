/**
 * 低置信字符列表面板（F6.6）：conf < 0.85 逐条列出，Tab 逐条跳转确认，确认后自动跳下一个。
 */
import { useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { CONFIDENCE_THRESHOLD } from '@/lib/constants';
import type { Page } from '@/model/types';
import { useEditorStore } from '@/store/editorStore';

export function useLowConfChars(page: Page | undefined) {
  return useMemo(
    () => (page ? page.chars.filter((c) => c.conf < CONFIDENCE_THRESHOLD) : []),
    [page],
  );
}

export default function LowConfPanel({ page }: { page: Page }) {
  const lowConf = useLowConfChars(page);
  const { lowConfCursor, setLowConfCursor, setSelection, setTransform, transform, apply } = useEditorStore();
  const [editValues, setEditValues] = useState<Record<string, string>>({});

  const jumpTo = (index: number) => {
    const c = lowConf[index];
    if (!c) return;
    setLowConfCursor(index);
    setSelection([c.id]);
    // 居中显示（假设画布约 800×600）
    setTransform({ offsetX: 400 - c.cx * transform.scale, offsetY: 300 - c.cy * transform.scale });
  };

  /** 修改字符并确认，修改进入撤销栈且立即刷新结果画布。 */
  const commitChar = (c: (typeof lowConf)[number], index: number) => {
    if (!c) return;
    const value = (editValues[c.id] ?? c.text ?? '').trim().slice(0, 2);
    if (!value) return;
    apply({
      type: 'char.update',
      charId: c.id,
      before: { text: c.text, conf: c.conf, note: c.note, edited: c.edited, source: c.source },
      after: { text: value, conf: 1, note: 'ok', edited: true, source: 'manual' },
    });
    setEditValues((values) => {
      const nextValues = { ...values };
      delete nextValues[c.id];
      return nextValues;
    });
    const next = lowConf[index + 1] ?? lowConf[index - 1];
    if (next) {
      const nextIndex = lowConf[index + 1] ? index + 1 : Math.max(0, index - 1);
      setLowConfCursor(nextIndex);
      setSelection([next.id]);
      setTransform({ offsetX: 400 - next.cx * transform.scale, offsetY: 300 - next.cy * transform.scale });
    }
  };

  const current = lowConf[lowConfCursor];

  return (
    <div className="flex h-full flex-col" aria-label="低置信字符面板">
      <div className="border-b p-2 text-sm font-medium">
        低置信字符（{lowConf.length}）<span className="ml-1 text-xs text-muted-foreground">Tab 跳转，确认后自动跳下一条</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {lowConf.length === 0 && <p className="p-4 text-sm text-muted-foreground">没有低置信字符，可以导出了。</p>}
        <ul>
          {lowConf.map((c, i) => (
            <li key={c.id}>
              <div
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent ${
                  i === lowConfCursor ? 'bg-accent' : ''
                }`}
              >
                <button className="min-w-0 flex-1 text-left" onClick={() => jumpTo(i)} aria-label={`定位字符 ${c.text ?? '未识别'}`}>
                  <span className="inline-block w-8 text-center text-lg">{c.text ?? '？'}</span>
                </button>
                <span className={c.conf < 0.5 ? 'text-destructive' : 'text-amber-600'}>{c.conf.toFixed(2)}</span>
                <span className="text-xs text-muted-foreground">{c.note}</span>
                <Input
                  value={editValues[c.id] ?? c.text ?? ''}
                  onChange={(e) => setEditValues((values) => ({ ...values, [c.id]: e.target.value }))}
                  onFocus={() => jumpTo(i)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitChar(c, i);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  maxLength={2}
                  className="h-7 w-12 px-1 text-center"
                  aria-label="修改识别字符"
                />
                <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => commitChar(c, i)} disabled={!(editValues[c.id] ?? c.text)}>
                  确认
                </Button>
                <span className="text-xs text-muted-foreground">({Math.round(c.cx)}, {Math.round(c.cy)})</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t p-2">
        <Button size="sm" className="w-full" onClick={() => current && commitChar(current, lowConfCursor)} disabled={!current || !(editValues[current.id] ?? current.text)}>
          <CheckCircle2 className="h-4 w-4" /> 确认当前字（文字无误）
        </Button>
      </div>
    </div>
  );
}
