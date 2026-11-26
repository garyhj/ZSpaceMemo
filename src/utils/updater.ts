export interface ReleaseUpdateInfo {
  latestVersion: string;
  currentVersion: string;
  hasUpdate: boolean;
  url: string;
  publishedAt?: string;
  notes?: string;
}

export function compareSemver(a: string, b: string): number {
  const pa = a
    .replace(/^v/i, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = b
    .replace(/^v/i, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export async function checkLatestRelease(currentVersion: string): Promise<ReleaseUpdateInfo> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch("https://api.github.com/repos/garyhj/ZSpaceMemo/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as {
      tag_name?: string;
      html_url?: string;
      published_at?: string;
      body?: string;
    };
    const rawTag = String(data.tag_name ?? "").trim();
    const latestVersion = rawTag.replace(/^v/i, "");
    const cleanCurrent = currentVersion.replace(/^v/i, "");
    return {
      latestVersion,
      currentVersion: cleanCurrent,
      hasUpdate: Boolean(latestVersion) && compareSemver(latestVersion, cleanCurrent) > 0,
      url: data.html_url || "https://github.com/garyhj/ZSpaceMemo/releases/latest",
      publishedAt: data.published_at,
      notes: data.body,
    };
  } finally {
    window.clearTimeout(timer);
  }
}
