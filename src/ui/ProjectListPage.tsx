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
    // 统计每个项目的页数与完成度
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
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-1 text-xl font-semibold">我的项目</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        数据全程保存在本机浏览器（IndexedDB / OPFS），不会上传到任何服务器。
        本地已用 {formatBytes(usage.usage)}{usage.quota > 0 ? ` / 配额 ${formatBytes(usage.quota)}` : ''}。
      </p>

      <div className="mb-6 flex gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="新项目名称，如：倪氏族谱 卷三"
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          aria-label="新项目名称"
        />
        <Button onClick={handleCreate} className="shrink-0">
          <Plus className="h-4 w-4" /> 新建项目
        </Button>
        <Button variant="outline" className="shrink-0" onClick={() => fileRef.current?.click()}>
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

      {projects.length === 0 && (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          还没有项目。新建一个，或导入 .zpproj.json 继续之前的工作。
        </div>
      )}

      <ul className="space-y-2">
        {projects.map((p) => {
          const stat = pageStats[p.id];
          const pct = stat && stat.count > 0 ? Math.round((stat.done / stat.count) * 100) : 0;
          return (
            <li key={p.id} className="flex items-center gap-3 rounded-lg border bg-card p-4">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.name}</div>
                <div className="text-xs text-muted-foreground">
                  {stat?.count ?? p.pageIds.length} 页 · 完成度 {pct}% · 更新于 {formatTime(p.updatedAt)}
                </div>
                {stat && stat.count > 0 && (
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                    <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              <Button
                size="sm"
                onClick={() => {
                  void openProject(p.id).then(() => setView('import'));
                }}
              >
                <FolderOpen className="h-4 w-4" /> 打开
              </Button>
              <Button size="sm" variant="outline" onClick={() => void handleExportZpproj(p.id, p.name)}>
                <Download className="h-4 w-4" /> 导出
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  if (confirm(`确定删除项目「${p.name}」？页面数据与本地图像将一并删除。`)) {
                    void removeProject(p.id);
                  }
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          );
        })}
      </ul>

      <p className="mt-6 text-xs text-muted-foreground">
        页面状态流程：{STATUS_ORDER.map(statusLabel).join(' → ')}
      </p>
    </div>
  );
}
