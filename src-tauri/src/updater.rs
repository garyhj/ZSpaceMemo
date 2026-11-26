use reqwest::redirect;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/garyhj/ZSpaceMemo/releases/latest";
const RELEASES_PAGE_FALLBACK: &str = "https://github.com/garyhj/ZSpaceMemo/releases/latest";
const CHECK_CACHE_TTL: Duration = Duration::from_secs(20 * 60);

static UPDATING: AtomicBool = AtomicBool::new(false);
static LAST_CHECK: OnceLock<Mutex<Option<(Instant, UpdateCheckResult)>>> = OnceLock::new();

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
    let split_pre = |s: &str| -> (&str, Option<&str>) {
        let trimmed = s.trim().trim_start_matches(['v', 'V']);
        let main = trimmed.split('+').next().unwrap_or("");
        match main.split_once('-') {
            Some((core, pre)) if !pre.is_empty() => (core, Some(pre)),
            _ => (main, None),
        }
    };
    let parse_nums = |core: &str| -> Vec<u64> {
        core.split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };

    let (ca, pa_pre) = split_pre(a);
    let (cb, pb_pre) = split_pre(b);
    let pa = parse_nums(ca);
    let pb = parse_nums(cb);
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let da = pa.get(i).copied().unwrap_or(0);
        let db = pb.get(i).copied().unwrap_or(0);
        if da != db {
            return da.cmp(&db);
        }
    }
    match (pa_pre, pb_pre) {
        (None, None) => std::cmp::Ordering::Equal,
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(x), Some(y)) => x.cmp(y),
    }
}

fn asset_matches_arch(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let has_arm64 = lower.contains("aarch64") || lower.contains("arm64");
    let has_x64 = lower.contains("x86_64") || lower.contains("x64") || lower.contains("amd64");
    let has_universal = lower.contains("universal");

    if cfg!(target_arch = "aarch64") {
        if has_x64 && !has_universal && !has_arm64 {
            return false;
        }
        true
    } else if cfg!(target_arch = "x86_64") {
        if has_arm64 && !has_universal && !has_x64 {
            return false;
        }
        true
    } else {
        true
    }
}

fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn select_platform_asset(assets: &[GitHubAsset]) -> Option<&GitHubAsset> {
    if cfg!(target_os = "windows") {
        let prefer_msi = std::env::current_exe()
            .ok()
            .map(|exe| {
                let has_nsis_uninstaller = exe
                    .parent()
                    .map(|dir| dir.join("uninstall.exe").exists())
                    .unwrap_or(false);
                if has_nsis_uninstaller {
                    false
                } else {
                    exe.to_string_lossy()
                        .to_ascii_lowercase()
                        .contains("program files")
                }
            })
            .unwrap_or(false);

        let arch_assets: Vec<&GitHubAsset> =
            assets.iter().filter(|a| asset_matches_arch(&a.name)).collect();
        if prefer_msi {
            arch_assets
                .iter()
                .copied()
                .find(|a| a.name.to_ascii_lowercase().ends_with(".msi"))
                .or_else(|| {
                    arch_assets
                        .iter()
                        .copied()
                        .find(|a| a.name.to_ascii_lowercase().ends_with("-setup.exe"))
                })
                .or_else(|| {
                    arch_assets
                        .iter()
                        .copied()
                        .find(|a| a.name.to_ascii_lowercase().ends_with(".exe"))
                })
        } else {
            arch_assets
                .iter()
                .copied()
                .find(|a| a.name.to_ascii_lowercase().ends_with("-setup.exe"))
                .or_else(|| {
                    arch_assets
                        .iter()
                        .copied()
                        .find(|a| a.name.to_ascii_lowercase().ends_with(".exe"))
                })
                .or_else(|| {
                    arch_assets
                        .iter()
                        .copied()
                        .find(|a| a.name.to_ascii_lowercase().ends_with(".msi"))
                })
        }
    } else if cfg!(target_os = "macos") {
        let arch_assets: Vec<&GitHubAsset> =
            assets.iter().filter(|a| asset_matches_arch(&a.name)).collect();
        arch_assets
            .iter()
            .copied()
            .find(|a| a.name.to_ascii_lowercase().ends_with(".app.tar.gz"))
            .or_else(|| {
                arch_assets
                    .iter()
                    .copied()
                    .find(|a| a.name.to_ascii_lowercase().ends_with(".dmg"))
            })
    } else {
        None
    }
}

fn build_http_client(
    current_version: &str,
    read_timeout: Duration,
    enforce_download_allowlist: bool,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(format!("ZSpaceKit/{current_version}"))
        .connect_timeout(Duration::from_secs(12))
        .read_timeout(read_timeout);

    if enforce_download_allowlist {
        let policy = redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 8 {
                return attempt.error("下载重定向次数过多");
            }
            if !is_allowed_download_url(attempt.url().as_str()) {
                return attempt.error("重定向目标不在官方 GitHub Releases 域名范围内");
            }
            attempt.follow()
        });
        builder = builder.redirect(policy);
    }

    builder
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))
}

