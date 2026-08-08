/**
 * 导出预览：纵向分页列表，进入视口时再渲染；Ctrl+滚轮仅缩放预览内容。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Loader2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Slider } from '@/ui/components/ui/slider';
import type { Page } from '@/model/types';
import { renderProofreadPreviewBlob, revokeObjectUrls } from '@/export/proofreadExport';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const DEFAULT_ZOOM = 1;

type PreviewStatus = 'pending' | 'loading' | 'ready' | 'error';

interface PreviewEntry {
  status: PreviewStatus;
  url?: string;
  error?: string;
}

interface PreviewImageProps {
  url: string;
  alt: string;
  zoom: number;
  containerWidth: number;
}

/** 按容器宽度适配后，再乘以 zoom 显示预览图 */
function PreviewImage({ url, alt, zoom, containerWidth }: PreviewImageProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);

  const syncBaseSize = useCallback(() => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    const maxH = Math.round(window.innerHeight * 0.68);
    const fit = Math.min(1, (containerWidth - 24) / img.naturalWidth, maxH / img.naturalHeight);
    setBaseSize({
      w: Math.max(1, Math.round(img.naturalWidth * fit)),
      h: Math.max(1, Math.round(img.naturalHeight * fit)),
    });
  }, [containerWidth]);

  useEffect(() => {
    setBaseSize(null);
  }, [url, containerWidth]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    if (img.complete) syncBaseSize();
    const onLoad = () => syncBaseSize();
    img.addEventListener('load', onLoad);
    return () => img.removeEventListener('load', onLoad);
  }, [url, syncBaseSize]);

  useEffect(() => {
    const onResize = () => syncBaseSize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [syncBaseSize]);

  const displayW = baseSize ? Math.max(1, Math.round(baseSize.w * zoom)) : undefined;
  const displayH = baseSize ? Math.max(1, Math.round(baseSize.h * zoom)) : undefined;

  return (
    <img
      ref={imgRef}
      src={url}
      alt={alt}
      draggable={false}
      onLoad={syncBaseSize}
      className={baseSize ? 'block max-w-none shrink-0 select-none' : 'h-auto max-h-[68vh] w-auto max-w-full shrink-0 object-contain select-none'}
      style={
        displayW && displayH
          ? { width: displayW, height: displayH }
          : undefined
      }
    />
  );
}

interface PageSlotProps {
  page: Page;
  index: number;
  entry: PreviewEntry;
  zoom: number;
  containerWidth: number;
  scrollRoot: RefObject<HTMLDivElement | null>;
  onVisible: (page: Page) => void;
}

