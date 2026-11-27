// Copyright (c) 2026 Kubai087. Licensed under the Kubai Icons License; see kubai-icons/LICENSE.
// Layered animated icons for ZSpace Kit powered by the Kubai Icons engine.

import { useEffect, useId, useRef } from "react";

export type KubaiIconName =
  | "tasks"
  | "calendar"
  | "sticky"
  | "files"
  | "nas"
  | "docker"
  | "downloader"
  | "settings";

const REF = [83, 147, 255];
const KR = 2.2;
const CR = 1.2;
const DUR = 460;
const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_VIEWBOX = "0 -2 31 29";

const OL = 'class="kubai-ol" fill="none" stroke-width="2" data-t="stroke:#5393FF"';
const LINE = 'class="kubai-ln" fill="none" stroke-width="1.6" stroke-linecap="round" data-t="stroke:#D3E2FC"';
const DEEP = 'data-t="fill:#2F6FE0"';
const DEEPS = 'data-t="stroke:#2F6FE0"';

const hex = (c: number[]) =>
  "#" +
  c
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

const rgb = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

function tint(src: string, sel: [number, number, number]) {
  const s = rgb(src);
  return hex(
    [0, 1, 2].map((i) => {
      const amt = i === 2 ? (s[0] - REF[0]) / (255 - REF[0]) : (s[i] - REF[i]) / (255 - REF[i]);
      return amt >= 0 ? sel[i] + (255 - sel[i]) * amt : sel[i] * (1 + amt);
    })
  );
}

function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-5) break;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return sy(t);
  };
}

const EASE = bezier(0.22, 1, 0.36, 1);

function interp(a: unknown, b: unknown, t: number): unknown {
  if (typeof b === "number") return typeof a === "number" ? a + (b - a) * t : b;
  if (Array.isArray(b)) return b.map((v, i) => interp(Array.isArray(a) ? a[i] : v, v, t));
  if (b && typeof b === "object") {
    const o: Record<string, unknown> = {};
    const ao = a && typeof a === "object" ? (a as Record<string, unknown>) : undefined;
    for (const k in b as Record<string, unknown>) {
      o[k] = interp(ao?.[k], (b as Record<string, unknown>)[k], t);
    }
    return o;
  }
  return b;
}

const f = (n: number) => +n.toFixed(3);
const R = (x: number, y: number, w: number, h: number): [number, number][] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

function rp(pts: [number, number][], r: number | number[], full = false) {
  const n = pts.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const v = pts[i];
    const a = pts[(i + n - 1) % n];
    const b = pts[(i + 1) % n];
    const ri = Array.isArray(r) ? r[i] : r;
    const la = Math.hypot(a[0] - v[0], a[1] - v[1]) || 1e-6;
    const lb = Math.hypot(b[0] - v[0], b[1] - v[1]) || 1e-6;
    const lim = full ? 1 : 0.5;
    const k1 = Math.min(ri, la * lim) / la;
    const k2 = Math.min(ri, lb * lim) / lb;
    d +=
      (i ? "L" : "M") +
      f(v[0] + (a[0] - v[0]) * k1) +
      " " +
      f(v[1] + (a[1] - v[1]) * k1) +
      "Q" +
      f(v[0]) +
      " " +
      f(v[1]) +
      " " +
      f(v[0] + (b[0] - v[0]) * k2) +
      " " +
      f(v[1] + (b[1] - v[1]) * k2);
  }
  return d + "Z";
}

const rr = (x: number, y: number, w: number, h: number, r: number) => rp(R(x, y, w, h), r);
const circ = (cx: number, cy: number, r: number) =>
  `M${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)}Z`;
const lines = (x: number, y: number, widths: number[]) =>
  widths.map((w, i) => `M${f(x)} ${f(y + i * 3)}H${f(x + w)}`).join("");

