import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import type { AuthStatus, OAuthStartInfo } from "../types";

interface Props {
  onAuthenticated: (status: AuthStatus) => Promise<void>;
}

export function AuthScreen({ onAuthenticated }: Props) {
  const [oauth, setOAuth] = useState<OAuthStartInfo | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("点击下方按钮发起官方 OAuth2 授权。");

  async function handleStart() {
    setBusy(true);
    setMessage("正在向极空间官方服务发起授权事务…");
    try {
      const info = await api.startOAuthLogin();
      setOAuth(info);
      setMessage(`请在 ${info.expires_in} 秒内完成浏览器授权，并将一次性授权码粘贴到下方。`);
      try {
        await openUrl(info.url);
      } catch {
        // Fallback: user can click the link manually.
      }
    } catch (e) {
      setMessage(`发起授权失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit() {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    setMessage("正在验证一次性授权码并初始化极空间记事本…");
    try {
      const st = await api.submitOAuthCode(trimmed);
      setCode("");
      setOAuth(null);
      await onAuthenticated(st);
    } catch (e) {
      setMessage(`授权失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">ZSpace Memo</h1>
            <p className="text-xs text-slate-500">基于极空间原生记事本的桌面任务管理</p>
          </div>
        </div>

        <p className="text-sm text-slate-600 leading-relaxed">
          使用极空间官方 OAuth2 授权登录，全程不接触、不保存 NAS 账号密码；所有任务以可读笔记形式保存在你的极空间原生记事本中。
        </p>

        {!oauth ? (
          <button
            disabled={busy}
            onClick={handleStart}
            className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "正在生成授权链接…" : "发起极空间官方授权"}
          </button>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs space-y-1.5">
              <div className="font-medium text-slate-700">
                1. 浏览器中完成授权（{oauth.expires_in} 秒内有效）：
              </div>
              <button
                type="button"
                onClick={() => void openUrl(oauth.url)}
                className="inline-flex items-center gap-1 text-left text-blue-600 underline break-all"
              >
                <span>{oauth.url}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </button>
            </div>

            <input
              type="text"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleSubmit()}
              placeholder="2. 粘贴页面给出的一次性授权码（如 XXXX-XXXX-XXXX-XXXX）"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />

            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={handleStart}
                className="rounded-xl border border-slate-300 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
              >
                重新获取链接
              </button>
              <button
                type="button"
                disabled={busy || !code.trim()}
                onClick={handleSubmit}
                className="flex-1 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? "登录中…" : "完成授权"}
              </button>
            </div>
          </div>
        )}

        <div className="text-xs text-slate-500">{message}</div>
      </div>
    </div>
  );
}
