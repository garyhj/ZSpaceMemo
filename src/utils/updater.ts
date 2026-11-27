import { api } from "../api";

export { formatBytesCompact } from "./format";

export interface ReleaseUpdateInfo {
  current_version: string;
  latest_version: string;
  has_update: boolean;
  release_url: string;
  release_notes: string;
  published_at?: string | null;
  asset_name?: string | null;
  download_url?: string | null;
  asset_size?: number | null;
  asset_sha256?: string | null;
  auto_install_supported: boolean;
}

export interface UpdateProgressEvent {
  phase: "downloading" | "verifying" | "installing" | "error" | "done";
  downloaded: number;
  total?: number | null;
  percent: number;
  message: string;
}

export async function checkLatestRelease(): Promise<ReleaseUpdateInfo> {
  return api.checkAppUpdate();
}

export async function startInAppUpdate(info: ReleaseUpdateInfo): Promise<void> {
  if (!info.auto_install_supported || !info.download_url || !info.asset_name) {
    throw new Error("当前安装形态不支持应用内自动更新，请前往 GitHub Releases 手动下载");
  }
  return api.installAppUpdate(
    info.download_url,
    info.asset_name,
    info.asset_sha256 ?? null
  );
}
