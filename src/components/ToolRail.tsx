import { PanelRightOpen } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { TOOLBOX_MODULES, type WorkspaceId } from "../modules/registry";
import type { AppSettings, AuthStatus } from "../types";
import type { ReleaseUpdateInfo } from "../utils/updater";
import { KubaiIcon } from "./KubaiIcon";

interface Props {
  auth: AuthStatus;
  settings: AppSettings | null;
  workspace: WorkspaceId;
  setWorkspace: (id: WorkspaceId) => void;
  updateInfo: ReleaseUpdateInfo | null;
  onOpenSettings: () => void;
}

export function ToolRail({
  auth,
  settings,
  workspace,
  setWorkspace,
  updateInfo,
  onOpenSettings,
}: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <nav className="flex w-14 shrink-0 flex-col items-center border-r border-slate-200 bg-slate-100 py-3 gap-2">
      <div
        title={`ZSpace Kit · 极空工具箱 (${auth.nas_id ?? ""}) · 连接：${
          settings?.connection_mode === "lan"
            ? `LAN 直连 (${settings.lan_host ?? ""})`
            : settings?.connection_mode === "cloud"
            ? "云代理"
            : auth.mode ?? "auto"
        }`}
        className="relative mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-[11px] font-bold tracking-tight text-white shadow-xs"
      >
        ZK
        {settings?.connection_mode === "lan" && (
          <span
            title="LAN 内网直连已开启"
            className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-slate-100"
          />
        )}
      </div>

      {TOOLBOX_MODULES.map((mod) => {
        const active = workspace === mod.id;
        return (
          <button
            key={mod.id}
            type="button"
            title={`${mod.label}（${mod.shortcut}）· ${mod.description}`}
            onClick={() => setWorkspace(mod.id)}
            onMouseEnter={() => setHoveredId(mod.id)}
            onMouseLeave={() => setHoveredId((prev) => (prev === mod.id ? null : prev))}
            className={`flex h-10 w-10 flex-col items-center justify-center rounded-xl transition ${
              active
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-500 hover:bg-slate-200/70"
            }`}
          >
            <KubaiIcon name={mod.id} active={active} hovered={hoveredId === mod.id} size={24} />
          </button>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-2">
        <button
          type="button"
          title={`待办悬浮窗（${settings?.global_shortcut ?? "Ctrl/Cmd+Shift+M"}）`}
          onClick={() => void api.toggleFloatingWindow()}
          className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-200/70"
        >
          <PanelRightOpen className="h-4.5 w-4.5" />
        </button>

        <button
          type="button"
          title={
            updateInfo?.has_update ? `设置 · 发现新版本 v${updateInfo.latest_version}` : "设置"
          }
          onClick={onOpenSettings}
          onMouseEnter={() => setHoveredId("settings")}
          onMouseLeave={() => setHoveredId((prev) => (prev === "settings" ? null : prev))}
          className="relative flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-200/70"
        >
          <KubaiIcon name="settings" hovered={hoveredId === "settings"} size={22} />
          {updateInfo?.has_update && (
            <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-blue-600 ring-2 ring-slate-100" />
          )}
        </button>
      </div>
    </nav>
  );
}
