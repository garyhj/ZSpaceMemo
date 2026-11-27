import { getVersion } from "@tauri-apps/api/app";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AppSettings, AuthStatus, ConnectionMode, NasDoctorReport } from "../types";
import { usePrefs } from "../utils/prefs";
import type { ReleaseUpdateInfo, UpdateProgressEvent } from "../utils/updater";
import { ModalDialog } from "./Modal";
import { ConnectionTab } from "./settings/ConnectionTab";
import { GeneralTab } from "./settings/GeneralTab";
import { ShortcutsTab } from "./settings/ShortcutsTab";
import { DEFAULT_GLOBAL_SHORTCUT, Segmented } from "./settings/shared";

interface Props {
  auth: AuthStatus;
  updateInfo?: ReleaseUpdateInfo | null;
  updateProgress?: UpdateProgressEvent | null;
  installingUpdate?: boolean;
  updateError?: string | null;
  onUpdateChecked?: (info: ReleaseUpdateInfo) => void;
  onInstallUpdate?: (info: ReleaseUpdateInfo) => Promise<void>;
  onAuthRefreshed?: (auth: AuthStatus) => void;
  onClose: () => void;
  onLogout: () => Promise<void>;
  onSettingsChanged: (settings: AppSettings) => void;
}

export function SettingsModal({
  auth,
  updateInfo,
  updateProgress,
  installingUpdate = false,
  updateError,
  onUpdateChecked,
  onInstallUpdate,
  onAuthRefreshed,
  onClose,
  onLogout,
  onSettingsChanged,
}: Props) {
  const prefs = usePrefs();
  const [tab, setTab] = useState<"general" | "connection" | "shortcuts">(
    updateInfo?.has_update ? "connection" : "general"
  );
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [notifPerm, setNotifPerm] = useState<"granted" | "denied" | "prompt" | "unknown">("unknown");
  const [appVersion, setAppVersion] = useState("0.8.1");
  const [localUpdate, setLocalUpdate] = useState<ReleaseUpdateInfo | null>(updateInfo ?? null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const [connMode, setConnMode] = useState<ConnectionMode>("auto");
  const [lanHost, setLanHost] = useState("");
  const [allowHttp, setAllowHttp] = useState(false);
  const [cliTimeout, setCliTimeout] = useState(30);
  const [credentialStore, setCredentialStore] = useState<"file" | "auto" | "keyring">("file");
  const [shortcutDraft, setShortcutDraft] = useState(DEFAULT_GLOBAL_SHORTCUT);
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [doctorReport, setDoctorReport] = useState<NasDoctorReport | null>(null);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setLocalUpdate(updateInfo ?? null);
  }, [updateInfo]);

  const syncConnectionDraft = useCallback((cfg: AppSettings) => {
    setConnMode(cfg.connection_mode ?? "auto");
    setLanHost(cfg.lan_host ?? "");
    setAllowHttp(Boolean(cfg.allow_insecure_http));
    setCliTimeout(cfg.cli_timeout_secs ?? 30);
    setCredentialStore(cfg.credential_store ?? "file");
    setShortcutDraft(cfg.global_shortcut ?? DEFAULT_GLOBAL_SHORTCUT);
  }, []);

  const loadInitialSettings = useCallback(() => {
    setLoadError(null);
    api
      .getSettings()
      .then((cfg) => {
        settingsRef.current = cfg;
        setSettings(cfg);
        syncConnectionDraft(cfg);
      })
      .catch((e) => {
        const err = String(e);
        setLoadError(err);
        setMsg(`读取设置失败：${err}`);
      });
  }, [syncConnectionDraft]);

  useEffect(() => {
    loadInitialSettings();
    api
      .notificationPermissionState()
      .then(setNotifPerm)
      .catch(() => setNotifPerm("unknown"));
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, [loadInitialSettings]);

  function handleRequestClose() {
    if (!installingUpdate) onClose();
  }

  function saveSettingsPatch(
    updater: (cur: AppSettings) => AppSettings,
    successMsg = "设置已保存"
  ): Promise<AppSettings | null> {
    const run = async (): Promise<AppSettings | null> => {
      const current = settingsRef.current;
      if (!current) return null;
      const next = updater(current);
      setBusy(true);
      setMsg("");
      try {
        await api.saveSettings(next);
        const refreshed = await api.getSettings().catch(() => next);
        settingsRef.current = refreshed;
        setSettings(refreshed);
        syncConnectionDraft(refreshed);
        onSettingsChanged(refreshed);
        const nextAuth = await api.authStatus().catch(() => null);
        if (nextAuth) onAuthRefreshed?.(nextAuth);
        setMsg(successMsg);
        return refreshed;
      } catch (e) {
        setMsg(`保存失败：${String(e)}`);
        return null;
      } finally {
        setBusy(false);
      }
    };
    const nextTask = saveQueueRef.current.then(run, run);
    saveQueueRef.current = nextTask;
    return nextTask;
  }

  if (!settings) {
    return (
      <ModalDialog
        open
        ariaLabel="设置"
        closeOnEsc={!installingUpdate && !recordingShortcut}
        closeOnBackdrop={!installingUpdate}
        onClose={handleRequestClose}
        dialogClassName="w-[min(28rem,calc(100vw-2rem))]"
        className="flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-base font-semibold text-slate-900">设置</h2>
          <button
            type="button"
            onClick={handleRequestClose}
            aria-label="关闭设置"
            className="rounded-lg p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-6 text-center text-xs text-slate-500 space-y-3">
          {loadError ? (
            <>
              <div className="text-red-500">读取配置失败：{loadError}</div>
              <button
                type="button"
                onClick={loadInitialSettings}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50"
              >
                重试
              </button>
            </>
          ) : (
            <div>正在加载配置…</div>
          )}
        </div>
      </ModalDialog>
    );
  }

  const connDirty =
    connMode !== (settings.connection_mode ?? "auto") ||
    lanHost.trim().replace(/\/+$/, "") !== (settings.lan_host ?? "") ||
    allowHttp !== Boolean(settings.allow_insecure_http) ||
    cliTimeout !== (settings.cli_timeout_secs ?? 30) ||
    credentialStore !== (settings.credential_store ?? "file");

  async function saveConnectionSettings(): Promise<boolean> {
    if (!settingsRef.current) return false;
    const trimmedHost = lanHost.trim();
    if (connMode === "lan" && !trimmedHost) {
      setMsg("请选择并填写内网直连地址（例如 https://192.168.1.2:5056）");
      return false;
    }
    const saved = await saveSettingsPatch(
      (cur) => ({
        ...cur,
        connection_mode: connMode,
        lan_host: trimmedHost || null,
        allow_insecure_http: allowHttp,
        cli_timeout_secs: cliTimeout,
        credential_store: credentialStore,
      }),
      connMode === "lan"
        ? `已启用 LAN 内网直连：${trimmedHost}`
        : connMode === "cloud"
        ? "已切换为云代理模式 (cloud)"
        : "已保存连接与凭据策略"
    );
    return Boolean(saved);
  }

  async function handleDoctor() {
    if (!settingsRef.current) return;
    setDiagnosing(true);
    setMsg("");
    try {
      if (connDirty) {
        const ok = await saveConnectionSettings();
        if (!ok) return;
      }
      const report = await api.nasDoctor();
      setDoctorReport(report);
      const nextAuth = await api.authStatus().catch(() => null);
      if (nextAuth) onAuthRefreshed?.(nextAuth);
      setMsg(
        report.ok
          ? `连接诊断通过（耗时 ${report.latency_ms}ms）`
          : `连接诊断异常：${report.error ?? "请检查网络或直连地址"}`
      );
    } catch (e) {
      setMsg(`诊断失败：${String(e)}`);
    } finally {
      setDiagnosing(false);
    }
  }

  async function handleInitCategory() {
    setBusy(true);
    try {
      const id = await api.initializeCategory(true);
      await api.initStickyCategory(true).catch(() => 0);
      const refreshed = await api.getSettings();
      settingsRef.current = refreshed;
      setSettings(refreshed);
      syncConnectionDraft(refreshed);
      onSettingsChanged(refreshed);
      setMsg(`待办与便签分类已就绪（待办分类 ID: ${id}）`);
    } catch (e) {
      setMsg(`初始化失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleTestNotification() {
    setMsg("");
    try {
      if (notifPerm === "prompt") {
        const next = await api.requestNotificationPermission();
        setNotifPerm(next);
      }
      await api.sendTestNotification();
      setMsg("已发送系统测试通知（若未弹出请检查系统勿扰/专注模式与通知权限）");
    } catch (e) {
      setMsg(`发送系统通知失败：${String(e)}`);
    }
  }

  const permBadge: [string, string] =
    notifPerm === "granted"
      ? ["已允许通知", "text-emerald-600"]
      : notifPerm === "denied"
      ? ["系统权限被拒", "text-red-500"]
      : notifPerm === "prompt"
      ? ["未授权通知", "text-amber-600"]
      : ["系统原生通知", "text-slate-500"];

  const isInsecureHttp = lanHost.trim().toLowerCase().startsWith("http://");

  return (
    <ModalDialog
      open
      ariaLabel="设置"
      closeOnEsc={!installingUpdate && !recordingShortcut}
      closeOnBackdrop={!installingUpdate}
      onClose={handleRequestClose}
      dialogClassName="w-[min(42rem,calc(100vw-2rem))]"
      className="flex max-h-[92vh] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
    >
      {/* Fixed Modal Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-slate-900">设置</h2>
          <Segmented
            value={tab}
            options={[
              ["general", "常规"],
              ["connection", localUpdate?.has_update ? "连接与更新 ●" : "连接与更新"],
              ["shortcuts", "快捷键"],
            ]}
            onChange={(v) => setTab(v as "general" | "connection" | "shortcuts")}
          />
        </div>
        <button
          type="button"
          disabled={installingUpdate}
          title={installingUpdate ? "正在下载/安装更新，请稍候" : "关闭"}
          aria-label="关闭设置"
          onClick={handleRequestClose}
          className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Fixed-Height Content Area (prevents layout jitter across tabs) */}
      <div className="h-[420px] max-h-[calc(92vh-96px)] overscroll-contain overflow-y-auto px-5 py-3.5 [scrollbar-gutter:stable]">
        {tab === "shortcuts" ? (
          <ShortcutsTab
            settings={settings}
            shortcutDraft={shortcutDraft}
            setShortcutDraft={setShortcutDraft}
            recordingShortcut={recordingShortcut}
            setRecordingShortcut={setRecordingShortcut}
            busy={busy}
            setMsg={setMsg}
            saveSettingsPatch={saveSettingsPatch}
          />
        ) : tab === "connection" ? (
          <ConnectionTab
            auth={auth}
            settings={settings}
            connMode={connMode}
            setConnMode={setConnMode}
            lanHost={lanHost}
            setLanHost={setLanHost}
            allowHttp={allowHttp}
            setAllowHttp={setAllowHttp}
            cliTimeout={cliTimeout}
            setCliTimeout={setCliTimeout}
            credentialStore={credentialStore}
            setCredentialStore={setCredentialStore}
            connDirty={connDirty}
            isInsecureHttp={isInsecureHttp}
            busy={busy}
            diagnosing={diagnosing}
            installingUpdate={installingUpdate}
            checkingUpdate={checkingUpdate}
            setCheckingUpdate={setCheckingUpdate}
            appVersion={appVersion}
            localUpdate={localUpdate}
            setLocalUpdate={setLocalUpdate}
            updateProgress={updateProgress}
            updateError={updateError}
            doctorReport={doctorReport}
            setMsg={setMsg}
            saveConnectionSettings={saveConnectionSettings}
            handleDoctor={handleDoctor}
            handleInitCategory={handleInitCategory}
            onLogout={onLogout}
            onUpdateChecked={onUpdateChecked}
            onInstallUpdate={onInstallUpdate}
          />
        ) : (
          <GeneralTab
            settings={settings}
            notifPerm={notifPerm}
            setNotifPerm={setNotifPerm}
            permBadge={permBadge}
            prefs={prefs}
            saveSettingsPatch={saveSettingsPatch}
            handleTestNotification={handleTestNotification}
          />
        )}
      </div>

      {/* Fixed-Height Footer */}
      <div className="flex h-9 shrink-0 items-center justify-between border-t border-slate-100 bg-slate-50/70 px-5 text-xs">
        <span
          className={`truncate ${
            msg.includes("失败") || msg.includes("异常")
              ? "text-red-500"
              : msg
              ? "text-blue-600"
              : "text-slate-400"
          }`}
        >
          {msg || "所有配置实时保存在本地，任务与便签数据源仍在极空间 NAS"}
        </span>
        <button
          type="button"
          onClick={async () => {
            try {
              const dir = await api.openLogsDir();
              setMsg(`已打开日志目录：${dir}`);
            } catch (e) {
              setMsg(`打开日志目录失败：${String(e)}`);
            }
          }}
          className="ml-3 shrink-0 text-[11px] text-slate-500 hover:text-slate-700 hover:underline"
        >
          打开日志目录
        </button>
      </div>
    </ModalDialog>
  );
}
