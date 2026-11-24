import { Calendar, Flag } from "lucide-react";
import { useRef, useState } from "react";
import type { CreateTaskInput, Priority } from "../types";
import { addDays, dateLabel, nextMonday, PRIORITY_META, quickParse, todayStr } from "../utils/date";

interface Props {
  compact?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  busy?: boolean;
  onCreate: (input: CreateTaskInput) => Promise<void>;
}

export function QuickAddBar({ compact, inputRef, busy, onCreate }: Props) {
  const internalRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? internalRef;
  const [raw, setRaw] = useState("");
  const [defaultDate, setDefaultDate] = useState<string | null>(null);
  const [defaultPri, setDefaultPri] = useState<Priority>("normal");

  const t = todayStr();
  const parsed = quickParse(raw, defaultDate, defaultPri);

  async function submit() {
    if (!parsed.title || busy) return;
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
    try {
      await onCreate(input);
      setRaw("");
      setDefaultDate(null);
      setDefaultPri("normal");
      ref.current?.focus();
    } catch {
      // Preserve input on failure per spec.
    }
  }

  const dateChips: [string | null, string][] = [
    [null, "无日期"],
    [t, "今天"],
    [addDays(t, 1), "明天"],
    [addDays(t, 2), "后天"],
    [nextMonday(), "下周一"],
  ];

  const priKeys: Priority[] = ["low", "normal", "high", "urgent"];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2 shadow-xs">
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder={
            compact
              ? "＋ 快速添加（回车创建，支持 明天 18:00 !高 #清单）"
              : "＋ 添加任务，回车创建（试试：明天 18:00 续费 eSIM !高 #个人）"
          }
          className="flex-1 bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-slate-400"
        />
        <button
          type="button"
          disabled={busy || !parsed.title}
          onClick={() => void submit()}
          className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          添加
        </button>
      </div>

      {raw.trim() && (
        <div className="mt-1 px-1.5 text-[11px] text-slate-500">
          {parsed.dueDate || parsed.priority !== "normal" || parsed.list ? (
            <span>
              识别到：
              {parsed.dueDate && (
                <span className="mr-2 text-blue-600">
                  📅 {dateLabel(parsed.dueDate)} {parsed.dueTime ?? ""}
                </span>
              )}
              {parsed.priority !== "normal" && (
                <span className={`mr-2 ${PRIORITY_META[parsed.priority].colorClass}`}>
                  🚩 {PRIORITY_META[parsed.priority].label}
                </span>
              )}
              {parsed.list && <span className="text-slate-700">🗂 {parsed.list}</span>}
            </span>
          ) : (
            <span>→ 将放入收集箱</span>
          )}
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-1 px-1">
        <Calendar className="h-3.5 w-3.5 text-slate-400 mr-0.5" />
        {dateChips.map(([d, label]) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              setDefaultDate(d);
              ref.current?.focus();
            }}
            className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
              defaultDate === d
                ? "border-transparent bg-blue-600 text-white"
                : "border-slate-200 text-slate-600 hover:bg-slate-100"
            }`}
          >
            {label}
          </button>
        ))}

        {!compact && (
          <>
            <Flag className="h-3.5 w-3.5 text-slate-400 ml-2 mr-0.5" />
            {priKeys.map((pk) => (
              <button
                key={pk}
                type="button"
                onClick={() => {
                  setDefaultPri(pk);
                  ref.current?.focus();
                }}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
                  defaultPri === pk
                    ? "border-transparent bg-blue-600 text-white"
                    : "border-slate-200 text-slate-600 hover:bg-slate-100"
                }`}
              >
                {PRIORITY_META[pk].label}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
