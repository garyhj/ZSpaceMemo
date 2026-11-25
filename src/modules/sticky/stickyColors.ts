import type { StickyColor } from "../../types";

export const STICKY_COLORS: Record<
  StickyColor,
  { label: string; bg: string; header: string; border: string; dot: string }
> = {
  yellow: {
    label: "暖黄",
    bg: "bg-[#FFF9DB]",
    header: "bg-[#FFF3BF]/75",
    border: "border-[#F5E09B]",
    dot: "#F59F00",
  },
  blue: {
    label: "晴蓝",
    bg: "bg-[#EDF2FF]",
    header: "bg-[#DBE4FF]/80",
    border: "border-[#C5D4FA]",
    dot: "#4772FA",
  },
  green: {
    label: "薄荷",
    bg: "bg-[#EBFBEE]",
    header: "bg-[#D3F9D8]/80",
    border: "border-[#B2F2BB]",
    dot: "#2F9E44",
  },
  pink: {
    label: "樱粉",
    bg: "bg-[#FFF0F6]",
    header: "bg-[#FFDEEB]/80",
    border: "border-[#FCC2D7]",
    dot: "#E64980",
  },
  purple: {
    label: "丁香",
    bg: "bg-[#F3F0FF]",
    header: "bg-[#E5DBFF]/80",
    border: "border-[#D0BFFF]",
    dot: "#7950F2",
  },
  white: {
    label: "纯白",
    bg: "bg-white",
    header: "bg-slate-50",
    border: "border-slate-200",
    dot: "#94A3B8",
  },
};

export const STICKY_COLOR_KEYS: StickyColor[] = [
  "yellow",
  "blue",
  "green",
  "pink",
  "purple",
  "white",
];
