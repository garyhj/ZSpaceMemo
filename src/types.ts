export type Priority = "low" | "normal" | "high" | "urgent";
export type TaskStatus = "pending" | "completed" | "active" | "ended";
export type TaskView =
  | "inbox"
  | "today"
  | "upcoming"
  | "overdue"
  | "all"
  | "completed"
  | "repeating";
export type TaskSort = "date" | "priority" | "created";
export type MetaState = "ok" | "missing" | "recovered" | "conflict";

export interface DateTimePoint {
  date: string; // YYYY-MM-DD
  time?: string | null; // HH:MM
}

export interface Schedule {
  all_day: boolean;
  due?: DateTimePoint | null;
  timezone: string;
}

export type Reminder =
  | {
      type: "relative";
      id: string;
      offset_minutes?: number | null;
      offset_days?: number | null;
      day_time?: string | null;
    }
  | {
      type: "absolute";
      id: string;
      at: string;
    };

export type RepeatFreq = "daily" | "weekly" | "monthly" | "yearly";
export type RepeatEnd =
  | { type: "never" }
  | { type: "until"; until: string }
  | { type: "count"; count: number };

export interface RepeatRule {
  freq: RepeatFreq;
  interval: number;
  calendar?: "gregorian" | "lunar";
  by_weekday?: string[] | null;
  by_set_pos?: number | null;
  by_month_day?: number[] | null;
  by_month?: number[] | null;
  day_filter?: string | null;
  on_invalid_date?: "clamp" | "skip";
  basis?: "schedule" | "completion";
  catch_up?: "latest" | "each";
  end: RepeatEnd;
  dtstart: string;
}

export interface OccurrenceHistoryEntry {
  key: string;
  status: "completed" | "skipped";
  at: string;
}

export interface SeriesState {
  cursor: string;
  overrides?: Record<string, { title?: string; schedule?: Schedule; priority?: Priority }>;
  history: OccurrenceHistoryEntry[];
  ended_at?: string | null;
}

export interface Task {
  id: number;
  title: string;
  description: string;
  rich_body_protected: boolean;
  status: TaskStatus;
  priority: Priority;
  list?: string | null;
  labels: string[];
  pinned: boolean;
  schedule: Schedule;
  reminders: Reminder[];
  repeat?: RepeatRule | null;
  series?: SeriesState | null;
  completed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  source: string;
  meta_state: MetaState;
  rev: number;
  etag: string;
}

export interface OccurrenceView {
  key: string;
  state: "completed" | "skipped" | "missed" | "pending" | "future";
  schedule: Schedule;
  acted_at?: string | null;
}

export interface CalendarTaskItem {
  task_id: number;
  title: string;
  date: string;
  time?: string | null;
  all_day: boolean;
  priority: Priority;
  list?: string | null;
  done: boolean;
  is_repeating: boolean;
  occurrence_key?: string | null;
}

export interface AuthStatus {
  logged_in: boolean;
  nas_id?: string | null;
  expires_at?: number | null;
  profile: string;
  mode?: string | null;
  host?: string | null;
}

export interface OAuthStartInfo {
  url: string;
  expires_in: number;
}

export type ConnectionMode = "auto" | "cloud" | "lan";

export interface AppSettings {
  todo_category_name: string;
  todo_category_id?: number | null;
  timezone: string;
  default_all_day_reminder_time: string;
  upcoming_days: number;
  sync_interval_secs: number;
  show_overdue_in_today: boolean;
  close_to_tray: boolean;
  autostart: boolean;
  default_auto_remind: boolean;
  notification_sound: boolean;
  sticky_category_name: string;
  sticky_category_id?: number | null;
  nas_drop_dir?: string | null;
  bridge_nas_events: boolean;
  connection_mode: ConnectionMode;
  lan_host?: string | null;
  allow_insecure_http: boolean;
  cli_timeout_secs: number;
}

export interface NasDoctorReport {
  ok: boolean;
  configured_mode: string;
  configured_host?: string | null;
  effective_mode?: string | null;
  effective_host?: string | null;
  latency_ms: number;
  details: Record<string, unknown> | null;
  error?: string | null;
}

export interface UploadBatchProgress {
  batch_id: string;
  job_id: string;
  name: string;
  local_path: string;
  dest_dir: string;
  status: "uploading" | "done" | "error";
  error?: string | null;
  current: number;
  total: number;
}

export interface UploadBatchSummary {
  batch_id: string;
  total_files: number;
  succeeded: number;
  failed: number;
  created_dirs: number;
  skipped_count: number;
}

export interface NasEventNotice {
  id: string;
  title: string;
  body: string;
  level: string;
  time: string;
}

export interface SystemOverview {
  system: Record<string, unknown> | null;
  storage: Record<string, unknown> | null;
  disk: Record<string, unknown> | null;
  errors: string[];
}

export type StickyColor = "yellow" | "blue" | "green" | "pink" | "purple" | "white";

export interface StickyNote {
  id: number;
  title: string;
  content: string;
  color: StickyColor;
  pinned: boolean;
  floating: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  rev: number;
  etag: string;
}

export interface CreateStickyInput {
  title?: string;
  content?: string;
  color?: StickyColor;
  pinned?: boolean;
  floating?: boolean;
}

export interface UpdateStickyInput {
  title?: string;
  content?: string;
  color?: StickyColor;
  pinned?: boolean;
  floating?: boolean;
}

export interface SyncSummary {
  total_notes: number;
  fetched_details: number;
  recovered_count: number;
  synced_at: string;
}

export interface NotificationRecord {
  id: number;
  job_key: string;
  task_id: number;
  occurrence_key: string;
  title: string;
  body: string;
  fired_at_utc: string;
  late: boolean;
  read: boolean;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: Priority;
  list?: string | null;
  labels?: string[];
  pinned?: boolean;
  schedule?: Schedule;
  reminders?: Reminder[];
  repeat?: RepeatRule | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: Priority;
  list?: string | null;
  labels?: string[];
  pinned?: boolean;
  schedule?: Schedule;
  reminders?: Reminder[];
  repeat?: RepeatRule | null;
  etag?: string;
  force?: boolean;
}
