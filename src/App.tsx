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
import SettingsDialog from '@/ui/SettingsDialog';

const NAV: Array<{ id: ViewId; label: string }> = [
  { id: 'projects', label: '项目' },
  { id: 'import', label: '开始' },
  { id: 'editor', label: '结果画布' },
];

export default function App() {
  const { view, setView, currentProjectId, loadFromDB, loaded } = useProjectStore();
  const { darkMode, toggleDarkMode, privacyMode } = useSettingsStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const forcedLocal = isForcedLocal();
  const activeView = view === 'export' ? 'editor' : view;

  useEffect(() => {
    if (!loaded) void loadFromDB();
  }, [loaded, loadFromDB]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* 顶栏：宣纸底 + 柔和下边框 */}
      <header className="z-40 flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b bg-card/80 px-3 py-2 backdrop-blur-sm sm:h-16 sm:flex-nowrap sm:gap-3 sm:px-6 sm:py-0">
        {/* 品牌：朱砂印章 + 名称 */}
        <div className="mr-auto flex items-center gap-2.5 sm:mr-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-soft">
            谱
          </div>
          <span className="hidden text-lg font-semibold tracking-wide sm:inline">{APP_NAME}</span>
        </div>

        {/* 导航：胶囊式切换 */}
        <nav className="order-3 flex w-full items-center justify-center gap-0.5 rounded-full bg-muted/60 p-1 sm:order-none sm:w-auto" aria-label="主导航">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={cn(
                'rounded-full px-3 py-1.5 text-sm transition-all duration-200 sm:px-4',
                activeView === n.id
                  ? 'bg-card font-medium text-foreground shadow-soft'
                  : 'text-muted-foreground hover:text-foreground',
                n.id !== 'projects' && !currentProjectId && 'pointer-events-none opacity-40',
              )}
            >
              {n.label}
            </button>
          ))}
        </nav>

        {/* 隐私徽号 */}
        <span
          className="ml-2 hidden rounded-full border bg-secondary/50 px-2.5 py-1 text-xs text-secondary-foreground lg:inline-flex"
          title="当前隐私模式 / 本次会话已上行图片数"
        >
          {forcedLocal ? 'A 锁定' : `模式 ${privacyMode}`} · 上行 {getSessionUploads()}
        </span>

        <div className="hidden flex-1 sm:block" />

        {/* 右侧操作 */}
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={toggleDarkMode} aria-label="切换深浅色" className="rounded-full">
            {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button size="icon" variant="ghost" onClick={() => setSettingsOpen(true)} aria-label="设置" className="rounded-full">
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* 主内容区 */}
      <main className="min-h-0 flex-1 overflow-hidden">
        {activeView === 'projects' && (
          <div className="h-full overflow-y-auto">
            <ProjectListPage />
          </div>
        )}
        {activeView === 'import' && (
          <div className="h-full overflow-y-auto">
            <ImportPage />
          </div>
        )}
        {activeView === 'analyze' && (
          <div className="h-full overflow-y-auto">
            <AnalyzePage />
          </div>
        )}
        {activeView === 'editor' && <EditorPage />}
      </main>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
