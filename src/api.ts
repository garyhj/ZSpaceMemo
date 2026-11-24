import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  AuthStatus,
  CalendarTaskItem,
  CreateTaskInput,
  NotificationRecord,
  OAuthStartInfo,
  OccurrenceView,
  RepeatRule,
  SyncSummary,
  Task,
  TaskSort,
  TaskView,
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

  openMainWindow: (taskId?: number) => invoke<void>("open_main_window", { taskId: taskId ?? null }),
  toggleFloatingWindow: () => invoke<void>("toggle_floating_window"),
  dockFloatingWindow: (edge?: "left" | "right" | "top") =>
    invoke<void>("dock_floating_window", { edge: edge ?? null }),
  undockFloatingWindow: () => invoke<void>("undock_floating_window"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
};
