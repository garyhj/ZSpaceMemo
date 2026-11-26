use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/garyhj/ZSpaceMemo/releases/latest";
const RELEASES_PAGE_FALLBACK: &str = "https://github.com/garyhj/ZSpaceMemo/releases/latest";

static UPDATING: AtomicBool = AtomicBool::new(false);

struct UpdatingGuard;
impl Drop for UpdatingGuard {
    fn drop(&mut self) {
        UPDATING.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    size: u64,
    #[serde(default)]
    digest: Option<String>,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_url: String,
    pub release_notes: String,
    pub published_at: Option<String>,
    pub asset_name: Option<String>,
    pub download_url: Option<String>,
    pub asset_size: Option<u64>,
    pub asset_sha256: Option<String>,
    pub auto_install_supported: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgressEvent {
    pub phase: &'static str,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percent: u8,
    pub message: String,
}

fn compare_semver(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |s: &str| -> Vec<u64> {
        s.trim()
            .trim_start_matches(['v', 'V'])
            .split(['-', '+'])
            .next()
            .unwrap_or("")
            .split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let pa = parse(a);
    let pb = parse(b);
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let da = pa.get(i).copied().unwrap_or(0);
        let db = pb.get(i).copied().unwrap_or(0);
        if da != db {
            return da.cmp(&db);
        }
    }
    std::cmp::Ordering::Equal
}

fn select_platform_asset(assets: &[GitHubAsset]) -> Option<&GitHubAsset> {
    if cfg!(target_os = "windows") {
        let in_program_files = std::env::current_exe()
            .ok()
            .map(|p| {
                p.to_string_lossy()
                    .to_ascii_lowercase()
                    .contains("program files")
            })
            .unwrap_or(false);
        if in_program_files {
            assets
                .iter()
                .find(|a| a.name.to_ascii_lowercase().ends_with(".msi"))
                .or_else(|| {
                    assets
                        .iter()
                        .find(|a| a.name.to_ascii_lowercase().ends_with("-setup.exe"))
                })
                .or_else(|| {
                    assets
                        .iter()
                        .find(|a| a.name.to_ascii_lowercase().ends_with(".exe"))
                })
        } else {
            assets
                .iter()
                .find(|a| a.name.to_ascii_lowercase().ends_with("-setup.exe"))
                .or_else(|| {
                    assets
                        .iter()
                        .find(|a| a.name.to_ascii_lowercase().ends_with(".exe"))
                })
                .or_else(|| {
                    assets
                        .iter()
                        .find(|a| a.name.to_ascii_lowercase().ends_with(".msi"))
                })
        }
    } else if cfg!(target_os = "macos") {
        assets
            .iter()
            .find(|a| a.name.to_ascii_lowercase().ends_with(".app.tar.gz"))
            .or_else(|| {
                assets
                    .iter()
                    .find(|a| a.name.to_ascii_lowercase().ends_with(".dmg"))
            })
    } else {
        None
    }
}

fn build_http_client(current_version: &str, timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("ZSpaceKit/{current_version}"))
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))
}

fn is_allowed_download_url(url: &str) -> bool {
    url.starts_with("https://github.com/garyhj/ZSpaceMemo/")
        || url.starts_with("https://objects.githubusercontent.com/")
        || url.starts_with("https://release-assets.githubusercontent.com/")
}

fn sanitize_asset_filename(name: &str) -> Result<String, String> {
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .unwrap_or("");
    if base.is_empty() || base == "." || base == ".." || base.contains(['/', '\\']) {
        return Err("无效的安装包文件名".to_string());
    }
    Ok(base.to_string())
}

fn emit_progress(
    app: &AppHandle,
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
    percent: u8,
    message: impl Into<String>,
) {
    let _ = app.emit(
        "update:progress",
        UpdateProgressEvent {
            phase,
            downloaded,
            total,
            percent,
            message: message.into(),
        },
    );
}

