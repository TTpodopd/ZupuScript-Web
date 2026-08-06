/**
 * 多项目列表（F1.6）：页数、完成度、占用空间、单独删除；.zpproj.json 导入/导出（F1.5）。
 */
import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Plus, Trash2, Upload } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { estimateUsage, listPagesOfProject, savePage, saveProject } from '@/storage/db';
import { exportProject, importProject } from '@/model/zpproj';
import { useProjectStore } from '@/store/projectStore';
import { downloadText, formatBytes, formatTime } from '@/lib/utils';
import type { PageStatus } from '@/model/types';

const STATUS_ORDER: PageStatus[] = ['imported', 'preprocessed', 'analyzed', 'recognized', 'proofread', 'exported'];

function statusLabel(s: PageStatus): string {
  const map: Record<PageStatus, string> = {
    imported: '已导入',
    preprocessed: '已预处理',
    analyzed: '已分析',
    recognized: '已识别',
    proofread: '已校对',
    exported: '已导出',
  };
  return map[s];
}

export default function ProjectListPage() {
  const { projects, loadFromDB, createProject, openProject, removeProject, setView, loaded } = useProjectStore();
  const [newName, setNewName] = useState('');
  const [usage, setUsage] = useState<{ usage: number; quota: number }>({ usage: 0, quota: 0 });
  const [pageStats, setPageStats] = useState<Record<string, { count: number; done: number }>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) void loadFromDB();
    void estimateUsage().then(setUsage);
  }, [loaded, loadFromDB]);

  useEffect(() => {
    void (async () => {
      const stats: Record<string, { count: number; done: number }> = {};
      for (const p of projects) {
        const pages = await listPagesOfProject(p.id);
        stats[p.id] = {
          count: pages.length,
          done: pages.filter((pg) => STATUS_ORDER.indexOf(pg.status) >= STATUS_ORDER.indexOf('proofread')).length,
        };
      }
      setPageStats(stats);
    })();
  }, [projects]);

  const handleCreate = () => {
    const name = newName.trim() || `族谱项目 ${new Date().toLocaleDateString('zh-CN')}`;
    createProject(name);
    setNewName('');
    setView('import');
  };

  const handleImportZpproj = async (file: File) => {
    try {
      const text = await file.text();
      const { project, pages } = await importProject(text);
      await saveProject(project);
      for (const p of pages) await savePage(p);
      await loadFromDB();
      alert(`已导入项目「${project.name}」（${pages.length} 页）。注意：原图不在项目文件内，请重新导入图片以关联。`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '导入失败');
    }
  };

  const handleExportZpproj = async (projectId: string, name: string) => {
    const pages = await listPagesOfProject(projectId);
    downloadText(`${name}.zpproj.json`, exportProject(projects.find((p) => p.id === projectId)!, pages), 'application/json');
  };

  return (
    <div className="mx-auto max-w-3xl p-8">
      {/* 页头 */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-wide">我的项目</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          数据全程保存在本机浏览器，不会上传到任何服务器。
          本地已用 {formatBytes(usage.usage)}{usage.quota > 0 ? ` / ${formatBytes(usage.quota)}` : ''}。
        </p>
      </div>

      {/* 新建项目 */}
      <div className="mb-8 flex gap-2.5">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="新项目名称，如：倪氏族谱 卷三"
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          aria-label="新项目名称"
          className="rounded-xl"
        />
        <Button onClick={handleCreate} className="shrink-0 rounded-xl">
          <Plus className="h-4 w-4" /> 新建项目
        </Button>
        <Button variant="outline" className="shrink-0 rounded-xl" onClick={() => fileRef.current?.click()}>
          <Upload className="h-4 w-4" /> 导入 .zpproj
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.zpproj.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImportZpproj(f);
            e.target.value = '';
          }}
        />
      </div>

      {/* 空状态 */}
      {projects.length === 0 && (
        <div className="rounded-2xl border border-dashed p-16 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/60">
            <FolderOpen className="h-7 w-7 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">
            还没有项目。新建一个，或导入 .zpproj.json 继续之前的工作。
          </p>
        </div>
      )}

      {/* 项目卡片列表 */}
      <ul className="space-y-3">
        {projects.map((p) => {
          const stat = pageStats[p.id];
          const pct = stat && stat.count > 0 ? Math.round((stat.done / stat.count) * 100) : 0;
          return (
            <li
              key={p.id}
              className="group flex items-center gap-4 rounded-2xl border bg-card p-5 card-shadow transition-all duration-200 hover:card-shadow-lg"
            >
              {/* 项目图标 */}
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-lg font-bold text-primary">
                {p.name.charAt(0)}
              </div>

              {/* 信息区 */}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {stat?.count ?? p.pageIds.length} 页 · 完成度 {pct}% · {formatTime(p.updatedAt)}
                </div>
                {stat && stat.count > 0 && (
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
              </div>

              {/* 操作区 */}
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  onClick={() => {
                    void openProject(p.id).then(() => setView('import'));
                  }}
                  className="rounded-lg"
                >
                  <FolderOpen className="h-4 w-4" /> 打开
                </Button>
                <Button size="sm" variant="outline" onClick={() => void handleExportZpproj(p.id, p.name)} className="rounded-lg">
                  <Download className="h-4 w-4" /> 导出
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (confirm(`确定删除项目「${p.name}」？页面数据与本地图像将一并删除。`)) {
                      void removeProject(p.id);
                    }
                  }}
                  className="rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {/* 状态流程 */}
      <div className="mt-8 rounded-xl bg-muted/40 p-4">
        <p className="text-xs text-muted-foreground">
          页面状态流程：{STATUS_ORDER.map(statusLabel).join(' → ')}
        </p>
      </div>
    </div>
  );
}
