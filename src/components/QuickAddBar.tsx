import { Calendar, Check, Flag, Hash, Plus } from "lucide-react";
import { useRef, useState } from "react";
import type { CreateTaskInput, Priority } from "../types";
import {
  addDays,
  dueLabel,
  nextMonday,
  PRIORITY_META,
  quickParse,
  todayStr,
  type QuickTokenKind,
} from "../utils/date";
import { formatTime, usePrefs } from "../utils/prefs";
import { AnchoredPopover } from "./AnchoredPopover";

interface Props {
  compact?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** Kept for API compatibility; quick add is never blocked by background sync. */
  busy?: boolean;
  lists?: string[];
  onCreate: (input: CreateTaskInput) => Promise<void>;
}

type Popover = "date" | "pri" | "list" | null;

const TOKEN_CLASS: Record<QuickTokenKind, string> = {
  date: "bg-blue-100/80 text-blue-700",
  time: "bg-blue-100/80 text-blue-700",
  pri: "bg-amber-100 text-amber-700",
  list: "bg-emerald-100 text-emerald-700",
};

const PRI_ORDER: Priority[] = ["urgent", "high", "low", "normal"];

/**
 * Dida365-style quick add: a single clean input line. Recognized tokens
 * (明天 / 下午3点 / !高 / #清单) are highlighted in place; date / priority / list
 * can also be picked from small popovers on the right.
 */
