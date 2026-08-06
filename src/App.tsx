/**
 * 顶层视图切换 + 全局对话框（T05 集成收口）。
 * 无 react-router：view 由 projectStore 驱动；深色模式由 settingsStore 驱动。
 */
import { useEffect, useState } from 'react';
import { Moon, Settings, Sun } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { APP_NAME } from '@/lib/constants';
import { isForcedLocal } from '@/privacy/consent';
import { getSessionUploads } from '@/privacy/audit';
import { useProjectStore, type ViewId } from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import { cn } from '@/lib/utils';
import ProjectListPage from '@/ui/ProjectListPage';
import ImportPage from '@/ui/ImportPage';
import AnalyzePage from '@/ui/AnalyzePage';
import EditorPage from '@/ui/EditorPage';
import ExportPage from '@/ui/ExportPage';
import SettingsDialog from '@/ui/SettingsDialog';

const NAV: Array<{ id: ViewId; label: string }> = [
  { id: 'projects', label: '项目' },
  { id: 'import', label: '导入' },
  { id: 'analyze', label: '分析' },
  { id: 'editor', label: '校对' },
  { id: 'export', label: '导出' },
];

export default function App() {
  const { view, setView, currentProjectId, loadFromDB, loaded } = useProjectStore();
  const { darkMode, toggleDarkMode, privacyMode } = useSettingsStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const forcedLocal = isForcedLocal();

  useEffect(() => {
    if (!loaded) void loadFromDB();
  }, [loaded, loadFromDB]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <span className="mr-2 text-lg font-semibold">{APP_NAME}</span>
        <nav className="flex gap-1" aria-label="主导航">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent',
                view === n.id && 'bg-accent font-medium',
                n.id !== 'projects' && !currentProjectId && 'opacity-40',
              )}
            >
              {n.label}
            </button>
          ))}
        </nav>
        {/* P1.2：常驻隐私模式徽号与已上行图片数 */}
        <span className="ml-2 rounded bg-secondary px-2 py-0.5 text-xs text-secondary-foreground" title="当前隐私模式 / 本次会话已上行图片数">
          模式 {forcedLocal ? 'A（已锁定）' : privacyMode} · 上行 {getSessionUploads()} 张
        </span>
        <div className="flex-1" />
        <Button size="icon" variant="ghost" onClick={toggleDarkMode} aria-label="切换深浅色">
          {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <Button size="icon" variant="ghost" onClick={() => setSettingsOpen(true)} aria-label="设置">
          <Settings className="h-4 w-4" />
        </Button>
      </header>

      <main className="min-h-0 flex-1">
        {view === 'projects' && <ProjectListPage />}
        {view === 'import' && <ImportPage />}
        {view === 'analyze' && <AnalyzePage />}
        {view === 'editor' && <EditorPage />}
        {view === 'export' && <ExportPage />}
      </main>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
