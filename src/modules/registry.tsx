import { Activity, Box, CalendarDays, CheckSquare, FolderUp, StickyNote } from "lucide-react";
import type { ReactNode } from "react";

export type WorkspaceId = "tasks" | "calendar" | "sticky" | "files" | "nas" | "docker";

export interface ToolboxModuleMeta {
  id: WorkspaceId;
  label: string;
  shortcut: string;
  description: string;
  icon: ReactNode;
}

/**
 * Extensible module registry for ZSpace Kit (极空工具箱).
 */
export const TOOLBOX_MODULES: ToolboxModuleMeta[] = [
  {
    id: "tasks",
    label: "待办",
    shortcut: "Alt + 1",
    description: "任务清单与提醒",
    icon: <CheckSquare className="h-5 w-5" />,
  },
  {
    id: "calendar",
    label: "月视图",
    shortcut: "Alt + 2",
    description: "月历与农历日程",
    icon: <CalendarDays className="h-5 w-5" />,
  },
  {
    id: "sticky",
    label: "便签",
    shortcut: "Alt + 3",
    description: "极空间云便签与桌面便利贴",
    icon: <StickyNote className="h-5 w-5" />,
  },
  {
    id: "files",
    label: "快传箱",
    shortcut: "Alt + 4",
    description: "文件拖拽上传与极速搜索下载",
    icon: <FolderUp className="h-5 w-5" />,
  },
  {
    id: "nas",
    label: "NAS 状态",
    shortcut: "Alt + 5",
    description: "硬件监控、磁盘存储池与 NAS 消息",
    icon: <Activity className="h-5 w-5" />,
  },
  {
    id: "docker",
    label: "Docker",
    shortcut: "Alt + 6",
    description: "容器状态、启停与日志",
    icon: <Box className="h-5 w-5" />,
  },
];