export function QuickAddBar({ compact, inputRef, lists = [], onCreate }: Props) {
  const prefs = usePrefs();
  const internalRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? internalRef;
  const mirrorRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const closedPopoverRef = useRef<{ key: Popover; ts: number }>({ key: null, ts: 0 });
  const [raw, setRaw] = useState("");
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [popover, setPopover] = useState<Popover>(null);
  const [defaultDate, setDefaultDate] = useState<string | null>(null);
  const [defaultPri, setDefaultPri] = useState<Priority>("normal");
  const [defaultList, setDefaultList] = useState<string | null>(null);

  const t = todayStr();
  const parsed = quickParse(raw, defaultDate, defaultPri, defaultList);
  const active = focused || raw.length > 0 || popover !== null;

  function togglePopover(next: Exclude<Popover, null>) {
    setPopover((prev) => {
      if (prev === next) return null;
      if (
        prev === null &&
        closedPopoverRef.current.key === next &&
        Date.now() - closedPopoverRef.current.ts < 200
      ) {
        return null;
      }
      return next;
    });
  }

  function syncScroll() {
    if (mirrorRef.current && ref.current) mirrorRef.current.scrollLeft = ref.current.scrollLeft;
  }

  function reset() {
    setRaw("");
    setDefaultDate(null);
    setDefaultPri("normal");
    setDefaultList(null);
    setPopover(null);
  }

  async function submit() {
    if (!parsed.title) return;
    const snapshot = { raw, defaultDate, defaultPri, defaultList };
    const input: CreateTaskInput = {
      title: parsed.title,
      priority: parsed.priority,
      list: parsed.list,
      schedule: {
        all_day: Boolean(parsed.dueDate && !parsed.dueTime),
        due: parsed.dueDate ? { date: parsed.dueDate, time: parsed.dueTime } : null,
        timezone: "Asia/Shanghai",
      },
    };
    reset();
    ref.current?.focus();
    try {
      await onCreate(input);
    } catch {
      // Restore user input on failure.
      setRaw(snapshot.raw);
      setDefaultDate(snapshot.defaultDate);
      setDefaultPri(snapshot.defaultPri);
      setDefaultList(snapshot.defaultList);
    }
  }

  // Build highlighted mirror segments
  const segments: { text: string; kind?: QuickTokenKind }[] = [];
  let cur = 0;
  for (const tk of parsed.tokens) {
    if (tk.start > cur) segments.push({ text: raw.slice(cur, tk.start) });
    segments.push({ text: raw.slice(tk.start, tk.end), kind: tk.kind });
    cur = tk.end;
  }
  if (cur < raw.length) segments.push({ text: raw.slice(cur) });

  const dateChips: [string | null, string][] = [
    [t, "今天"],
    [addDays(t, 1), "明天"],
    [addDays(t, 2), "后天"],
    [nextMonday(), "下周一"],
    [null, "无日期"],
  ];

  const hasMeta =
    Boolean(parsed.dueDate) || parsed.priority !== "normal" || Boolean(parsed.list);

  const iconBtn = (key: Exclude<Popover, null>, on: boolean) =>
    `rounded-md p-1 transition ${
      popover === key
        ? "bg-blue-50 text-blue-600"
        : on
        ? "text-blue-600 hover:bg-slate-100"
        : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
    }`;

  const textCls = `${compact ? "text-[13px]" : "text-sm"} h-6 leading-6 px-0.5 py-0 border-0`;

  return (
    <div ref={rootRef} className="relative">
      <div
        className={`flex items-center gap-1.5 rounded-lg border px-2 transition-colors ${
          compact ? "py-1" : "py-1.5"
        } ${
          active
            ? "border-blue-500 bg-white shadow-[0_0_0_3px_rgba(71,114,250,0.12)]"
            : "border-transparent bg-slate-100/80 hover:bg-slate-100"
        }`}
      >
        <Plus className={`h-4 w-4 shrink-0 ${active ? "text-blue-600" : "text-slate-400"}`} />

        <div className="relative min-w-0 flex-1">
          {/* Mirror layer renders highlighted tokens behind the transparent input text */}
          <div
            ref={mirrorRef}
            aria-hidden
            className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre text-slate-800 ${textCls} ${
              composing ? "opacity-0" : ""
            }`}
          >
            {segments.map((s, i) =>
              s.kind ? (
                <span key={i} className={`rounded-sm ${TOKEN_CLASS[s.kind]}`}>
                  {s.text}
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              )
            )}
          </div>
          <input
            ref={ref}
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              requestAnimationFrame(syncScroll);
            }}
            onScroll={syncScroll}
            onSelect={syncScroll}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(e) => {
              setComposing(false);
              setRaw((e.target as HTMLInputElement).value);
              requestAnimationFrame(syncScroll);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit();
              if (e.key === "Escape") {
                if (popover) setPopover(null);
                else if (raw) reset();
                else ref.current?.blur();
              }
            }}
            placeholder={
              compact ? "添加任务，回车保存" : "添加任务，例如：明天下午3点 交电费 !高 #生活"
            }
            style={{ caretColor: "#191919" }}
            className={`relative w-full bg-transparent outline-none placeholder:text-slate-400 ${
              composing ? "text-slate-800" : "text-transparent"
            } ${textCls}`}
          />
        </div>

        {active && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              title="日期"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => togglePopover("date")}
              className={iconBtn("date", Boolean(parsed.dueDate))}
            >
              <Calendar className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="优先级"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => togglePopover("pri")}
              className={iconBtn("pri", false)}
              style={parsed.priority !== "normal" ? { color: PRIORITY_META[parsed.priority].hex } : undefined}
            >
              <Flag className="h-4 w-4" />
            </button>
            {!compact && (
              <button
                type="button"
                title="清单"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => togglePopover("list")}
                className={iconBtn("list", Boolean(parsed.list))}
              >
                <Hash className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Recognized metadata preview */}
      {raw && hasMeta && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-slate-500 animate-fade-in">
          {parsed.dueDate && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700">
              <Calendar className="h-3 w-3" />
              {dueLabel(parsed.dueDate)}
              {parsed.dueTime ? ` ${formatTime(parsed.dueTime, prefs.timeFormat)}` : ""}
            </span>
          )}
          {parsed.priority !== "normal" && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5"
              style={{
                color: PRIORITY_META[parsed.priority].hex,
                backgroundColor: `${PRIORITY_META[parsed.priority].hex}14`,
              }}
            >
              <Flag className="h-3 w-3" />
              {PRIORITY_META[parsed.priority].label}
            </span>
          )}
          {parsed.list && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">
              <Hash className="h-3 w-3" />
              {parsed.list}
            </span>
          )}
        </div>
      )}

      <AnchoredPopover
        open={Boolean(popover)}
        onClose={() => {
          setPopover((cur) => {
            if (cur) closedPopoverRef.current = { key: cur, ts: Date.now() };
            return null;
          });
        }}
        anchorEl={rootRef}
        align="right"
        side="bottom"
        gap={4}
        onMouseDown={(e) => e.preventDefault()}
        className="w-44 rounded-xl border border-slate-200 bg-white p-1 text-sm shadow-lg"
      >
        {popover === "date" &&
          dateChips.map(([d, label]) => {
            const on = parsed.dueDate === d;
            return (
              <button
                key={label}
                type="button"
                onClick={() => {
                  setDefaultDate(d);
                  setPopover(null);
                  ref.current?.focus();
                }}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] text-slate-700 hover:bg-slate-100"
              >
                <span>{label}</span>
                <span className="flex items-center gap-1 text-[11px] text-slate-400">
                  {d ? dueLabel(d) === label ? "" : dueLabel(d) : ""}
                  {on && <Check className="h-3.5 w-3.5 text-blue-600" />}
                </span>
              </button>
            );
          })}

        {popover === "pri" &&
          PRI_ORDER.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setDefaultPri(p);
                setPopover(null);
                ref.current?.focus();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-slate-700 hover:bg-slate-100"
            >
              <Flag className="h-3.5 w-3.5" style={{ color: PRIORITY_META[p].hex }} />
              <span className="flex-1">{PRIORITY_META[p].label}优先级</span>
              {parsed.priority === p && <Check className="h-3.5 w-3.5 text-blue-600" />}
            </button>
          ))}

        {popover === "list" && (
          <div className="max-h-56 overscroll-contain overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                setDefaultList(null);
                setPopover(null);
                ref.current?.focus();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-slate-500 hover:bg-slate-100"
            >
              <span className="flex-1">不指定清单</span>
              {!parsed.list && <Check className="h-3.5 w-3.5 text-blue-600" />}
            </button>
            {lists.length === 0 && (
              <div className="px-2.5 py-1.5 text-[11px] text-slate-400">
                还没有清单，可在输入框里用 #名称 创建
              </div>
            )}
            {lists.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => {
                  setDefaultList(l);
                  setPopover(null);
                  ref.current?.focus();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-slate-700 hover:bg-slate-100"
              >
                <Hash className="h-3.5 w-3.5 text-slate-400" />
                <span className="flex-1 truncate">{l}</span>
                {parsed.list === l && <Check className="h-3.5 w-3.5 text-blue-600" />}
              </button>
            ))}
          </div>
        )}
      </AnchoredPopover>
    </div>
  );
}