function gear(teeth: number, rOut: number, rIn: number) {
  const pts: [number, number][] = [];
  const step = 360 / teeth;
  const rad = (d: number) => (d * Math.PI) / 180;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    (
      [
        [rIn, a - step * 0.3],
        [rOut, a - step * 0.17],
        [rOut, a + step * 0.17],
        [rIn, a + step * 0.3],
      ] as [number, number][]
    ).forEach(([r, d]) => {
      pts.push([15.5 + r * Math.sin(rad(d)), 12.5 - r * Math.cos(rad(d))]);
    });
  }
  return rp(pts, 0.8);
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const d = Math.hypot(dx, dy);
  const l = (a[2] * a[2] - b[2] * b[2] + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a[2] * a[2] - l * l));
  const mx = a[0] + (dx * l) / d;
  const my = a[1] + (dy * l) / d;
  const p1: [number, number] = [mx + (h * dy) / d, my - (h * dx) / d];
  const p2: [number, number] = [mx - (h * dy) / d, my + (h * dx) / d];
  return p1[1] < p2[1] ? p1 : p2;
}

function arc(c: [number, number, number], from: [number, number], to: [number, number]) {
  let dl = Math.atan2(to[1] - c[1], to[0] - c[0]) - Math.atan2(from[1] - c[1], from[0] - c[0]);
  while (dl < 0) dl += Math.PI * 2;
  return `A${f(c[2])} ${f(c[2])} 0 ${dl > Math.PI ? 1 : 0} 1 ${f(to[0])} ${f(to[1])}`;
}

function cloud(L: [number, number, number], T: [number, number, number], Rc: [number, number, number]) {
  const s: [number, number] = [L[0], L[1] + L[2]];
  const i1 = cross(L, T);
  const i2 = cross(T, Rc);
  const e: [number, number] = [Rc[0], Rc[1] + Rc[2]];
  return `M${f(s[0])} ${f(s[1])}${arc(L, s, i1)}${arc(T, i1, i2)}${arc(Rc, i2, e)}Z`;
}

function frontPiece(
  A: [number, number, number],
  B: [number, number, number],
  c: number,
  rc: number
) {
  const xl = A[0] - Math.sqrt(A[2] ** 2 - (c - A[1]) ** 2);
  const xr = B[0] + Math.sqrt(B[2] ** 2 - (c - B[1]) ** 2);
  const aL = Math.atan2(c - A[1], xl - A[0]) - rc / A[2];
  const aR = Math.atan2(c - B[1], xr - B[0]) + rc / B[2];
  const bL = [A[0] + A[2] * Math.cos(aL), A[1] + A[2] * Math.sin(aL)];
  const bR = [B[0] + B[2] * Math.cos(aR), B[1] + B[2] * Math.sin(aR)];
  return (
    `M${f(xl + rc)} ${f(c)}Q${f(xl)} ${f(c)} ${f(bL[0])} ${f(bL[1])}` +
    `A${f(A[2])} ${f(A[2])} 0 0 0 ${f(A[0])} ${f(A[1] + A[2])}L${f(B[0])} ${f(B[1] + B[2])}` +
    `A${f(B[2])} ${f(B[2])} 0 0 0 ${f(bR[0])} ${f(bR[1])}Q${f(xr)} ${f(c)} ${f(xr - rc)} ${f(c)}Z`
  );
}

const at = (el: Element | undefined, o: Record<string, string | number>) => {
  if (!el) return;
  for (const k in o) el.setAttribute(k, String(o[k]));
};

interface UHelpers {
  loS: string;
  upS: string;
  sh: string;
  hi: string;
  grads: Map<string, [number, string][]>;
}

function makeU(k: string): UHelpers {
  const grads = new Map<string, [number, string][]>();
  grads.set(`loS-${k}`, [
    [0, "#93BBFF"],
    [1, "#7FAEFF"],
  ]);
  grads.set(`upS-${k}`, [
    [0, "#CCDFFF"],
    [1, "#ADCBFF"],
  ]);
  return {
    grads,
    loS: `url(#loS-${k})`,
    upS: `url(#upS-${k})`,
    sh: `url(#sh-${k})`,
    hi: `url(#hi-${k})`,
  };
}

