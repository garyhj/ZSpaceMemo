import { listen } from "@tauri-apps/api/event";
import { CheckSquare, Maximize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { StickyColor, StickyNote } from "../../types";
import { STICKY_COLORS, STICKY_COLOR_KEYS } from "./stickyColors";

/**
 * Independent frameless always-on-top desktop sticky note window (`/?mode=sticky&id=123`).
 */
export function StickyFloatingCard({ noteId }: { noteId: number }) {
  const [note, setNote] = useState<StickyNote | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [savedTip, setSavedTip] = useState("");
  const [dirty, setDirty] = useState(false);
  const timerRef = useRef<number | null>(null);

  async function load() {
    const n = await api.getStickyNote(noteId);
    if (n) {
      setNote(n);
      setTitle(n.title);
      setContent(n.content);
      setDirty(false);
    }
  }

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    void load();

    const unChg = listen<string>("sticky:changed", (ev) => {
      if (ev.payload !== `sticky-${noteId}`) void load();
    });
    const unSync = listen("sticky:synced", () => void load());
    return () => {
      void unChg.then((f) => f());
      void unSync.then((f) => f());
    };
  }, [noteId]);

  useEffect(() => {
    if (!dirty || !note) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setSavedTip("编辑中…");
    timerRef.current = window.setTimeout(() => {
      if (title.trim() !== note.title || content !== note.content) {
        void savePatch({ title: title.trim(), content });
      }
      setDirty(false);
    }, 800);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [dirty, title, content, note?.id]);

  async function savePatch(patch: {
    title?: string;
    content?: string;
    color?: StickyColor;
    floating?: boolean;
  }) {
    if (!note) return;
    setSavedTip("保存中…");
    try {
      const updated = await api.updateStickyNote(note.id, patch);
      setNote(updated);
      setSavedTip("已同步");
      setTimeout(() => setSavedTip(""), 1200);
    } catch {
      setSavedTip("保存失败");
    }
  }

  async function handleUnpinClose() {
    if (note) {
      await api.updateStickyNote(note.id, { floating: false }).catch(() => {});
    }
    await api.closeStickyWindow(noteId);
  }

  async function handleToTodo() {
    if (!note) return;
    const t = (title || content.split("\n")[0] || "桌面便签待办").trim().slice(0, 80);
    await api.createTask({ title: t, description: content, priority: "normal" });
    setSavedTip("已转待办 ✓");
    setTimeout(() => setSavedTip(""), 1500);
  }

  const theme = STICKY_COLORS[note?.color ?? "yellow"] ?? STICKY_COLORS.yellow;

  return (
    <div
      className={`flex h-screen w-screen flex-col overflow-hidden rounded-2xl border shadow-xl ${theme.bg} ${theme.border}`}
    >
      <header className={`flex items-center gap-1.5 px-3 py-2 select-none ${theme.header}`}>
        <div
          data-tauri-drag-region="deep"
          className="flex flex-1 cursor-grab items-center gap-1.5 active:cursor-grabbing"
        >
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: theme.dot }} />
          <span className="truncate text-[11px] font-medium text-slate-600">
            {savedTip || "桌面便签"}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {STICKY_COLOR_KEYS.map((c) => (
            <button
              key={c}
              type="button"
              title={STICKY_COLORS[c].label}
              onClick={() => void savePatch({ color: c })}
              style={{ backgroundColor: STICKY_COLORS[c].dot }}
              className={`h-2.5 w-2.5 rounded-full border border-black/10 ${
                note?.color === c ? "ring-1 ring-slate-600 ring-offset-1" : "opacity-70 hover:opacity-100"
              }`}
            />
          ))}
          <button
            type="button"
            title="转为待办"
            onClick={() => void handleToTodo()}
            className="ml-1 rounded p-1 text-slate-500 hover:bg-black/5 hover:text-blue-600"
          >
            <CheckSquare className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="打开主界面"
            onClick={() => void api.openMainWindow()}
            className="rounded p-1 text-slate-500 hover:bg-black/5"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="从桌面收起"
            onClick={() => void handleUnpinClose()}
            className="rounded p-1 text-slate-500 hover:bg-black/5 hover:text-red-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <input
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          setDirty(true);
        }}
        onBlur={() => {
          if (timerRef.current) window.clearTimeout(timerRef.current);
          setDirty(false);
          if (note && (title.trim() !== note.title || content !== note.content)) {
            void savePatch({ title: title.trim(), content });
          }
        }}
        placeholder="便签标题"
        className="border-b border-black/5 bg-transparent px-3 py-1.5 text-sm font-semibold text-slate-800 outline-none placeholder:text-slate-400"
      />

      <textarea
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setDirty(true);
        }}
        onBlur={() => {
          if (timerRef.current) window.clearTimeout(timerRef.current);
          setDirty(false);
          if (note && (title.trim() !== note.title || content !== note.content)) {
            void savePatch({ title: title.trim(), content });
          }
        }}
        placeholder="随手记点什么…（失去焦点自动同步）"
        className="flex-1 resize-none bg-transparent p-3 text-xs leading-relaxed text-slate-700 outline-none placeholder:text-slate-400"
      />
    </div>
  );
}
