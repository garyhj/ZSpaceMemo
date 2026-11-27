/** Shared byte formatting & Safari 17.0+ compatible ES2024 Object.groupBy helper. */

export function formatBytes(bytes?: number | null, emptyLabel = "-"): string {
  if (!bytes || bytes <= 0) return emptyLabel;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatBytesCompact(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

type GroupByFn = <T, K extends PropertyKey>(
  items: Iterable<T>,
  keySelector: (item: T, index: number) => K
) => Record<string, T[] | undefined>;

export function groupByKey<T, K extends string>(
  items: readonly T[],
  getKey: (item: T, index: number) => K
): Record<string, T[]> {
  const nativeGroupBy = (Object as unknown as { groupBy?: GroupByFn }).groupBy;
  if (typeof nativeGroupBy === "function") {
    const grouped = nativeGroupBy(items, getKey);
    const out: Record<string, T[]> = {};
    for (const [k, v] of Object.entries(grouped)) {
      if (v) out[k] = v;
    }
    return out;
  }
  const out: Record<string, T[]> = {};
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = getKey(item, i);
    (out[key] ??= []).push(item);
  }
  return out;
}
