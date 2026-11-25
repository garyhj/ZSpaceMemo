import { listen } from "@tauri-apps/api/event";
import {
  CheckSquare,
  ExternalLink,
  Pin,
  Plus,
  RefreshCw,
  Search,
  StickyNote as StickyIcon,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type { CreateTaskInput, StickyColor, StickyNote } from "../../types";
import { STICKY_COLORS, STICKY_COLOR_KEYS } from "./stickyColors";

interface Props {
  onConvertToTodo: (input: CreateTaskInput) => Promise<void>;
  onToast: (msg: string) => void;
}

export function StickyBoard({ onConvertToTodo, onToast }: Props) {
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [query, setQuery] = useState("");
  const [colorFilter, setColorFilter] = useState<StickyColor | "all">("all");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function refresh() {
    try {
      const list = await api.listStickyNotes();
      setNotes(list);
    } catch {
      // ignore if category not ready yet
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void refresh();
    const unSync = listen("sticky:synced", () => void refresh());
    const unChg = listen<string>("sticky:changed", (ev) => {
      if (ev.payload !== "main") void refresh();
    });
    return () => {
      void unSync.then((f) => f());
      void unChg.then((f) => f());
    };
  }, []);

  async function handleSync() {
    if (busy) return;
    setBusy(true);
    try {
      await api.initStickyCategory(true);
      await api.syncStickyNotes();
      await refresh();
      onToast("便签同步完成");
    } catch (e) {
      onToast(`便签同步失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(color: StickyColor = "yellow") {
    const tempId = -Date.now();
    const optimistic: StickyNote = {
      id: tempId,
      title: "",
      content: "",
      color,
      pinned: false,
      floating: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      rev: 1,
      etag: "",
    };
    setNotes((prev) => [optimistic, ...prev]);
    try {
      const created = await api.createStickyNote({ title: "新便签", content: "", color });
      setNotes((prev) => prev.map((n) => (n.id === tempId ? created : n)));
    } catch (e) {
      setNotes((prev) => prev.filter((n) => n.id !== tempId));
      onToast(`创建便签失败：${String(e)}`);
    }
  }

  async function handleUpdate(
    id: number,
    patch: { title?: string; content?: string; color?: StickyColor; pinned?: boolean; floating?: boolean }
  ) {
    if (id < 0) return;
    const prev = notes;
    setNotes((cur) => cur.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    try {
      const saved = await api.updateStickyNote(id, patch);
      setNotes((cur) => cur.map((n) => (n.id === id ? saved : n)));
    } catch (e) {
      setNotes(prev);
      onToast(`保存便签失败：${String(e)}`);
    }
  }

  async function handleDelete(note: StickyNote) {
    if (!window.confirm(`确定删除便签「${note.title || "无标题"}」吗？`)) return;
    const prev = notes;
    setNotes((cur) => cur.filter((n) => n.id !== note.id));
    try {
      await api.deleteStickyNote(note.id);
      onToast("已删除便签（已移入极空间「最近删除」）");
    } catch (e) {
      setNotes(prev);
      onToast(`删除便签失败：${String(e)}`);
    }
  }

  async function handlePinDesktop(note: StickyNote) {
    if (note.id < 0) return;
    await api.openStickyWindow(note.id);
    if (!note.floating) {
      await handleUpdate(note.id, { floating: true });
    }
    onToast(`已将「${note.title || "便签"}」钉在桌面`);
  }

  async function handleToTodo(note: StickyNote) {
    const title = (note.title || note.content.split("\n")[0] || "来自便签的待办").trim().slice(0, 80);
    await onConvertToTodo({
      title,
      description: note.content,
      priority: "normal",
    });
    onToast(`已转为待办：「${title}」`);
  }

  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return notes
      .filter((n) => (colorFilter === "all" ? true : n.color === colorFilter))
      .filter((n) => {
        if (!kw) return true;
        return n.title.toLowerCase().includes(kw) || n.content.toLowerCase().includes(kw);
      });
  }, [notes, query, colorFilter]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-white">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">便签</h1>
          <p className="text-[11px] text-slate-400">
            保存在极空间记事本「ZSpace Sticky」分类中，支持多端同步与钉在桌面
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Color filter pills */}
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1">
            <button
              type="button"
              onClick={() => setColorFilter("all")}
              className={`rounded px-1.5 py-0.5 text-[11px] ${
                colorFilter === "all" ? "bg-white font-medium text-blue-600 shadow-2xs" : "text-slate-500"
              }`}
            >
              全部
            </button>
            {STICKY_COLOR_KEYS.map((c) => (
              <button
                key={c}
                type="button"
                title={STICKY_COLORS[c].label}
                onClick={() => setColorFilter((cur) => (cur === c ? "all" : c))}
                style={{ backgroundColor: STICKY_COLORS[c].dot }}
                className={`h-3.5 w-3.5 rounded-full border border-black/10 transition ${
                  colorFilter === c ? "scale-125 ring-2 ring-blue-500 ring-offset-1" : "opacity-75 hover:opacity-100"
                }`}
              />
            ))}
          </div>

          <div className="flex items-center gap-1.5 rounded-lg bg-slate-100/90 px-2.5 py-1 focus-within:bg-white focus-within:ring-1 focus-within:ring-blue-400">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索便签"
              className="w-32 bg-transparent text-xs outline-none placeholder:text-slate-400"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} className="text-slate-400 hover:text-slate-600">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => void handleSync()}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin text-blue-500" : ""}`} />
            {busy ? "同步中" : "同步"}
          </button>

          <button
            type="button"
            onClick={() => void handleCreate(colorFilter === "all" ? "yellow" : colorFilter)}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-2xs hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" />
            新建便签
          </button>
        </div>
      </div>

      {/* Cards Grid */}
      <div className="flex-1 overflow-y-auto bg-slate-50/50 p-5">
        {!loaded ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-48 rounded-2xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
            <StickyIcon className="h-12 w-12 text-slate-200" strokeWidth={1.5} />
            <p className="text-sm">{query ? "没有匹配的便签" : "还没有便签，随手记一条灵感或备忘吧"}</p>
            {!query && (
              <button
                type="button"
                onClick={() => void handleCreate("yellow")}
                className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                + 新建第一张便签
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((note) => (
              <StickyCardItem
                key={note.id}
                note={note}
                onUpdate={handleUpdate}
                onPinDesktop={handlePinDesktop}
                onToTodo={handleToTodo}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StickyCardItem({
  note,
  onUpdate,
  onPinDesktop,
  onToTodo,
  onDelete,
}: {
  note: StickyNote;
  onUpdate: (
    id: number,
    patch: { title?: string; content?: string; color?: StickyColor; pinned?: boolean }
  ) => Promise<void>;
  onPinDesktop: (note: StickyNote) => Promise<void>;
  onToTodo: (note: StickyNote) => Promise<void>;
  onDelete: (note: StickyNote) => Promise<void>;
}) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const theme = STICKY_COLORS[note.color] ?? STICKY_COLORS.yellow;

  useEffect(() => {
    setTitle(note.title);
    setContent(note.content);
  }, [note.id, note.title, note.content]);

  return (
    <div
      className={`group flex h-60 flex-col overflow-hidden rounded-2xl border shadow-xs transition hover:shadow-md ${theme.bg} ${theme.border}`}
    >
      <div className={`flex items-center gap-1.5 px-3 py-2 ${theme.header}`}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title.trim() !== note.title) {
              void onUpdate(note.id, { title: title.trim() });
            }
          }}
          placeholder="无标题便签"
          className="min-w-0 flex-1 bg-transparent text-xs font-semibold text-slate-800 outline-none placeholder:text-slate-400"
        />
        <button
          type="button"
          title={note.pinned ? "取消置顶" : "置顶"}
          onClick={() => void onUpdate(note.id, { pinned: !note.pinned })}
          className={`rounded p-1 transition ${
            note.pinned ? "text-blue-600" : "text-slate-400 opacity-0 hover:text-slate-700 group-hover:opacity-100"
          }`}
        >
          <Pin className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="钉在桌面（独立置顶便利贴）"
          onClick={() => void onPinDesktop(note)}
          className={`rounded p-1 transition ${
            note.floating
              ? "text-blue-600"
              : "text-slate-400 opacity-0 hover:text-blue-600 group-hover:opacity-100"
          }`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onBlur={() => {
          if (content !== note.content) {
            void onUpdate(note.id, { content });
          }
        }}
        placeholder="写点什么…（失去焦点自动同步到极空间）"
        className="flex-1 resize-none bg-transparent p-3 text-xs leading-relaxed text-slate-700 outline-none placeholder:text-slate-400"
      />

      <div className="flex items-center justify-between border-t border-black/5 px-3 py-1.5">
        <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
          {STICKY_COLOR_KEYS.map((c) => (
            <button
              key={c}
              type="button"
              title={STICKY_COLORS[c].label}
              onClick={() => void onUpdate(note.id, { color: c })}
              style={{ backgroundColor: STICKY_COLORS[c].dot }}
              className={`h-3 w-3 rounded-full border border-black/15 ${
                note.color === c ? "ring-1 ring-slate-600 ring-offset-1" : ""
              }`}
            />
          ))}
        </div>

        <div className="flex items-center gap-1 text-[11px] text-slate-500">
          <button
            type="button"
            title="转为待办任务"
            onClick={() => void onToTodo(note)}
            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 opacity-0 transition hover:bg-black/5 hover:text-blue-600 group-hover:opacity-100"
          >
            <CheckSquare className="h-3 w-3" />
            转待办
          </button>
          <button
            type="button"
            title="删除"
            onClick={() => void onDelete(note)}
            className="rounded p-1 opacity-0 transition hover:bg-red-500/10 hover:text-red-600 group-hover:opacity-100"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
