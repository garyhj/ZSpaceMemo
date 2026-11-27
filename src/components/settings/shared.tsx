export const DEFAULT_GLOBAL_SHORTCUT = "CommandOrControl+Shift+M";

export const SHORTCUT_PRESETS: readonly string[] = [
  "CommandOrControl+Shift+M",
  "Alt+Space",
  "CommandOrControl+Alt+M",
];

export function formatKeyComboFromEvent(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  if (!e.ctrlKey && !e.metaKey && !e.altKey) return null;

  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");

  let key = "";
  if (e.code === "Space") {
    key = "Space";
  } else if (/^Key([A-Z])$/.test(e.code)) {
    key = e.code.slice(3);
  } else if (/^Digit([0-9])$/.test(e.code)) {
    key = e.code.slice(5);
  } else if (/^F([1-9]|1[0-2])$/.test(e.code)) {
    key = e.code;
  } else if (/^[A-Za-z0-9]$/.test(e.key)) {
    key = e.key.toUpperCase();
  }
  if (!key) return null;
  return [...mods, key].join("+");
}

export function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 transition ${
            value === v ? "bg-white font-medium text-blue-600 shadow-xs" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
