import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Element to anchor to, OR fixed `{ x, y }` screen coordinates. */
  anchorEl?: RefObject<HTMLElement | null>;
  anchorPoint?: { x: number; y: number } | null;
  align?: "left" | "right";
  side?: "bottom" | "top";
  gap?: number;
  margin?: number;
  mode?: "auto" | "manual";
  className?: string;
  onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  children: ReactNode;
}

/**
 * Native HTML Popover API (`popover="auto"`) wrapper with Top-Layer light-dismiss,
 * Escape layering, and measured viewport-clamped positioning (Safari 17.0+ / Chromium 114+).
 */
export function AnchoredPopover({
  open,
  onClose,
  anchorEl,
  anchorPoint,
  align = "right",
  side = "bottom",
  gap = 4,
  margin = 8,
  mode = "auto",
  className = "",
  onMouseDown,
  children,
}: Props) {
  const popRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const openRef = useRef(open);
  openRef.current = open;

  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  function updatePosition() {
    const el = popRef.current;
    if (!el) return;
    const w = el.offsetWidth || 240;
    const h = el.offsetHeight || 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let rawLeft = margin;
    let rawTop = margin;

    const anchor = anchorEl?.current;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      rawLeft = align === "right" ? r.right - w : r.left;
      if (side === "top") {
        rawTop = r.top - h - gap;
        if (rawTop < margin && r.bottom + gap + h <= vh - margin) {
          rawTop = r.bottom + gap;
        }
      } else {
        rawTop = r.bottom + gap;
        if (rawTop + h > vh - margin && r.top - gap - h >= margin) {
          rawTop = r.top - h - gap;
        }
      }
    } else if (anchorPoint) {
      rawLeft = anchorPoint.x;
      rawTop = anchorPoint.y;
    }

    const left = Math.max(margin, Math.min(rawLeft, vw - w - margin));
    const top = Math.max(margin, Math.min(rawTop, vh - h - margin));
    setPos({ left, top });
  }

  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    if (open) {
      try {
        if (!el.matches(":popover-open")) el.showPopover();
      } catch {
        // Fallback if already open or detached
      }
      updatePosition();
    } else {
      try {
        if (el.matches(":popover-open")) el.hidePopover();
      } catch {
        // Ignore if already closed
      }
    }
    return () => {
      try {
        if (el.matches(":popover-open")) el.hidePopover();
      } catch {
        // Ignore on unmount
      }
    };
  }, [open, anchorPoint?.x, anchorPoint?.y, align, side]);

  useEffect(() => {
    const el = popRef.current;
    if (!open || !el) return;
    const onResize = () => updatePosition();
    const onToggle = (ev: Event) => {
      const tev = ev as ToggleEvent;
      if (tev.newState === "closed" && openRef.current) {
        onCloseRef.current();
      }
    };
    window.addEventListener("resize", onResize);
    el.addEventListener("toggle", onToggle);
    return () => {
      window.removeEventListener("resize", onResize);
      el.removeEventListener("toggle", onToggle);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={popRef}
      popover={mode}
      onMouseDown={onMouseDown}
      style={{ left: pos.left, top: pos.top }}
      className={`zsm-popover fixed ${className}`}
    >
      {children}
    </div>
  );
}
