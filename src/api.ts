import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { ReleaseUpdateInfo } from "./utils/updater";
import type {
  AppSettings,
  AuthStatus,
  CalendarTaskItem,
  CreateStickyInput,
  CreateTaskInput,
  NasDoctorReport,
  NotificationRecord,
  OAuthStartInfo,
  OccurrenceView,
  RepeatRule,
  StickyNote,
  SyncSummary,
  SystemOverview,
  Task,
  TaskSort,
  TaskView,
  UpdateStickyInput,
  UpdateTaskInput,
  UploadBatchSummary,
} from "./types";

export class ApiError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }

  override toString(): string {
    return this.message;
  }
}

function parseInvokeError(err: unknown): ApiError {
  const raw = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown; details?: unknown };
    if (parsed && typeof parsed.code === "string" && typeof parsed.message === "string") {
      return new ApiError(parsed.code, parsed.message, parsed.details);
    }
  } catch {
    // Non-JSON error string
  }
  return new ApiError("UNKNOWN", raw);
}

const AUTH_SKIP_EVENT_CMDS = new Set([
  "start_oauth_login",
  "submit_oauth_code",
  "auth_status",
  "logout",
]);

async function invoke<T>(cmd: string, args?: Parameters<typeof tauriInvoke>[1]): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (err) {
    const apiErr = parseInvokeError(err);
    if (apiErr.code === "NAS_AUTH_REQUIRED" && !AUTH_SKIP_EVENT_CMDS.has(cmd)) {
      window.dispatchEvent(new CustomEvent("zsm:auth-expired", { detail: apiErr.message }));
    }
    throw apiErr;
  }
}

