import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  AuthStatus,
  CalendarTaskItem,
  CreateStickyInput,
  CreateTaskInput,
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
} from "./types";

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
    newDueTime?: string | null
  ) =>
    invoke<Task>("override_occurrence", {
      id,
      occurrenceKey,
      newDueDate,
      newDueTime: newDueTime ?? null,
    }),
  completeTask: (id: number, occurrenceKey?: string | null) =>
    invoke<Task>("complete_task", { id, occurrenceKey: occurrenceKey ?? null }),
  skipOccurrence: (id: number, occurrenceKey?: string | null) =>
    invoke<Task>("skip_occurrence", { id, occurrenceKey: occurrenceKey ?? null }),
  reopenTask: (id: number, occurrenceKey?: string | null) =>
    invoke<Task>("reopen_task", { id, occurrenceKey: occurrenceKey ?? null }),
  endSeries: (id: number) => invoke<Task>("end_series", { id }),
  deleteTask: (id: number) => invoke<void>("delete_task", { id }),

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

  // ZSpace NAS Toolbox: Files, System + Events, Docker
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
  nasDownloadFile: (nasPath: string, localDest: string) =>
    invoke<Record<string, unknown>>("nas_download_file", { nasPath, localDest }),
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

  openMainWindow: (taskId?: number) => invoke<void>("open_main_window", { taskId: taskId ?? null }),
  toggleFloatingWindow: () => invoke<void>("toggle_floating_window"),
  dockFloatingWindow: (edge?: "left" | "right" | "top") =>
    invoke<void>("dock_floating_window", { edge: edge ?? null }),
  peekFloatingWindow: () => invoke<void>("peek_floating_window"),
  collapsePeekFloatingWindow: () => invoke<void>("collapse_peek_floating_window"),
  setFloatingPeekHold: (hold: boolean) => invoke<void>("set_floating_peek_hold", { hold }),
  undockFloatingWindow: () => invoke<void>("undock_floating_window"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
};
