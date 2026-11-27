import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

interface Props {
  open?: boolean;
  ariaLabel?: string;
  closeOnEsc?: boolean;
  closeOnBackdrop?: boolean;
  onClose: () => void;
  /** Width & outer sizing applied directly to the <dialog> box (e.g. "w-[min(360px,calc(100vw-2rem))]"). */
  dialogClassName?: string;
  /** Surface styling applied to the full-size card inside <dialog>. */
  className?: string;
  children: ReactNode;
}

/**
 * Reusable modal built on the native HTML `<dialog>.showModal()` Top Layer API:
 * provides built-in `inert` background isolation, focus management, `::backdrop`,
 * and `cancel` (Escape) interception without `window` keydown listener clashes.
 */
export function ModalDialog({
  open = true,
  ariaLabel,
  closeOnEsc = true,
  closeOnBackdrop = true,
  onClose,
  dialogClassName = "w-[min(420px,calc(100vw-2rem))]",
  className = "rounded-2xl border border-slate-200 bg-white p-4 shadow-xl",
  children,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
    return () => {
      if (el.open) el.close();
    };
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      if (closeOnEsc) onCloseRef.current();
    };
    el.addEventListener("cancel", onCancel);
    return () => el.removeEventListener("cancel", onCancel);
  }, [closeOnEsc]);

  return (
    <dialog
      ref={ref}
      aria-label={ariaLabel}
      onClick={(e) => {
        if (closeOnBackdrop && e.target === ref.current) {
          onClose();
        }
      }}
      className={`zsm-dialog ${dialogClassName}`}
    >
      <div className={`w-full ${className}`}>{children}</div>
    </dialog>
  );
}