fn is_allowed_download_url(url: &str) -> bool {
    url.starts_with("https://github.com/garyhj/ZSpaceMemo/releases/download/")
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

fn updates_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("无法解析应用缓存目录：{e}"))?;
    Ok(cache.join("updates"))
}

pub fn cleanup_stale_updates(app: &AppHandle) {
    if let Ok(dir) = updates_cache_dir(app) {
        if dir.exists() {
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

pub async fn check_app_update(app: &AppHandle) -> Result<UpdateCheckResult, String> {
    let current = app.package_info().version.to_string();
    let client = build_http_client(&current, Duration::from_secs(15), false)?;
    let resp = client
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("请求 GitHub Releases 失败：{e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        if status.as_u16() == 403 || status.as_u16() == 429 {
            return Err("GitHub API 请求受限（每小时限额），请稍后重试或前往发布页下载".into());
        }
        return Err(format!("GitHub API 返回异常状态：HTTP {status}"));
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
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| is_valid_sha256_hex(s));

    let url_ok = download_url
        .as_deref()
        .map(is_allowed_download_url)
        .unwrap_or(false);
    let platform_auto = if cfg!(target_os = "macos") {
        asset_name
            .as_deref()
            .map(|n| n.to_ascii_lowercase().ends_with(".app.tar.gz"))
            .unwrap_or(false)
    } else {
        cfg!(target_os = "windows")
    };
    let auto_install_supported = url_ok && platform_auto && asset_sha256.is_some();

    let result = UpdateCheckResult {
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
    };

    if let Ok(mut guard) = LAST_CHECK.get_or_init(|| Mutex::new(None)).lock() {
        *guard = Some((Instant::now(), result.clone()));
    }
    Ok(result)
}

async fn resolve_verified_server_release(
    app: &AppHandle,
    requested_url: &str,
    requested_asset: &str,
) -> Result<UpdateCheckResult, String> {
    if let Ok(guard) = LAST_CHECK.get_or_init(|| Mutex::new(None)).lock() {
        if let Some((checked_at, cached)) = guard.as_ref() {
            if checked_at.elapsed() <= CHECK_CACHE_TTL
                && cached.download_url.as_deref() == Some(requested_url)
                && cached.asset_name.as_deref() == Some(requested_asset)
            {
                return Ok(cached.clone());
            }
        }
    }
    check_app_update(app).await
}

pub async fn install_app_update(
    app: AppHandle,
    download_url: String,
    asset_name: String,
    _expected_sha256: Option<String>,
) -> Result<(), String> {
    if UPDATING.swap(true, Ordering::SeqCst) {
        return Err("正在下载或安装更新，请勿重复点击".to_string());
    }
    let _guard = UpdatingGuard;

    let res = install_app_update_inner(&app, download_url, asset_name).await;
    if let Err(ref msg) = res {
        emit_progress(&app, "error", 0, None, 0, msg.clone());
    }
    res
}

async fn install_app_update_inner(
    app: &AppHandle,
    download_url: String,
    asset_name: String,
) -> Result<(), String> {
    if !is_allowed_download_url(&download_url) {
        return Err("更新下载地址不在官方 GitHub Releases 白名单内，已拒绝".to_string());
    }
    let filename = sanitize_asset_filename(&asset_name)?;

    // Always anchor download URL, SHA-256 digest, and asset size to the official GitHub Releases metadata.
    let server = resolve_verified_server_release(app, &download_url, &filename).await?;
    if !server.has_update {
        return Err("当前已是最新版本".to_string());
    }
    if server.download_url.as_deref() != Some(download_url.as_str())
        || server.asset_name.as_deref() != Some(filename.as_str())
    {
        return Err("更新目标与官方最新发布包不匹配，已拒绝安装".to_string());
    }
    if !server.auto_install_supported {
        return Err("当前安装形态不支持应用内自动覆盖安装，请点击「发布页」手动更新".to_string());
    }
    let expected_sha256 = server
        .asset_sha256
        .as_deref()
        .filter(|s| is_valid_sha256_hex(s))
        .ok_or_else(|| "安装包缺少官方 SHA-256 摘要，请前往 GitHub Releases 手动下载".to_string())?
        .to_string();

    #[cfg(target_os = "macos")]
    ensure_macos_target_writable()?;

    let updates_dir = updates_cache_dir(app)?;
    fs::create_dir_all(&updates_dir).map_err(|e| format!("创建更新缓存目录失败：{e}"))?;
    let dest_path = updates_dir.join(&filename);
    let part_path = updates_dir.join(format!("{filename}.part.{}", std::process::id()));
    let _ = fs::remove_file(&part_path);
    let _ = fs::remove_file(&dest_path);

    let current = app.package_info().version.to_string();
    let client = build_http_client(&current, Duration::from_secs(45), true)?;
    emit_progress(&app, "downloading", 0, server.asset_size, 0, format!("正在连接并下载 {filename}…"));

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

    let total = resp.content_length().or(server.asset_size);
    let mut file = File::create(&part_path).map_err(|e| format!("创建临时安装包失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut last_emit = Instant::now();

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| {
            let _ = fs::remove_file(&part_path);
            format!("下载数据流中断：{e}")
        })?
    {
        if let Err(e) = file.write_all(&chunk) {
            let _ = fs::remove_file(&part_path);
            return Err(format!("写入安装包失败：{e}"));
        }
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
    file.flush().map_err(|e| {
        let _ = fs::remove_file(&part_path);
        format!("刷新安装包文件失败：{e}")
    })?;
    drop(file);

    if let Some(expected_len) = server.asset_size.filter(|&s| s > 0) {
        if downloaded != expected_len {
            let _ = fs::remove_file(&part_path);
            return Err(format!(
                "安装包大小不完整（实收 {downloaded} 字节，预期 {expected_len} 字节）"
            ));
        }
    }

    emit_progress(&app, "verifying", downloaded, total, 100, "正在校验安装包 SHA-256…");

    let digest = hasher.finalize();
    let mut actual = String::with_capacity(64);
    for b in digest {
        let _ = write!(actual, "{b:02x}");
    }
    if actual != expected_sha256 {
        let _ = fs::remove_file(&part_path);
        return Err("安装包 SHA-256 校验未通过，已删除异常文件".to_string());
    }

    fs::rename(&part_path, &dest_path).map_err(|e| {
        let _ = fs::remove_file(&part_path);
        format!("重命名安装包失败：{e}")
    })?;

    emit_progress(
        app,
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

    emit_progress(app, "done", downloaded, total, 100, "正在重启完成更新…");
    let app_for_exit = app.clone();
    tokio::time::sleep(Duration::from_millis(150)).await;
    app_for_exit.exit(0);
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_macos_target_writable() -> Result<(), String> {
    let current_exe =
        std::env::current_exe().map_err(|e| format!("无法获取当前程序路径：{e}"))?;
    let target_app = current_exe
        .ancestors()
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
        .ok_or_else(|| "当前并非从 .app 应用包运行，无法原地替换更新".to_string())?;
    let s = target_app.to_string_lossy();
    if s.contains("AppTranslocation") || s.starts_with("/Volumes/") {
        return Err(
            "应用当前位于只读磁盘映像或临时隔离路径，请先拖入「应用程序」文件夹后再使用应用内更新"
                .to_string(),
        );
    }
    let parent = target_app
        .parent()
        .ok_or_else(|| "无法识别 .app 所在父目录".to_string())?;
    let probe = parent.join(format!(".zspace_kit_update_probe_{}", std::process::id()));
    match fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(_) => Err(format!(
            "当前账户对 {} 没有写入权限，请点击「发布页」下载 DMG 手动替换安装",
            parent.display()
        )),
    }
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
        let params = format!("/i \"{escaped}\" /passive /promptrestart");
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
    if !lower.ends_with(".app.tar.gz") {
        return Err("macOS 自动安装仅支持 .app.tar.gz 更新包".to_string());
    }
    let current_exe =
        std::env::current_exe().map_err(|e| format!("无法获取当前程序路径：{e}"))?;
    let target_app = current_exe
        .ancestors()
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
        .ok_or_else(|| "无法定位当前 .app 路径".to_string())?;

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

    let src_app = fs::read_dir(&extract_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().and_then(|ext| ext.to_str()) == Some("app"))
        .ok_or_else(|| "更新压缩包中未找到 .app 主程序".to_string())?;

    let parent_pid = std::process::id();
    let esc_sh = |p: &Path| p.to_string_lossy().replace('\'', "'\\''");
    let backup_app = PathBuf::from(format!("{}.bak.{parent_pid}", target_app.display()));
    // Wait until parent app terminates, back up existing .app, atomically replace, and roll back on any failure.
    let sh_cmd = format!(
        "while kill -0 {pid} 2>/dev/null; do sleep 0.2; done; \
         if mv '{dst}' '{bak}'; then \
           if ditto '{src}' '{dst}'; then \
             (xattr -cr '{dst}' 2>/dev/null || true); \
             rm -rf '{bak}'; \
             open '{dst}'; \
           else \
             rm -rf '{dst}'; \
             mv '{bak}' '{dst}'; \
             exit 1; \
           fi; \
         else \
           exit 1; \
         fi",
        pid = parent_pid,
        src = esc_sh(&src_app),
        dst = esc_sh(target_app),
        bak = esc_sh(&backup_app),
    );
    std::process::Command::new("/bin/sh")
        .args(["-c", &sh_cmd])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 macOS 替换脚本失败：{e}"))?;
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
    fn semver_ordering_handles_v_prefix_segments_and_prerelease() {
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
        assert_eq!(
            compare_semver("0.8.0-rc.1", "0.8.0"),
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
        assert!(!is_allowed_download_url("https://github.com/garyhj/ZSpaceMemo/issues/1"));
        assert!(!is_allowed_download_url("https://evil.example.com/setup.exe"));
        assert!(is_valid_sha256_hex(&"a".repeat(64)));
        assert!(!is_valid_sha256_hex("not-hex"));
    }
}
