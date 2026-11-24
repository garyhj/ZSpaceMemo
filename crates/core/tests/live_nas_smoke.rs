use std::path::PathBuf;
use zspace_memo_core::provider::official_cli::OfficialCliNotebookProvider;
use zspace_memo_core::provider::NotebookProvider;

/// Read-only smoke test against a real logged-in `zspace-cli` profile.
/// Run manually with:
///   ZSPACE_CLI_BIN=... ZSPACE_CLI_HOME=... cargo test -p zspace-memo-core --test live_nas_smoke -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn live_nas_readonly_auth_and_categories() {
    let cli_bin = std::env::var("ZSPACE_CLI_BIN").expect("set ZSPACE_CLI_BIN");
    let cli_home = std::env::var("ZSPACE_CLI_HOME").expect("set ZSPACE_CLI_HOME");
    let profile = std::env::var("ZSPACE_PROFILE").unwrap_or_else(|_| "zspace-memo".into());

    let provider =
        OfficialCliNotebookProvider::new(PathBuf::from(cli_bin), PathBuf::from(cli_home), profile);

    let status = provider.auth_status().await.expect("auth_status failed");
    assert!(status.logged_in, "profile must be logged in");

    let cats = provider
        .list_categories()
        .await
        .expect("list_categories failed");
    assert!(!cats.is_empty(), "expected at least one category on NAS");
    println!(
        "Live NAS OK: nas_id={:?}, categories={:?}",
        status.nas_id,
        cats.iter().map(|c| (&c.id, &c.name)).collect::<Vec<_>>()
    );
}
