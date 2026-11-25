import { CalendarDays, CheckSquare, StickyNote } from "lucide-react";
import type { ReactNode } from "react";

export type WorkspaceId = "tasks" | "calendar" | "sticky";

export interface ToolboxModuleMeta {
  id: WorkspaceId;
  label: string;
  shortcut: string;
  description: string;
  icon: ReactNode;
}

/**
 * Extensible module registry for ZSpace Kit (极空工具箱).
 * Add future NAS tools (NAS 状态、快传、下载、Docker 等) here so the left rail
 * and keyboard shortcuts stay unified.
 */
export const TOOLBOX_MODULES: ToolboxModuleMeta[] = [
  {
    id: "tasks",
    label: "待办",
    shortcut: "Ctrl/Cmd + 1",
    description: "任务清单与提醒",
    icon: <CheckSquare className="h-5 w-5" />,
  },
  {
    id: "calendar",
    label: "月视图",
    shortcut: "Ctrl/Cmd + 2",
    description: "月历与农历日程",
    icon: <CalendarDays className="h-5 w-5" />,
  },
  {
    id: "sticky",
    label: "便签",
    shortcut: "Ctrl/Cmd + 3",
    description: "极空间云便签与桌面便利贴",
    icon: <StickyNote className="h-5 w-5" />,
  },
];