const gradSvg = (id: string, stops: [number, string][]) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops
    .map(([o, c]) => `<stop offset="${o}" stop-color="${c}" data-t="stop-color:${c}"/>`)
    .join("")}</linearGradient>`;

const defsSvg = (k: string, grads: Map<string, [number, string][]>) =>
  `<defs>${[...grads].map(([id, stops]) => gradSvg(id, stops)).join("")}
  <filter id="sh-${k}" x="-40%" y="-40%" width="180%" height="190%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="2"/><feOffset dy="2" result="o"/>
    <feColorMatrix in="o" type="matrix" data-sh values="0 0 0 0 0.54 0 0 0 0 0.71 0 0 0 0 1 0 0 0 0.21 0"/>
    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="hi-${k}" x="-10%" y="-10%" width="120%" height="130%" color-interpolation-filters="sRGB">
    <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="a"/>
    <feOffset in="a" dy="0.7"/><feGaussianBlur stdDeviation="0.35"/>
    <feComposite in2="a" operator="arithmetic" k2="-1" k3="1"/>
    <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.5 0"/>
    <feBlend in2="SourceGraphic" mode="overlay"/>
  </filter></defs>`;

interface IconDef {
  color: string;
  svg: (u: UHelpers) => string;
  target: (h: boolean) => Record<string, unknown>;
  draw: (p: Record<string, any>, E: Record<string, Element>) => void;
}

const GEAR = gear(6, 11.4, 9);
const today = new Date();
const tomorrow = new Date(today.getTime() + 86400000);

const KUBAI_ICONS: Record<KubaiIconName, IconDef> = {
  tasks: {
    color: "#5393FF",
    svg: (u) => {
      const board = rr(5.2, 2.2, 20.6, 20.6, KR);
      const sheet = rp(R(7.6, 7.2, 15.8, 13.4), [0, 0, CR, CR]);
      const head = rp(R(5.2, 2.2, 20.6, 5.2), [KR, KR, 0, 0]);
      return `
      <g filter="${u.sh}"><path d="${board}" fill="${u.loS}"/></g>
      <g data-n="sheet">
        <path d="${sheet}" fill="#fff"/>
        <path d="${lines(10.2, 9.6, [10.6])}" ${LINE}/>
        <path data-n="chk" d="M10.8 14.4L13.7 17.0L19.8 11.6" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ${DEEPS}/>
      </g>
      <path d="${board}" ${OL}/>
      <g filter="${u.hi}"><path d="${head}" fill="${u.upS}"/></g>
      <path d="${head}" ${OL}/>`;
    },
    target: (h) => ({ sy: h ? -0.8 : 0, sc: h ? 1.08 : 1 }),
    draw(p, E) {
      at(E.sheet, { transform: `translate(0 ${f(p.sy)})` });
      at(E.chk, { transform: `translate(15.3 14.3) scale(${f(p.sc)}) translate(-15.3 -14.3)` });
    },
  },
  calendar: {
    color: "#6366F1",
    svg: (u) => {
      const body = rr(5.2, 3.4, 20.6, 19.4, KR);
      const sheet = rp(R(8.2, 9, 14.6, 10.8), [0, 0, CR, CR]);
      const head = rp(R(5.2, 3.4, 20.6, 5.6), [KR, KR, 0, 0]);
      const ring = rr(10.4, 1.6, 1.8, 3.8, 0.9) + rr(18.8, 1.6, 1.8, 3.8, 0.9);
      return `
      <g filter="${u.sh}"><path d="${body}" fill="${u.loS}"/></g>
      <path d="${sheet}" fill="#fff"/>
      <text x="15.5" y="17.4" text-anchor="middle" font-size="8.4" font-weight="700" data-t="fill:#81B0FF">${tomorrow.getDate()}</text>
      <g data-n="sheet"><path d="${sheet}" fill="#fff"/>
        <text x="15.5" y="17.4" text-anchor="middle" font-size="8.4" font-weight="700" data-t="fill:#4389FF">${today.getDate()}</text>
        <path data-n="shade" d="${sheet}" data-t="fill:#4389FF" opacity="0"/></g>
      <path d="${body}" ${OL}/>
      <g filter="${u.hi}"><path d="${head}" fill="${u.upS}"/></g>
      <path d="${head}" ${OL}/>
      <g data-n="rings"><path d="${ring}" fill="#fff"/><path d="${ring}" ${OL}/></g>`;
    },
    target: (h) => ({ o: h ? 1 : 0, rings: h ? -0.6 : 0 }),
    draw(p, E) {
      const o = Math.max(0, Math.min(1, p.o));
      const sy = Math.cos((o * Math.PI) / 2);
      at(E.sheet, {
        transform: `translate(0 9) scale(1 ${f(Math.max(0.001, sy))}) translate(0 -9)`,
        opacity: o > 0.985 ? 0 : 1,
      });
      at(E.shade, { opacity: f(0.45 * Math.sin((o * Math.PI) / 2)) });
      at(E.rings, { transform: `translate(0 ${f(p.rings)})` });
    },
  },
  sticky: {
    color: "#EC4899",
    svg: (u) => `<g filter="${u.sh}"><g filter="${u.hi}"><path data-n="note" fill="${u.loS}"/></g></g><path data-n="noteO" ${OL}/>
      <path d="${lines(8.6, 7.4, [13.8, 9.4])}" class="kubai-ln" fill="none" stroke-width="1.6" stroke-linecap="round" stroke="#fff" data-w="stroke"/>
      <g filter="${u.hi}"><path data-n="fold" fill="${u.upS}"/></g><path data-n="foldO" ${OL}/>`,
    target: (h) => ({ cut: h ? 9 : 6.4 }),
    draw(p, E) {
      const c = p.cut;
      const note = rp(
        [
          [5.2, 2.2],
          [25.8, 2.2],
          [25.8, 22.8 - c],
          [25.8 - c, 22.8],
          [5.2, 22.8],
        ],
        [KR, KR, 0.6, 0.6, KR]
      );
      const fold = rp(
        [
          [25.8, 22.8 - c],
          [25.8 - c, 22.8],
          [25.8 - c, 22.8 - c],
        ],
        [0.5, 0.5, 1.2]
      );
      at(E.note, { d: note });
      at(E.noteO, { d: note });
      at(E.fold, { d: fold });
      at(E.foldO, { d: fold });
    },
  },
  files: {
    color: "#F97316",
    svg: (u) => `
      <g filter="${u.sh}"><g filter="${u.hi}"><path data-n="cloud" fill="${u.loS}"/></g></g>
      <path data-n="cloudO" ${OL}/>
      <path data-n="arrow" fill="none" stroke="#fff" data-w="stroke" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      <g filter="${u.hi}"><path data-n="front" fill="${u.upS}"/></g>
      <path data-n="frontO" ${OL}/>`,
    target: (h) => ({
      L: [9.2, 15.8, h ? 6.3 : 6],
      T: [15.8, 9.6, h ? 8.4 : 8],
      Rc: [22.2, 16.2, h ? 5.9 : 5.6],
      tip: h ? 4.8 : 6.4,
      chord: h ? 17.6 : 16.8,
    }),
    draw(p, E) {
      const d = cloud(p.L, p.T, p.Rc);
      at(E.cloud, { d });
      at(E.cloudO, { d });
      const t = p.tip;
      at(E.arrow, { d: `M15.5 ${f(t + 7.6)}V${f(t)}M12.1 ${f(t + 3.4)}L15.5 ${f(t)}L18.9 ${f(t + 3.4)}` });
      const fr = frontPiece(p.L, p.Rc, p.chord, 2);
      at(E.front, { d: fr });
      at(E.frontO, { d: fr });
    },
  },
  nas: {
    color: "#22C55E",
    svg: (u) => {
      const body = rr(6.3, 1, 18.4, 23, KR);
      const front = rp(R(6.3, 4.8, 18.4, 19.2), [1.8, 1.8, KR, KR]);
      const bayL = rr(9.2, 8.2, 5.1, 9.0, CR);
      const bayR = rr(16.7, 8.2, 5.1, 9.0, CR);
      return `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${body}" fill="${u.loS}"/></g></g>
      <path d="${body}" ${OL}/>
      <g filter="${u.hi}"><path d="${front}" fill="${u.upS}"/></g>
      <path d="${front}" ${OL}/>
      <g data-n="bays">
        <path d="${bayL}" fill="#fff"/>
        <path d="${bayR}" fill="#fff"/>
      </g>
      <circle data-n="led" cx="15.5" cy="20.4" r="1.3" ${DEEP}/>`;
    },
    target: (h) => ({ dy: h ? -1.2 : 0, led: h ? 1.2 : 1 }),
    draw(p, E) {
      at(E.bays, { transform: `translate(0 ${f(p.dy)})` });
      at(E.led, { transform: `translate(15.5 20.4) scale(${f(p.led)}) translate(-15.5 -20.4)` });
    },
  },
  docker: {
    color: "#06B6D4",
    svg: (u) => {
      const bot = rr(4, 12.6, 23, 9.1, KR);
      const top = rr(7.5, 4, 16, 8.6, KR);
      return `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${bot}" fill="${u.loS}"/></g></g>
      <path d="${bot}" ${OL}/>
      <path d="M9.5 15.2V19.1M15.5 15.2V19.1M21.5 15.2V19.1" fill="none" stroke-width="1.6" stroke-linecap="round" stroke="#fff" data-w="stroke"/>
      <g data-n="top">
        <g filter="${u.hi}"><path d="${top}" fill="${u.upS}"/></g>
        <path d="${top}" ${OL}/>
        <path d="M12.5 6.4V10.2M18.5 6.4V10.2" fill="none" stroke-width="1.6" stroke-linecap="round" ${DEEPS}/>
      </g>`;
    },
    target: (h) => ({ dy: h ? -2.2 : 0 }),
    draw(p, E) {
      at(E.top, { transform: `translate(0 ${f(p.dy)})` });
    },
  },
  downloader: {
    color: "#8B5CF6",
    svg: (u) => {
      const r = 11.5;
      return `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${circ(15.5, 12.5, r)}" fill="${u.loS}"/></g></g>
      <path d="${circ(15.5, 12.5, r)}" ${OL}/>
      <path data-n="arrow" fill="none" stroke="#fff" data-w="stroke" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      <g filter="${u.hi}"><path data-n="seg" fill="${u.upS}"/></g>
      <path data-n="segO" ${OL}/>`;
    },
    target: (h) => ({ tip: h ? 13.4 : 12.4, chord: h ? 16.6 : 15.6 }),
    draw(p, E) {
      const t = p.tip;
      at(E.arrow, { d: `M15.5 ${f(t - 9.4)}V${f(t)}M11.9 ${f(t - 3.6)}L15.5 ${f(t)}L19.1 ${f(t - 3.6)}` });
      const disc: [number, number, number] = [15.5, 12.5, 11.5];
      const seg = frontPiece(disc, disc, p.chord, 2);
      at(E.seg, { d: seg });
      at(E.segO, { d: seg });
    },
  },
  settings: {
    color: "#64748B",
    svg: (u) => `
      <g filter="${u.sh}"><g filter="${u.hi}"><g data-n="gear"><path d="${GEAR}" fill="${u.loS}"/></g></g></g><g data-n="gearO"><path d="${GEAR}" ${OL}/></g>
      <path d="${circ(15.5, 12.5, 5.8)}" fill="#fff"/>
      <g filter="${u.hi}"><path data-n="hub" fill="${u.upS}"/></g>
      <path data-n="hubO" ${OL}/>`,
    target: (h) => ({ rot: h ? 60 : 0, hub: h ? 2.9 : 3.5 }),
    draw(p, E) {
      at(E.gear, { transform: `rotate(${f(p.rot)} 15.5 12.5)` });
      at(E.gearO, { transform: `rotate(${f(p.rot)} 15.5 12.5)` });
      const d = circ(15.5, 12.5, p.hub);
      at(E.hub, { d });
      at(E.hubO, { d });
    },
  },
};

interface Props {
  name: KubaiIconName;
  hovered?: boolean;
  active?: boolean;
  size?: number;
}

export function KubaiIcon({ name, hovered = false, active = false, size = 24 }: Props) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const uid = useId().replace(/:/g, "");
  const instRef = useRef<{
    icon: IconDef;
    E: Record<string, Element>;
    tints: [Element, string, string][];
    clips: [Element, Element][];
    whites: Element[];
    shadow: Element | null;
    cur: Record<string, unknown>;
    raf: number;
    painted: string;
  } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const icon = KUBAI_ICONS[name];
    const k = `kb-${name}-${uid}`;
    const u = makeU(k);
    host.innerHTML = `<svg viewBox="${ICON_VIEWBOX}" width="${size}" height="${Math.round(
      (size * 29) / 31
    )}" fill="none" style="overflow:visible;display:block" aria-hidden="true">${defsSvg(
      k,
      u.grads
    )}${icon.svg(u)}</svg>`;
    const svg = host.querySelector("svg");
    if (!svg) return;
    const E: Record<string, Element> = {};
    svg.querySelectorAll<HTMLElement>("[data-n]").forEach((el) => {
      if (el.dataset.n) E[el.dataset.n] = el;
    });
    const tints = [...svg.querySelectorAll<HTMLElement>("[data-t]")].map((el) => {
      const [attr, src] = (el.dataset.t ?? "").split(":");
      return [el, attr, src] as [Element, string, string];
    });
    const defsEl = svg.querySelector("defs");
    const clips = [...svg.querySelectorAll(".kubai-ol")].map((el, j) => {
      const mask = document.createElementNS(SVG_NS, "mask");
      mask.id = `ol-${k}-${j}`;
      at(mask, { maskUnits: "userSpaceOnUse", x: -40, y: -40, width: 111, height: 109 });
      mask.innerHTML = '<rect x="-40" y="-40" width="111" height="109" fill="#fff"/>';
      const shape = document.createElementNS(SVG_NS, "path");
      shape.setAttribute("fill", "#000");
      shape.setAttribute("fill-rule", el.getAttribute("fill-rule") || "nonzero");
      mask.appendChild(shape);
      defsEl?.appendChild(mask);
      el.setAttribute("mask", `url(#${mask.id})`);
      return [el, shape] as [Element, Element];
    });
    const inst = {
      icon,
      E,
      tints,
      clips,
      whites: [...svg.querySelectorAll("[data-w]")],
      shadow: svg.querySelector("[data-sh]"),
      cur: icon.target(false),
      raf: 0,
      painted: "",
    };
    instRef.current = inst;
    return () => {
      cancelAnimationFrame(inst.raf);
      instRef.current = null;
    };
  }, [name, size, uid]);

  useEffect(() => {
    const inst = instRef.current;
    if (!inst) return;
    const icon = inst.icon;
    const baseHex = active || hovered ? icon.color : "#7B8BA1";
    const c = rgb(baseHex);
    const e = rgb(baseHex);
    const to = { ...icon.target(hovered), c, e };

    const paint = (p: Record<string, any>) => {
      icon.draw(p, inst.E);
      for (const [el, shape] of inst.clips) {
        const d = el.getAttribute("d");
        if (d && shape.getAttribute("d") !== d) shape.setAttribute("d", d);
      }
      const pc = p.c as [number, number, number];
      const pe = p.e as [number, number, number];
      const key = hex(pc) + hex(pe);
      if (inst.painted === key) return;
      inst.painted = key;
      const pick = (src: string) => (rgb(src)[0] <= REF[0] ? pe : pc);
      for (const [el, attr, src] of inst.tints) {
        el.setAttribute(attr, tint(src, el.tagName !== "stop" ? pick(src) : pc));
      }
      for (const el of inst.whites) {
        const attr = el.getAttribute("data-w");
        if (attr) el.setAttribute(attr, "#fff");
      }
      if (inst.shadow) {
        const sh = rgb(tint("#8AB6FF", pc));
        inst.shadow.setAttribute(
          "values",
          `0 0 0 0 ${f(sh[0] / 255)} 0 0 0 0 ${f(sh[1] / 255)} 0 0 0 0 ${f(sh[2] / 255)} 0 0 0 0.21 0`
        );
      }
    };

    cancelAnimationFrame(inst.raf);
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      reduced = false;
    }
    if (reduced) {
      inst.cur = to;
      paint(to);
      return;
    }
    const from = { ...inst.cur, c: (inst.cur.c as [number, number, number]) ?? c, e: (inst.cur.e as [number, number, number]) ?? e };
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / DUR);
      inst.cur = interp(from, to, EASE(t)) as Record<string, unknown>;
      paint(inst.cur);
      if (t < 1) inst.raf = requestAnimationFrame(tick);
    };
    inst.raf = requestAnimationFrame(tick);
  }, [hovered, active]);

  return <span ref={hostRef} className="inline-flex items-center justify-center" />;
}