pub async fn check_app_update(app: &AppHandle) -> Result<UpdateCheckResult, String> {
    let current = app.package_info().version.to_string();
    let client = build_http_client(&current, Duration::from_secs(12))?;
    let resp = client
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("请求 GitHub Releases 失败：{e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API 返回异常状态：HTTP {}", resp.status()));
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("读取更新信息失败：{e}"))?;
    let release: GitHubRelease =
        serde_json::from_slice(&body).map_err(|e| format!("解析发布元数据失败：{e}"))?;

    let latest_version = release.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    let has_update = !latest_version.is_empty()
        && compare_semver(&latest_version, &current) == std::cmp::Ordering::Greater;
    let release_url = if release.html_url.is_empty() {
        RELEASES_PAGE_FALLBACK.to_string()
    } else {
        release.html_url
    };

    let matched = select_platform_asset(&release.assets);
    let asset_name = matched.map(|a| a.name.clone());
    let download_url = matched.map(|a| a.browser_download_url.clone());
    let asset_size = matched.map(|a| a.size);
    let asset_sha256 = matched
        .and_then(|a| a.digest.as_deref())
        .and_then(|d| d.strip_prefix("sha256:"))
        .map(|s| s.trim().to_ascii_lowercase());
    let auto_install_supported = download_url
        .as_deref()
        .map(is_allowed_download_url)
        .unwrap_or(false);

    Ok(UpdateCheckResult {
        current_version: current,
        latest_version,
        has_update,
        release_url,
        release_notes: release.body.unwrap_or_default(),
        published_at: release.published_at,
        asset_name,
        download_url,
        asset_size,
        asset_sha256,
        auto_install_supported,
    })
}

pub async fn install_app_update(
    app: AppHandle,
    download_url: String,
    asset_name: String,
    expected_sha256: Option<String>,
) -> Result<(), String> {
    if UPDATING.swap(true, Ordering::SeqCst) {
        return Err("正在下载或安装更新，请勿重复点击".to_string());
    }
    let _guard = UpdatingGuard;

    if !is_allowed_download_url(&download_url) {
        return Err("更新下载地址不在官方 GitHub Releases 白名单内，已拒绝".to_string());
    }
    let filename = sanitize_asset_filename(&asset_name)?;
    let updates_dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("zspace-kit"))
        .join("updates");
    fs::create_dir_all(&updates_dir).map_err(|e| format!("创建更新缓存目录失败：{e}"))?;
    let dest_path = updates_dir.join(&filename);
    if dest_path.exists() {
        let _ = fs::remove_file(&dest_path);
    }

    let current = app.package_info().version.to_string();
    let client = build_http_client(&current, Duration::from_secs(600))?;
    emit_progress(&app, "downloading", 0, None, 0, format!("正在连接并下载 {filename}…"));

    let mut resp = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("下载更新包失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    if !is_allowed_download_url(resp.url().as_str()) {
        return Err("重定向地址超出 GitHub Releases 域名范围，已中止".to_string());
    }

    let total = resp.content_length();
    let mut file = File::create(&dest_path).map_err(|e| format!("创建安装包文件失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut last_emit = Instant::now();

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("下载数据流中断：{e}"))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("写入安装包失败：{e}"))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(120) {
            let pct = total
                .filter(|&t| t > 0)
                .map(|t| ((downloaded.saturating_mul(100)) / t).min(99) as u8)
                .unwrap_or(0);
            emit_progress(&app, "downloading", downloaded, total, pct, "正在下载更新包…");
            last_emit = Instant::now();
        }
    }
    file.flush().map_err(|e| format!("刷新安装包文件失败：{e}"))?;
    drop(file);

    emit_progress(&app, "verifying", downloaded, total, 100, "正在校验安装包 SHA-256…");

    if let Some(expected) = expected_sha256
        .as_deref()
        .map(|s| s.trim().trim_start_matches("sha256:").to_ascii_lowercase())
        .filter(|s| !s.is_empty())
    {
        let digest = hasher.finalize();
        let mut actual = String::with_capacity(64);
        for b in digest {
            let _ = write!(actual, "{b:02x}");
        }
        if actual != expected {
            let _ = fs::remove_file(&dest_path);
            return Err("安装包 SHA-256 校验未通过，已删除异常文件".to_string());
        }
    }

    emit_progress(
        &app,
        "installing",
        downloaded,
        total,
        100,
        "校验通过，即将关闭当前窗口并完成更新安装…",
    );

    tracing::info!(
        installer = %dest_path.display(),
        bytes = downloaded,
        "update package verified, spawning platform installer"
    );

    spawn_platform_installer(&dest_path)?;

    // Flush progress event briefly then exit process immediately (matching tauri-plugin-updater)
    // so Windows NSIS/MSI overwrites binaries cleanly and `/R` relaunches the updated app.
    tokio::time::sleep(Duration::from_millis(120)).await;
    std::process::exit(0);
}