function PreviewPageSlot({ page, index, entry, zoom, containerWidth, scrollRoot, onVisible }: PageSlotProps) {
  const slotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = slotRef.current;
    const root = scrollRoot.current;
    if (!el || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((item) => item.isIntersecting)) onVisible(page);
      },
      { root, rootMargin: '120px 0px', threshold: 0.05 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible, page, scrollRoot]);

  return (
    <div ref={slotRef} className="scroll-mt-3 rounded-lg border bg-white shadow-soft">
      <p className="truncate border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        #{index + 1} {page.source.name}
        <span className="ml-2 hidden sm:inline">
          {page.source.widthPx}×{page.source.heightPx} px
        </span>
      </p>
      <div className="flex min-h-[12rem] justify-center overflow-auto p-3">
        {entry.status === 'pending' && (
          <p className="self-center text-xs text-muted-foreground">滚动到此处时将加载预览</p>
        )}
        {entry.status === 'loading' && (
          <Loader2 className="h-6 w-6 animate-spin self-center text-muted-foreground" aria-label={`正在渲染第 ${index + 1} 页`} />
        )}
        {entry.status === 'error' && <p className="self-center text-sm text-destructive">{entry.error ?? '预览生成失败'}</p>}
        {entry.status === 'ready' && entry.url && (
          <div className="inline-block min-w-0">
            <PreviewImage
              url={entry.url}
              alt={`${page.source.name} 校对成果预览`}
              zoom={zoom}
              containerWidth={containerWidth}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export interface ExportPreviewScrollerProps {
  pages: Page[];
  /** 父组件递增，用于取消过期的异步渲染并清空缓存 */
  generation: number;
}

export function ExportPreviewScroller({ pages, generation }: ExportPreviewScrollerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cache, setCache] = useState<Record<string, PreviewEntry>>({});
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [containerWidth, setContainerWidth] = useState(720);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const loadingRef = useRef<Set<string>>(new Set());
  const generationRef = useRef(generation);
  generationRef.current = generation;
  const pageIds = pages.map((item) => item.id).join(',');

  const revokeCache = useCallback((entries: Record<string, PreviewEntry>) => {
    revokeObjectUrls(
      Object.values(entries)
        .map((item) => item.url)
        .filter((url): url is string => Boolean(url)),
    );
  }, []);

  useEffect(() => {
    loadingRef.current.clear();
    setZoom(DEFAULT_ZOOM);
    setCache((prev) => {
      revokeCache(prev);
      return {};
    });
  }, [generation, pageIds, revokeCache]);

  useEffect(() => () => revokeCache(cacheRef.current), [revokeCache]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const syncWidth = () => setContainerWidth(el.clientWidth);
    syncWidth();
    const observer = new ResizeObserver(syncWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const adjustZoom = useCallback((factor: number) => {
    setZoom((current) => clampZoom(current * factor));
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setZoom((current) => clampZoom(current * factor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const ensureLoaded = useCallback(async (page: Page) => {
    const current = cacheRef.current[page.id];
    if (current?.status === 'loading' || current?.status === 'ready') return;
    if (loadingRef.current.has(page.id)) return;

    const gen = generationRef.current;
    loadingRef.current.add(page.id);
    setCache((prev) => ({ ...prev, [page.id]: { status: 'loading' } }));

    try {
      const blob = await renderProofreadPreviewBlob(page);
      if (generationRef.current !== gen) return;
      const url = URL.createObjectURL(blob);
      setCache((prev) => ({ ...prev, [page.id]: { status: 'ready', url } }));
    } catch (error) {
      if (generationRef.current !== gen) return;
      setCache((prev) => ({
        ...prev,
        [page.id]: {
          status: 'error',
          error: error instanceof Error ? error.message : '预览生成失败',
        },
      }));
    } finally {
      loadingRef.current.delete(page.id);
    }
  }, []);

  const handleVisible = useCallback(
    (target: Page) => {
      void ensureLoaded(target);
    },
    [ensureLoaded],
  );

  useEffect(() => {
    if (pages.length === 1) void ensureLoaded(pages[0]!);
  }, [pageIds, pages, ensureLoaded]);

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
        <span className="text-xs text-muted-foreground">预览缩放</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 w-8 rounded-lg p-0"
          aria-label="缩小预览"
          onClick={() => adjustZoom(1 / 1.2)}
          disabled={zoom <= MIN_ZOOM}
        >
          <ZoomOut className="h-4 w-4" />
        </Button>
        <Slider
          className="w-28 sm:w-36"
          min={Math.round(MIN_ZOOM * 100)}
          max={Math.round(MAX_ZOOM * 100)}
          step={5}
          value={[Math.round(zoom * 100)]}
          onValueChange={(values) => setZoom(clampZoom((values[0] ?? 100) / 100))}
          aria-label="预览缩放比例"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 w-8 rounded-lg p-0"
          aria-label="放大预览"
          onClick={() => adjustZoom(1.2)}
          disabled={zoom >= MAX_ZOOM}
        >
          <ZoomIn className="h-4 w-4" />
        </Button>
        <span className="min-w-[3rem] text-xs tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 rounded-lg px-2 text-xs"
          aria-label="重置预览缩放"
          onClick={() => setZoom(DEFAULT_ZOOM)}
          disabled={Math.abs(zoom - DEFAULT_ZOOM) < 0.01}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          重置
        </Button>
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">Ctrl + 滚轮缩放预览内容</span>
      </div>

      <div
        ref={scrollRef}
        className="min-h-[280px] flex-1 space-y-4 overflow-auto rounded-lg border bg-stone-100 p-3"
        aria-label="导出预览分页列表"
      >
        {pages.map((item, index) => (
          <PreviewPageSlot
            key={item.id}
            page={item}
            index={index}
            entry={cache[item.id] ?? { status: 'pending' }}
            zoom={zoom}
            containerWidth={containerWidth}
            scrollRoot={scrollRef}
            onVisible={handleVisible}
          />
        ))}
      </div>
    </div>
  );
}
