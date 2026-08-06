/**
 * 低置信字符列表面板（F6.6）：conf < 0.85 逐条列出，Tab 逐条跳转确认，确认后自动跳下一个。
 */
import { useMemo } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
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

  const jumpTo = (index: number) => {
    const c = lowConf[index];
    if (!c) return;
    setLowConfCursor(index);
    setSelection([c.id]);
    // 居中显示（假设画布约 800×600）
    setTransform({ offsetX: 400 - c.cx * transform.scale, offsetY: 300 - c.cy * transform.scale });
  };

  /** 确认当前条：文字无误 → conf 置 1，自动跳下一条 */
  const confirmCurrent = () => {
    const c = lowConf[lowConfCursor];
    if (!c) return;
    apply({
      type: 'char.update',
      charId: c.id,
      before: { conf: c.conf, note: c.note },
      after: { conf: 1, note: 'ok', edited: true },
    });
    const next = Math.min(lowConfCursor, lowConf.length - 2);
    if (lowConf.length > 1) jumpTo(Math.max(0, next));
  };

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
              <button
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent ${
                  i === lowConfCursor ? 'bg-accent' : ''
                }`}
                onClick={() => jumpTo(i)}
              >
                <span className="inline-block w-8 text-center text-lg">{c.text ?? '？'}</span>
                <span className={c.conf < 0.5 ? 'text-destructive' : 'text-amber-600'}>{c.conf.toFixed(2)}</span>
                <span className="text-xs text-muted-foreground">{c.note}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  ({Math.round(c.cx)}, {Math.round(c.cy)})
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t p-2">
        <Button size="sm" className="w-full" onClick={confirmCurrent} disabled={lowConf.length === 0}>
          <CheckCircle2 className="h-4 w-4" /> 确认当前字（文字无误）
        </Button>
      </div>
    </div>
  );
}
