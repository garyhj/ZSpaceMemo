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
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [savedTip, setSavedTip] = useState("");

  const timerRef = useRef<number | null>(null);
  const tipTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const dirtyRef = useRef(false);
  const noteRef = useRef<StickyNote | null>(null);
  const draftRef = useRef({ title: "", content: "" });

  function showTip(text: string, autoClearMs = 1200) {
    if (!mountedRef.current) return;
    if (tipTimerRef.current !== null) {
      window.clearTimeout(tipTimerRef.current);
      tipTimerRef.current = null;
    }
    setSavedTip(text);
    if (autoClearMs > 0) {
      tipTimerRef.current = window.setTimeout(() => {
        tipTimerRef.current = null;
        if (mountedRef.current) setSavedTip("");
      }, autoClearMs);
    }
  }

  async function load() {
    try {
      const n = await api.getStickyNote(noteId);
      if (!mountedRef.current) return;
      if (!n) {
        noteRef.current = null;
        setNote(null);
        setLoadState("missing");
        return;
      }
      noteRef.current = n;
      setNote(n);
      setLoadState("ready");
      setLoadError("");
      if (!dirtyRef.current) {
        setTitle(n.title);
        setContent(n.content);
        draftRef.current = { title: n.title, content: n.content };
      }
    } catch (e) {
      if (!mountedRef.current) return;
      if (!noteRef.current) {
        setLoadState("error");
        setLoadError(String(e));
      }
      showTip("加载失败", 2000);
    }
  }

  async function savePatch(patch: {
    title?: string;
    content?: string;
    color?: StickyColor;
    floating?: boolean;
  }): Promise<boolean> {
    const curNote = noteRef.current;
    if (!curNote) return false;
    if (mountedRef.current) setSavedTip("保存中…");
    try {
      const updated = await api.updateStickyNote(curNote.id, patch);
      noteRef.current = updated;
      if (mountedRef.current) setNote(updated);
      const sentTitle = patch.title;
      const sentContent = patch.content;
      if (
        (sentTitle === undefined || draftRef.current.title.trim() === sentTitle) &&
        (sentContent === undefined || draftRef.current.content === sentContent)
      ) {
        dirtyRef.current = false;
      }
      showTip("已同步", 1200);
      return true;
    } catch {
      showTip("保存失败", 2000);
      return false;
    }
  }

  async function flushPending(extra?: { floating?: boolean }): Promise<boolean> {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const curNote = noteRef.current;
    if (!curNote) return false;
    const patch: { title?: string; content?: string; floating?: boolean } = { ...extra };
    const trimmedTitle = draftRef.current.title.trim();
    const nextContent = draftRef.current.content;
    if (dirtyRef.current && (trimmedTitle !== curNote.title || nextContent !== curNote.content)) {
      patch.title = trimmedTitle;
      patch.content = nextContent;
    } else if (dirtyRef.current) {
      dirtyRef.current = false;
    }
    if (Object.keys(patch).length === 0) return true;
    return savePatch(patch);
  }

  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    void flushPending();
  };

  function scheduleSave(nextTitle: string, nextContent: string) {
    draftRef.current = { title: nextTitle, content: nextContent };
    dirtyRef.current = true;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    showTip("编辑中…", 0);
    if (!noteRef.current) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flushRef.current();
    }, 800);
  }

  useEffect(() => {
    mountedRef.current = true;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    void load();

    let disposed = false;
    const unChg = listen<string>("sticky:changed", (ev) => {
      if (ev.payload !== `sticky-${noteId}`) void load();
    });
    const unSync = listen("sticky:synced", () => void load());
    return () => {
      disposed = true;
      mountedRef.current = false;
      if (tipTimerRef.current !== null) {
        window.clearTimeout(tipTimerRef.current);
        tipTimerRef.current = null;
      }
      flushRef.current();
      void unChg.then((f) => {
        if (disposed || true) f();
      });
      void unSync.then((f) => {
        if (disposed || true) f();
      });
    };
  }, [noteId]);

  async function handleUnpinClose() {
    await flushPending({ floating: false }).catch(() => {});
    try {
      await api.closeStickyWindow(noteId);
    } catch {
      showTip("关闭窗口失败", 2000);
    }
  }

  async function handleToTodo() {
    if (!noteRef.current) return;
    const t = (title || content.split("\n")[0] || "桌面便签待办").trim().slice(0, 80);
    try {
      await api.createTask({ title: t, description: content, priority: "normal" });
      showTip("已转待办 ✓", 1500);
    } catch {
      showTip("转待办失败", 2000);
    }
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
          {note &&
            STICKY_COLOR_KEYS.map((c) => (
              <button
                key={c}
                type="button"
                title={STICKY_COLORS[c].label}
                onClick={() => void savePatch({ color: c })}
                style={{ backgroundColor: STICKY_COLORS[c].dot }}
                className={`h-2.5 w-2.5 rounded-full border border-black/10 ${
                  note.color === c ? "ring-1 ring-slate-600 ring-offset-1" : "opacity-70 hover:opacity-100"
                }`}
              />
            ))}
          {note && (
            <button
              type="button"
              title="转为待办"
              onClick={() => void handleToTodo()}
              className="ml-1 rounded p-1 text-slate-500 hover:bg-black/5 hover:text-blue-600"
            >
              <CheckSquare className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            title="打开主界面"
            onClick={() => void api.openMainWindow().catch(() => {})}
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

      {loadState === "missing" || loadState === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-slate-500">
          <div>
            {loadState === "missing"
              ? `便签 #${noteId} 不存在或已被删除`
              : `加载便签失败：${loadError || "请检查同步状态"}`}
          </div>
          <div className="flex items-center gap-2">
            {loadState === "error" && (
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-slate-700 hover:bg-slate-50"
              >
                重试
              </button>
            )}
            <button
              type="button"
              onClick={() => void api.closeStickyWindow(noteId).catch(() => {})}
              className="rounded-lg bg-slate-800 px-2.5 py-1 text-white hover:bg-slate-700"
            >
              关闭窗口
            </button>
          </div>
        </div>
      ) : (
        <>
          <input
            value={title}
            disabled={!note}
            onChange={(e) => {
              const val = e.target.value;
              setTitle(val);
              scheduleSave(val, content);
            }}
            onBlur={() => {
              void flushPending();
            }}
            placeholder="便签标题"
            className="border-b border-black/5 bg-transparent px-3 py-1.5 text-sm font-semibold text-slate-800 outline-none placeholder:text-slate-400 disabled:opacity-60"
          />

          <textarea
            value={content}
            disabled={!note}
            onChange={(e) => {
              const val = e.target.value;
              setContent(val);
              scheduleSave(title, val);
            }}
            onBlur={() => {
              void flushPending();
            }}
            placeholder="随手记点什么…（失去焦点自动同步）"
            className="flex-1 resize-none bg-transparent p-3 text-xs leading-relaxed text-slate-700 outline-none placeholder:text-slate-400 disabled:opacity-60"
          />
        </>
      )}
    </div>
  );
}
