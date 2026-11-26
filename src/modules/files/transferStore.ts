import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import type { UploadBatchProgress } from "../../types";

export interface TransferJob {
  id: string;
  direction: "upload" | "download";
  name: string;
  localPath: string;
  remotePath: string; // upload: destDir; download: nasPath
  status: "queued" | "running" | "done" | "error";
  error?: string;
}

interface TransferStoreSnapshot {
  jobs: TransferJob[];
  batchStatus: string;
}

let state: TransferStoreSnapshot = {
  jobs: [],
  batchStatus: "",
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function upsertTransferJob(job: TransferJob) {
  const idx = state.jobs.findIndex((j) => j.id === job.id);
  let nextJobs: TransferJob[];
  if (idx >= 0) {
    nextJobs = [...state.jobs];
    nextJobs[idx] = job;
  } else {
    nextJobs = [job, ...state.jobs].slice(0, 40);
  }
  state = { ...state, jobs: nextJobs };
  emit();
}

export function removeTransferJob(id: string) {
  const nextJobs = state.jobs.filter((j) => j.id !== id);
  if (nextJobs.length === state.jobs.length) return;
  state = { ...state, jobs: nextJobs };
  emit();
}

export function clearTransferJobs() {
  if (state.jobs.length === 0) return;
  state = { ...state, jobs: [] };
  emit();
}

export function setTransferBatchStatus(batchStatus: string) {
  if (state.batchStatus === batchStatus) return;
  state = { ...state, batchStatus };
  emit();
}

let unlistenPromise: Promise<UnlistenFn> | null = null;

export function initTransferListener() {
  if (unlistenPromise) return;
  unlistenPromise = listen<UploadBatchProgress>("files:transfer-progress", (ev) => {
    const p = ev.payload;
    setTransferBatchStatus(
      p.status === "uploading" ? `正在上传 (${p.current}/${p.total})：${p.name}` : ""
    );
    upsertTransferJob({
      id: p.job_id,
      direction: "upload",
      name: p.name,
      localPath: p.local_path,
      remotePath: p.dest_dir,
      status: p.status === "uploading" ? "running" : p.status === "done" ? "done" : "error",
      error: p.error ?? undefined,
    });
  }).catch((err) => {
    unlistenPromise = null;
    throw err;
  });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): TransferStoreSnapshot {
  return state;
}

export function useTransferStore(): TransferStoreSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
