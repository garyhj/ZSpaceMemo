import { Clock, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatTime, usePrefs } from "../utils/prefs";
import { AnchoredPopover } from "./AnchoredPopover";

interface Props {
  value: string | null; // "HH:MM" (24h) or null
  disabled?: boolean;
  allowClear?: boolean;
  placeholder?: string;
  onChange: (next: string | null) => void;
}

const QUICK_TIMES = ["09:00", "12:00", "14:00", "18:00", "21:00"];

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"];

/** Smartly normalize user-typed 24h time like "930" -> "09:30", "18" -> "18:00", "9:5" -> "09:05". */
export function normalizeTimeInput(raw: string): string | null {
  let s = raw.trim().replace("：", ":").toLowerCase();
  if (!s) return null;
  let pm: boolean | null = null;
  const pre = s.match(/^(上午|早上|凌晨|中午|下午|晚上)\s*/);
  if (pre) {
    pm = pre[1] === "下午" || pre[1] === "晚上" ? true : pre[1] === "中午" ? null : false;
    if (pre[1] === "中午") pm = true;
    s = s.slice(pre[0].length);
  }
  const suf = s.match(/\s*(am|pm)$/);
  if (suf) {
    pm = suf[1] === "pm";
    s = s.slice(0, s.length - suf[0].length);
  }
  s = s.replace(/点半$/, ":30").replace(/点(\d{1,2})分?$/, ":$1").replace(/点$/, "");
  let h = 0;
  let m = 0;
  if (/^\d{1,2}$/.test(s)) {
    h = Number(s);
    m = 0;
  } else if (/^\d{3,4}$/.test(s)) {
    const padded = s.padStart(4, "0");
    h = Number(padded.slice(0, 2));
    m = Number(padded.slice(2, 4));
  } else if (/^\d{1,2}:\d{1,2}$/.test(s)) {
    const [hs, ms] = s.split(":");
    h = Number(hs);
    m = Number(ms);
  } else {
    return null;
  }
  if (pm === true && h < 12) h += 12;
  if (pm === false && h === 12) h = 0;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function TimePicker({
  value,
  disabled,
  allowClear = true,
  placeholder = "设置时间",
  onChange,
}: Props) {
  const prefs = usePrefs();
  const is12 = prefs.timeFormat === "12h";
  const [open, setRawOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(value ?? "");
  const containerRef = useRef<HTMLDivElement>(null);
  const closedAtRef = useRef(0);

  function setOpen(next: React.SetStateAction<boolean>) {
    setRawOpen((prev) => {
      const val = typeof next === "function" ? next(prev) : next;
      if (val && !prev && Date.now() - closedAtRef.current < 200) return false;
      return val;
    });
  }

  useEffect(() => {
    setText(value ?? "");
  }, [value]);

  const [curH, curM] = (value ?? "18:00").split(":");

  function commitText() {
    if (!text.trim()) {
      if (allowClear) onChange(null);
      else setText(value ?? "09:00");
      return;
    }
    const norm = normalizeTimeInput(text);
    if (norm) {
      setText(norm);
      onChange(norm);
    } else {
      setText(value ?? "");
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div
        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition ${
          disabled
            ? "border-slate-200 bg-slate-50 text-slate-400"
            : open
            ? "border-blue-500 bg-white ring-2 ring-blue-100"
            : "border-slate-200 bg-white hover:border-slate-300"
        }`}
      >
        <Clock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <input
          type="text"
          disabled={disabled}
          value={focused || !is12 ? text : formatTime(value, "12h")}
          placeholder={placeholder}
          onFocus={() => {
            setFocused(true);
            if (!disabled) setOpen(true);
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            setFocused(false);
            commitText();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitText();
              setOpen(false);
            }
            if (e.key === "Escape") {
              setText(value ?? "");
              setOpen(false);
            }
          }}
          className="w-24 bg-transparent font-mono text-xs outline-none disabled:cursor-not-allowed"
        />
        {allowClear && value && !disabled && (
          <button
            type="button"
            title="清除时间"
            onClick={() => {
              setText("");
              onChange(null);
            }}
            className="text-slate-400 hover:text-slate-600"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <AnchoredPopover
        open={Boolean(open && !disabled)}
        onClose={() => {
          closedAtRef.current = Date.now();
          setRawOpen(false);
        }}
        anchorEl={containerRef}
        align="right"
        side="top"
        gap={6}
        onMouseDown={(e) => e.preventDefault()}
        className="w-60 rounded-xl border border-slate-200 bg-white p-2.5 shadow-xl"
      >
        <div className="mb-2 flex flex-wrap gap-1">
          {QUICK_TIMES.map((val) => (
            <button
              key={val}
              type="button"
              onClick={() => {
                onChange(val);
                setText(val);
                setOpen(false);
              }}
              className={`rounded-md px-2 py-0.5 text-[11px] transition ${
                value === val
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-blue-50 hover:text-blue-700"
              }`}
            >
              {formatTime(val, prefs.timeFormat)}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-slate-100 pt-2">
          <div>
            <div className="mb-1 text-center text-[10px] text-slate-400">时</div>
            <div className="max-h-36 overscroll-contain overflow-y-auto space-y-0.5 pr-0.5">
              {HOURS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => {
                    const next = `${h}:${curM || "00"}`;
                    onChange(next);
                    setText(next);
                  }}
                  className={`w-full rounded py-0.5 text-center font-mono text-xs ${
                    curH === h && value
                      ? "bg-blue-600 font-medium text-white"
                      : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {is12 ? formatTime(`${h}:00`, "12h").replace(":00", "") : h}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 text-center text-[10px] text-slate-400">分</div>
            <div className="max-h-36 overscroll-contain overflow-y-auto space-y-0.5 pr-0.5">
              {MINUTES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    const next = `${curH || "09"}:${m}`;
                    onChange(next);
                    setText(next);
                    setOpen(false);
                  }}
                  className={`w-full rounded py-0.5 text-center font-mono text-xs ${
                    curM === m && value
                      ? "bg-blue-600 font-medium text-white"
                      : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>
      </AnchoredPopover>
    </div>
  );
}
