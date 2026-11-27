import { useEffect, useState, useSyncExternalStore } from "react";
import { ModalDialog } from "./Modal";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

let queue: PendingConfirm[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getCurrent(): PendingConfirm | null {
  return queue[0] ?? null;
}

/**
 * Non-blocking async replacement for `window.confirm()`, backed by native HTML `<dialog>`.
 * Works across both main window and compact floating windows when `<ConfirmDialogHost />` is mounted.
 */
export function confirmAction(opts: ConfirmOptions | string): Promise<boolean> {
  const normalized: ConfirmOptions = typeof opts === "string" ? { message: opts } : opts;
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { ...normalized, resolve }];
    emit();
  });
}

function resolveCurrent(confirmed: boolean) {
  const head = queue[0];
  if (!head) return;
  queue = queue.slice(1);
  emit();
  head.resolve(confirmed);
}

export function ConfirmDialogHost() {
  const current = useSyncExternalStore(subscribe, getCurrent, getCurrent);
  const [focusedBtn, setFocusedBtn] = useState(false);

  useEffect(() => {
    setFocusedBtn(Boolean(current));
  }, [current]);

  if (!current) return null;

  return (
    <ModalDialog
      open
      ariaLabel={current.title ?? "确认操作"}
      onClose={() => resolveCurrent(false)}
      dialogClassName="w-[min(380px,calc(100vw-2rem))]"
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl space-y-3"
    >
      <div className="text-sm font-semibold text-slate-900">{current.title ?? "请确认"}</div>
      <div className="whitespace-pre-line text-xs leading-relaxed text-slate-600">
        {current.message}
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          autoFocus={focusedBtn && Boolean(current.danger)}
          onClick={() => resolveCurrent(false)}
          className="rounded-lg border border-slate-200 px-3.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          {current.cancelText ?? "取消"}
        </button>
        <button
          type="button"
          autoFocus={focusedBtn && !current.danger}
          onClick={() => resolveCurrent(true)}
          className={`rounded-lg px-4 py-1.5 text-xs font-medium text-white ${
            current.danger
              ? "bg-red-600 hover:bg-red-700"
              : "bg-blue-600 hover:bg-blue-700"
          }`}
        >
          {current.confirmText ?? (current.danger ? "确认删除" : "确定")}
        </button>
      </div>
    </ModalDialog>
  );
}