export const api = {
  authStatus: () => invoke<AuthStatus>("auth_status"),
  startOAuthLogin: () => invoke<OAuthStartInfo>("start_oauth_login"),
  submitOAuthCode: (code: string) => invoke<AuthStatus>("submit_oauth_code", { code }),
  logout: () => invoke<void>("logout"),

  getSettings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) => invoke<void>("save_settings", { settings }),
  initializeCategory: (createIfMissing: boolean) =>
    invoke<number>("initialize_category", { createIfMissing }),

  syncTasks: () => invoke<SyncSummary>("sync_tasks"),
  listTasks: (view: TaskView, keyword?: string, sort: TaskSort = "date") =>
    invoke<Task[]>("list_tasks", { view, keyword: keyword || null, sort }),
  listCalendarItems: (from: string, to: string, includeCompleted = true) =>
    invoke<CalendarTaskItem[]>("list_calendar_items", {
      from,
      to,
      includeCompleted,
    }),
  getTask: (id: number, refresh = false) => invoke<Task>("get_task", { id, refresh }),
  createTask: (input: CreateTaskInput) => invoke<Task>("create_task", { input }),
  updateTask: (id: number, patch: UpdateTaskInput) => invoke<Task>("update_task", { id, patch }),
  overrideOccurrence: (
    id: number,
    occurrenceKey: string,
    newDueDate: string,
    newDueTime?: string | null,
    newAllDay?: boolean | null,
    newTitle?: string | null
  ) =>
    invoke<Task>("override_occurrence", {
      id,
      occurrenceKey,
      newDueDate,
      newDueTime: newDueTime ?? null,
      newAllDay: newAllDay ?? null,
      newTitle: newTitle ?? null,
    }),
  clearOccurrenceOverride: (id: number, occurrenceKey: string) =>
    invoke<Task>("clear_occurrence_override", { id, occurrenceKey }),
  completeTask: (id: number, occurrenceKey?: string | null) =>
    invoke<Task>("complete_task", { id, occurrenceKey: occurrenceKey ?? null }),
  skipOccurrence: (id: number, occurrenceKey?: string | null) =>
    invoke<Task>("skip_occurrence", { id, occurrenceKey: occurrenceKey ?? null }),
  reopenTask: (id: number, occurrenceKey?: string | null) =>
    invoke<Task>("reopen_task", { id, occurrenceKey: occurrenceKey ?? null }),
  endSeries: (id: number) => invoke<Task>("end_series", { id }),
  deleteTask: (id: number) => invoke<void>("delete_task", { id }),
  uploadTaskAttachment: (id: number, localPath: string) =>
    invoke<Task>("upload_task_attachment", { id, localPath }),
  downloadTaskAttachment: (id: number, fileId: string, localDest: string) =>
    invoke<void>("download_task_attachment", { id, fileId, localDest }),
  removeTaskAttachment: (id: number, fileId: string) =>
    invoke<Task>("remove_task_attachment", { id, fileId }),

  getOccurrenceTimeline: (id: number, futureCount = 3) =>
    invoke<OccurrenceView[]>("get_occurrence_timeline", { id, futureCount }),
  previewRepeat: (rule: RepeatRule, count = 5) =>
    invoke<{ description: string; dates: string[] }>("preview_repeat", { rule, count }),

  listNotifications: (limit = 50) => invoke<NotificationRecord[]>("list_notifications", { limit }),
  markNotificationRead: (id: number) => invoke<void>("mark_notification_read", { id }),
  snoozeReminder: (
    taskId: number,
    occurrenceKey: string,
    minutes: number,
    title: string,
    body: string
  ) => invoke<string>("snooze_reminder", { taskId, occurrenceKey, minutes, title, body }),

  // OS native notifications
  notificationPermissionState: () =>
    invoke<"granted" | "denied" | "prompt">("notification_permission_state"),
  requestNotificationPermission: () =>
    invoke<"granted" | "denied" | "prompt">("request_notification_permission"),
  sendTestNotification: () => invoke<void>("send_test_notification"),

  // Sticky notes
  initStickyCategory: (createIfMissing = true) =>
    invoke<number>("init_sticky_category", { createIfMissing }),
  syncStickyNotes: () => invoke<number>("sync_sticky_notes"),
  listStickyNotes: (keyword?: string) =>
    invoke<StickyNote[]>("list_sticky_notes", { keyword: keyword || null }),
  getStickyNote: (id: number) => invoke<StickyNote | null>("get_sticky_note", { id }),
  createStickyNote: (input: CreateStickyInput) => invoke<StickyNote>("create_sticky_note", { input }),
  updateStickyNote: (id: number, patch: UpdateStickyInput) =>
    invoke<StickyNote>("update_sticky_note", { id, patch }),
  deleteStickyNote: (id: number) => invoke<void>("delete_sticky_note", { id }),
  openStickyWindow: (id: number) => invoke<void>("open_sticky_window", { id }),
  closeStickyWindow: (id: number) => invoke<void>("close_sticky_window", { id }),

  // ZSpace NAS Toolbox: Files, System + Events, Docker, Downloader
  nasFileSpace: () => invoke<Record<string, unknown>>("nas_file_space"),
  nasFileList: (path: string, start = 0, num = 100) =>
    invoke<Record<string, unknown>>("nas_file_list", { path, start, num }),
  nasSearchFiles: (name: string, filePath?: string | null) =>
    invoke<Record<string, unknown>>("nas_search_files", { name, filePath: filePath ?? null }),
  nasMkdir: (parent: string, name: string) =>
    invoke<Record<string, unknown>>("nas_mkdir", { parent, name }),
  nasUploadFile: (localPath: string, destDir: string, renameOnConflict = true) =>
    invoke<Record<string, unknown>>("nas_upload_file", {
      localPath,
      destDir,
      renameOnConflict,
    }),
  nasUploadPaths: (
    localPaths: string[],
    destDir: string,
    renameOnConflict = true,
    batchId?: string
  ) =>
    invoke<UploadBatchSummary>("nas_upload_paths", {
      localPaths,
      destDir,
      renameOnConflict,
      batchId: batchId ?? null,
    }),
  nasDownloadFile: (nasPath: string, localDest: string) =>
    invoke<Record<string, unknown>>("nas_download_file", { nasPath, localDest }),
  nasDoctor: () => invoke<NasDoctorReport>("nas_doctor"),
  nasSystemOverview: () => invoke<SystemOverview>("nas_system_overview"),
  nasListEvents: (eventType = "", num = 30) =>
    invoke<Record<string, unknown>>("nas_list_events", { eventType, num }),
  nasMarkEventsRead: (ids: string) =>
    invoke<Record<string, unknown>>("nas_mark_events_read", { ids }),
  nasMarkAllEventsRead: () => invoke<Record<string, unknown>>("nas_mark_all_events_read"),
  nasDockerList: () => invoke<Record<string, unknown>>("nas_docker_list"),
  nasDockerStats: () => invoke<Record<string, unknown>>("nas_docker_stats"),
  nasDockerAction: (action: "start" | "stop" | "restart", containerId: string) =>
    invoke<Record<string, unknown>>("nas_docker_action", { action, containerId }),
  nasDockerLogs: (containerId: string) =>
    invoke<Record<string, unknown>>("nas_docker_logs", { containerId }),
  nasDownloadTasks: (taskType: "all" | "loading" | "complete" = "all", start = 0, size = 100) =>
    invoke<Record<string, unknown>>("nas_download_tasks", { taskType, start, size }),
  nasDownloadDirs: () => invoke<Record<string, unknown>>("nas_download_dirs"),
  nasDownloadAdd: (uri: string, dir?: string | null) =>
    invoke<Record<string, unknown>>("nas_download_add", { uri, dir: dir ?? null }),
  nasDownloadAction: (action: "start" | "stop" | "delete", ids: (string | number)[]) =>
    invoke<Record<string, unknown>>("nas_download_action", { action, ids }),

  openMainWindow: (taskId?: number) => invoke<void>("open_main_window", { taskId: taskId ?? null }),
  toggleFloatingWindow: () => invoke<void>("toggle_floating_window"),
  dockFloatingWindow: (edge?: "left" | "right" | "top") =>
    invoke<void>("dock_floating_window", { edge: edge ?? null }),
  peekFloatingWindow: () => invoke<void>("peek_floating_window"),
  collapsePeekFloatingWindow: () => invoke<void>("collapse_peek_floating_window"),
  setFloatingPeekHold: (hold: boolean) => invoke<void>("set_floating_peek_hold", { hold }),
  undockFloatingWindow: () => invoke<void>("undock_floating_window"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  getLogsDir: () => invoke<string>("get_logs_dir"),
  openLogsDir: () => invoke<string>("open_logs_dir"),
  checkAppUpdate: () => invoke<ReleaseUpdateInfo>("check_app_update"),
  installAppUpdate: (
    downloadUrl: string,
    assetName: string,
    expectedSha256?: string | null
  ) =>
    invoke<void>("install_app_update", {
      downloadUrl,
      assetName,
      expectedSha256: expectedSha256 ?? null,
    }),
};
