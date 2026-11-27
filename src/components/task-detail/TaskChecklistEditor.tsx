import { ListChecks, Plus } from "lucide-react";

interface Props {
  checklistMode: boolean;
  onToggleChecklistMode: () => void;
  richProtected: boolean;
  description: string;
  newCheckItem: string;
  setNewCheckItem: (v: string) => void;
  onDescriptionDraftChange: (nextDesc: string) => void;
  onDescriptionCommit: (nextDesc: string) => void;
  onBlurFlush: () => void;
}

export function TaskChecklistEditor({
  checklistMode,
  onToggleChecklistMode,
  richProtected,
  description,
  newCheckItem,
  setNewCheckItem,
  onDescriptionDraftChange,
  onDescriptionCommit,
  onBlurFlush,
}: Props) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs text-slate-400">
        <span>{checklistMode ? "检查清单（保存在笔记正文中）" : "描述 / 备注"}</span>
        {richProtected ? (
          <span className="text-amber-600">包含官方富文本，已保护只读</span>
        ) : (
          <button
            type="button"
            onClick={onToggleChecklistMode}
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition ${
              checklistMode
                ? "bg-blue-50 text-blue-600 font-medium"
                : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            }`}
          >
            <ListChecks className="h-3.5 w-3.5" />
            {checklistMode ? "切回文本" : "检查清单"}
          </button>
        )}
      </div>

      {checklistMode && !richProtected ? (
        <div className="rounded-xl border border-slate-200 p-2.5 space-y-1.5">
          {description
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .map((line, idx, allLines) => {
              const checked = /^\s*-\s*\[[xX]\]\s+/.test(line);
              const text = line.replace(/^\s*-\s*\[[ xX]\]\s+/, "").replace(/^\s*-\s+/, "");
              return (
                <div key={idx} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const nextLines = [...allLines];
                      nextLines[idx] = `${checked ? "- [ ]" : "- [x]"} ${text}`;
                      onDescriptionCommit(nextLines.join("\n"));
                    }}
                    className="h-3.5 w-3.5 accent-blue-600"
                  />
                  <span className={`flex-1 ${checked ? "line-through text-slate-400" : "text-slate-800"}`}>
                    {text}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const nextDesc = allLines.filter((_, i) => i !== idx).join("\n");
                      onDescriptionCommit(nextDesc);
                    }}
                    className="text-xs text-slate-300 hover:text-red-500"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          <div className="flex items-center gap-1.5 pt-1">
            <Plus className="h-3.5 w-3.5 text-slate-400" />
            <input
              value={newCheckItem}
              onChange={(e) => setNewCheckItem(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newCheckItem.trim()) {
                  const existing = description
                    .split("\n")
                    .filter((l) => l.trim().length > 0);
                  existing.push(`- [ ] ${newCheckItem.trim()}`);
                  setNewCheckItem("");
                  onDescriptionCommit(existing.join("\n"));
                }
              }}
              placeholder="添加检查项，回车保存"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-slate-400"
            />
          </div>
        </div>
      ) : (
        <textarea
          rows={4}
          readOnly={richProtected}
          value={description}
          onChange={(e) => onDescriptionDraftChange(e.target.value)}
          onBlur={onBlurFlush}
          placeholder="添加描述、链接或补充信息…"
          className="w-full resize-y rounded-lg border border-transparent bg-slate-50/60 p-2.5 text-sm outline-none transition focus:border-blue-300 focus:bg-white read-only:bg-slate-50"
        />
      )}
    </div>
  );
}