#[cfg(target_os = "windows")]
fn spawn_platform_installer(installer_path: &Path) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOW;

    let is_msi = installer_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("msi"))
        .unwrap_or(false);

    let inst_str = installer_path.to_string_lossy();
    let (file_h, params_h): (HSTRING, HSTRING) = if is_msi {
        let sys_root = std::env::var("SYSTEMROOT").unwrap_or_else(|_| r"C:\Windows".to_string());
        let msiexec = format!(r"{sys_root}\System32\msiexec.exe");
        let escaped = inst_str.replace('"', "");
        let params = format!("/i \"{escaped}\" /passive /promptrestart AUTOLAUNCHAPP=True");
        (HSTRING::from(msiexec), HSTRING::from(params))
    } else {
        // Official Tauri NSIS updater flags:
        // /P = passive progress bar, /UPDATE = skip uninstall & preserve shortcuts, /R = relaunch after install
        (
            HSTRING::from(inst_str.as_ref()),
            HSTRING::from("/P /UPDATE /R"),
        )
    };

    tracing::info!(
        installer = %installer_path.display(),
        is_msi,
        "launching Windows installer via ShellExecuteW"
    );

    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &file_h,
            &params_h,
            PCWSTR::null(),
            SW_SHOW,
        )
    };
    let code = result.0 as isize;
    if code <= 32 {
        return Err(format!(
            "启动 Windows 安装器失败（ShellExecuteW 返回 {code}）"
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_platform_installer(installer_path: &Path) -> Result<(), String> {
    let lower = installer_path.to_string_lossy().to_ascii_lowercase();
    if lower.ends_with(".app.tar.gz") {
        let current_exe =
            std::env::current_exe().map_err(|e| format!("无法获取当前程序路径：{e}"))?;
        if let Some(target_app) = current_exe
            .ancestors()
            .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
        {
            let extract_dir = installer_path
                .parent()
                .unwrap_or_else(|| Path::new("/tmp"))
                .join("extracted");
            let _ = fs::remove_dir_all(&extract_dir);
            fs::create_dir_all(&extract_dir)
                .map_err(|e| format!("创建 macOS 解压目录失败：{e}"))?;

            let status = std::process::Command::new("tar")
                .arg("-xzf")
                .arg(installer_path)
                .arg("-C")
                .arg(&extract_dir)
                .status()
                .map_err(|e| format!("解压更新包失败：{e}"))?;
            if !status.success() {
                return Err("tar 解压 .app.tar.gz 失败".to_string());
            }

            let new_app = fs::read_dir(&extract_dir)
                .map_err(|e| e.to_string())?
                .flatten()
                .map(|e| e.path())
                .find(|p| p.extension().and_then(|ext| ext.to_str()) == Some("app"));

            if let Some(src_app) = new_app {
                let esc_sh = |p: &Path| p.to_string_lossy().replace('\'', "'\\''");
                let sh_cmd = format!(
                    "sleep 1; rm -rf '{dst}'; ditto '{src}' '{dst}' && (xattr -cr '{dst}' 2>/dev/null || true); open '{dst}'",
                    src = esc_sh(&src_app),
                    dst = esc_sh(target_app),
                );
                std::process::Command::new("/bin/sh")
                    .args(["-c", &sh_cmd])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| format!("启动 macOS 替换脚本失败：{e}"))?;
                return Ok(());
            }
        }
    }

    std::process::Command::new("open")
        .arg(installer_path)
        .spawn()
        .map_err(|e| format!("打开安装包失败：{e}"))?;
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn spawn_platform_installer(_installer_path: &Path) -> Result<(), String> {
    Err("当前系统暂不支持自动安装，请前往 GitHub Releases 手动下载".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_ordering_handles_v_prefix_and_segments() {
        assert_eq!(
            compare_semver("v0.4.1", "0.4.0"),
            std::cmp::Ordering::Greater
        );
        assert_eq!(
            compare_semver("0.4.0", "v0.4.0"),
            std::cmp::Ordering::Equal
        );
        assert_eq!(
            compare_semver("0.3.9", "0.4.0"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn allows_only_official_github_release_urls() {
        assert!(is_allowed_download_url(
            "https://github.com/garyhj/ZSpaceMemo/releases/download/v0.4.0/ZSpace.Kit_0.4.0_x64-setup.exe"
        ));
        assert!(is_allowed_download_url(
            "https://objects.githubusercontent.com/github-production-release-asset-2e65be/abc"
        ));
        assert!(!is_allowed_download_url("https://evil.example.com/setup.exe"));
    }
}
