/**
 * 多项目列表（F1.6）：页数、完成度、占用空间、单独删除；.zpproj.json 导入/导出（F1.5）。
 */
import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { estimateUsage, listPagesOfProject, savePage, saveProject } from '@/storage/db';
import { exportProject, importProject } from '@/model/zpproj';
import { useProjectStore } from '@/store/projectStore';
import { downloadText, formatBytes, formatTime } from '@/lib/utils';
import type { PageStatus } from '@/model/types';

const STATUS_ORDER: PageStatus[] = ['imported', 'preprocessed', 'analyzed', 'recognized', 'proofread', 'exported'];

export default function ProjectListPage() {
  const { projects, loadFromDB, createProject, openProject, removeProject, setView, loaded } = useProjectStore();
  const [newName, setNewName] = useState('');
  const [usage, setUsage] = useState<{ usage: number; quota: number }>({ usage: 0, quota: 0 });
  const [pageStats, setPageStats] = useState<Record<string, { count: number; done: number }>>({});
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<'updated' | 'created' | 'name'>('updated');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const visibleProjects = [...projects]
    .filter((project) => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => {
      if (sortMode === 'name') return a.name.localeCompare(b.name, 'zh-CN');
      return sortMode === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt;
    });

  const startRename = (id: string, name: string) => {
    setEditingId(id);
    setEditingName(name);
  };

  const commitRename = (id: string) => {
    const name = editingName.trim();
    if (name) useProjectStore.getState().renameProject(id, name);
    setEditingId(null);
  };

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
          placeholder="请输入项目名称"
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

      {/* 历史项目筛选 */}
      {projects.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索历史项目" aria-label="搜索历史项目" className="pl-9" />
          </div>
          <select value={sortMode} onChange={(e) => setSortMode(e.target.value as typeof sortMode)} className="h-9 rounded-lg border border-input bg-card px-3 text-sm">
            <option value="updated">最近使用</option>
            <option value="created">创建时间</option>
            <option value="name">项目名称</option>
          </select>
          <span className="text-xs text-muted-foreground">共 {visibleProjects.length} 个历史项目</span>
        </div>
      )}

      {/* 项目卡片列表 */}
      <ul className="space-y-3">
        {visibleProjects.map((p) => {
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
                {editingId === p.id ? (
                  <Input
                    value={editingName}
                    autoFocus
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={() => commitRename(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(p.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    className="h-8 max-w-sm"
                    aria-label="编辑项目名称"
                  />
                ) : (
                  <div className="truncate font-medium">{p.name}</div>
                )}
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
                    void openProject(p.id).then(() => {
                      const hasResult = useProjectStore.getState().pages.some((page) => page.chars.length > 0);
                      setView(hasResult ? 'editor' : 'import');
                    });
                  }}
                  className="rounded-lg"
                >
                  <FolderOpen className="h-4 w-4" /> 打开
                </Button>
                <Button size="sm" variant="ghost" onClick={() => startRename(p.id, p.name)} aria-label={`重命名项目 ${p.name}`} className="rounded-lg">
                  <Pencil className="h-4 w-4" />
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
    </div>
  );
}
