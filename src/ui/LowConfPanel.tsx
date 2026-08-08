/**
 * 低置信字符列表面板（F6.6）：conf < 0.85 逐条列出，Tab 逐条跳转确认，确认后自动跳下一个。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Trash2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { CONFIDENCE_THRESHOLD } from '@/lib/constants';
import type { Page } from '@/model/types';
import { useEditorStore } from '@/store/editorStore';

export function useLowConfChars(page: Page | undefined) {
  return useMemo(
    () => (page ? page.chars.filter((c) => (
      c.conf < CONFIDENCE_THRESHOLD
      || c.note === 'split'
      || c.note === 'merge'
      || c.note === 'spacing'
    )) : []),
    [page],
  );
}

const REVIEW_NOTE_LABELS: Partial<Record<Page['chars'][number]['note'], string>> = {
  split: '粘连拆分',
  merge: '断笔合并',
  spacing: '字距异常',
  blurry: '低置信',
  empty: '未识别',
  multi: '多字',
  damaged: '破损',
};

export default function LowConfPanel({ page }: { page: Page }) {
  const lowConf = useLowConfChars(page);
  const {
    lowConfCursor,
    setLowConfCursor,
    setLowConfHoverId,
    lowConfHoverId,
    setSelection,
    centerOnChar,
    apply,
    selectedCharIds,
  } = useEditorStore();
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  /** 画布/操作区选中单字时，右侧列表同步高亮并滚动到对应词条 */
  useEffect(() => {
    if (selectedCharIds.length !== 1) return;
    const index = lowConf.findIndex((c) => c.id === selectedCharIds[0]);
    if (index < 0 || index === lowConfCursor) return;
    setLowConfHoverId(null);
    setLowConfCursor(index);
  }, [selectedCharIds, lowConf, lowConfCursor, setLowConfCursor, setLowConfHoverId]);

  const jumpTo = (index: number) => {
    const c = lowConf[index];
    if (!c) return;
    setLowConfHoverId(null);
    setLowConfCursor(index);
    setSelection([c.id]);
    centerOnChar(c.cx, c.cy);
  };

  const previewAt = (index: number) => {
    const c = lowConf[index];
    if (!c) return;
    setLowConfHoverId(c.id);
  };

  const clearPreview = () => {
    setLowConfHoverId(null);
  };

  useEffect(() => {
    const c = lowConf[lowConfCursor];
    if (!c) return;
    rowRefs.current.get(c.id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [lowConfCursor, lowConf]);

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
      centerOnChar(next.cx, next.cy);
    }
  };

  /** 删除字符，进入撤销栈；自动跳转到相邻条目。 */
  const deleteChar = (c: (typeof lowConf)[number], index: number) => {
    const fallback = lowConf[index + 1] ?? lowConf[index - 1];
    apply({ type: 'char.remove', char: c });
    setEditValues((values) => {
      const nextValues = { ...values };
      delete nextValues[c.id];
      return nextValues;
    });
    if (!fallback) {
      setLowConfCursor(0);
      setSelection([]);
      return;
    }
    const nextIndex = lowConf[index + 1] ? index : Math.max(0, index - 1);
    setLowConfCursor(nextIndex);
    setSelection([fallback.id]);
    centerOnChar(fallback.cx, fallback.cy);
  };

  const current = lowConf[lowConfCursor];

  return (
    <div className="flex h-full flex-col bg-[#f7f5f1]" aria-label="低置信字符面板">
      <header className="shrink-0 border-b border-stone-200/90 bg-stone-100/90 px-3 py-2">
        <div className="text-xs font-semibold text-stone-800">待校对字符（{lowConf.length}）</div>
        <p className="mt-0.5 text-xs leading-snug text-stone-600">Tab 跳转 · 确认后自动跳下一条</p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto" onMouseLeave={clearPreview}>
        {lowConf.length === 0 && (
          <p className="px-3 py-4 text-xs leading-snug text-stone-600">没有低置信字符，可以导出了。</p>
        )}
        <ul className="divide-y divide-stone-200/70">
          {lowConf.map((c, i) => (
            <li
              key={c.id}
              ref={(el) => {
                if (el) rowRefs.current.set(c.id, el);
                else rowRefs.current.delete(c.id);
              }}
            >
              <div
                className={`flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-xs hover:bg-stone-100/80 ${
                  i === lowConfCursor
                    ? 'bg-amber-50/90 ring-1 ring-inset ring-amber-300/70'
                    : c.id === lowConfHoverId
                      ? 'bg-sky-50/80 ring-1 ring-inset ring-sky-300/60'
                      : 'bg-transparent'
                }`}
                onMouseEnter={() => previewAt(i)}
                onClick={() => jumpTo(i)}
                onKeyDown={(e) => e.key === 'Enter' && jumpTo(i)}
                role="button"
                tabIndex={0}
              >
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-stone-200/80 bg-white/80 text-sm font-medium text-stone-800">
                  {c.text ?? '？'}
                </span>
                <span className={`w-9 shrink-0 tabular-nums ${c.conf < 0.5 ? 'text-red-600' : 'text-amber-700'}`}>
                  {c.conf.toFixed(2)}
                </span>
                <span className="hidden min-w-0 flex-1 truncate text-stone-500 sm:inline">
                  {REVIEW_NOTE_LABELS[c.note] ?? c.note}
                </span>
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
                  className="h-8 w-11 shrink-0 px-1 text-center text-xs"
                  aria-label="修改识别字符"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 px-2 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    commitChar(c, i);
                  }}
                  disabled={!(editValues[c.id] ?? c.text)}
                >
                  确认
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteChar(c, i);
                  }}
                  aria-label="删除此字符"
                  title="删除此字符"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
                <span className="hidden shrink-0 tabular-nums text-stone-500 lg:inline">
                  ({Math.round(c.cx)}, {Math.round(c.cy)})
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <footer className="shrink-0 border-t-2 border-stone-300/80 bg-stone-100/60 p-2.5">
        <Button
          size="sm"
          className="h-9 w-full text-xs"
          onClick={() => current && commitChar(current, lowConfCursor)}
          disabled={!current || !(editValues[current.id] ?? current.text)}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          确认当前字（文字无误）
        </Button>
      </footer>
    </div>
  );
}
