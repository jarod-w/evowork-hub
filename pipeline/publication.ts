/** 发版机共用的验签、发布锁和上传检查点；这里不保存私钥或上传凭据。 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { checkPin, evoworkDir, HUB_ROOT, loadHubProtocol } from "./evowork.ts";
import {
  fetchIndexText,
  verifyIndex,
  type LiveIndex,
  type PinnedKey,
} from "./index-reader.ts";
import { putObject, type S3Target } from "./s3put.ts";

export const ONLINE_TTL_SEC = 7 * 24 * 3600;
export const RENEW_BEFORE_SEC = 72 * 3600;
export const DEFAULTS = {
  origin: "https://hub.nucleant.cn",
  ssh: "root@43.143.248.70",
  key: join(homedir(), ".evowork-hub-keys", "evowork-hub-1.pem"),
  kid: "evowork-hub-1",
  creds: join(homedir(), ".evowork-hub-keys", "minio-publisher.env"),
  stateDir: join(homedir(), ".evowork-hub-release"),
};
export type { PinnedKey, IndexPayload, LiveIndex } from "./index-reader.ts";
export interface PublicationState {
  readonly origin: string;
  readonly online?: string;
  readonly revision?: string;
  /** 包与离线目录就绪之后才记录；失败后重试这份原文，不重签同序号。 */
  readonly pending?: { readonly online: string; readonly revision: string };
}

export async function pinnedKeys(): Promise<readonly PinnedKey[]> {
  const mod = await import(
    pathToFileURL(join(evoworkDir(), "apps/desktop/src/main/hub-config.ts"))
      .href
  );
  return mod.OFFICIAL_HUB_KEYS;
}

export function checkReleasePin(): void {
  process.stdout.write(`${checkPin(true).message}\n`);
  const dirty = execFileSync(
    "git",
    [
      "-C",
      evoworkDir(),
      "status",
      "--porcelain",
      "--",
      "apps/desktop/src/main/hub-config.ts",
      "services/catalog/src",
      "packages/hub-protocol/src",
      "packages/account/src",
    ],
    { encoding: "utf8" },
  ).trim();
  if (dirty) throw new Error(`发布依赖有未提交改动，拒绝签名：\n${dirty}`);
}

/** 不把自动 git pull 接到签名任务；内容/吊销改变必须先经过正常发布。 */
export function sourceRevision(root = HUB_ROOT): string {
  const paths = ["content", "upstream.yaml", "revoked.yaml", "evowork.lock"];
  const dirty = execFileSync(
    "git",
    [
      "-C",
      root,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ...paths,
    ],
    { encoding: "utf8" },
  ).trim();
  if (dirty)
    throw new Error(
      `内容、吊销或依赖记录有未提交改动，拒绝发布/续发：\n${dirty}`,
    );
  const hash = createHash("sha256");
  const visit = (path: string): void => {
    const full = join(root, path);
    if (!existsSync(full)) {
      hash.update(`${path}\0missing\0`);
      return;
    }
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`发布内容不允许软链接：${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(full).sort()) {
        if (![".git", ".DS_Store", "node_modules"].includes(name))
          visit(`${path}/${name}`);
      }
    } else {
      hash.update(`${path}\0${stat.size}\0`);
      hash.update(readFileSync(full));
    }
  };
  paths.forEach(visit);
  return hash.digest("hex");
}

export async function verifiedIndex(
  raw: string,
  keys: readonly PinnedKey[],
): Promise<LiveIndex> {
  const hub = await loadHubProtocol();
  return verifyIndex(raw, keys, hub.verifyHubIndex);
}

export async function readLiveIndex(
  origin: string,
  keys: readonly PinnedKey[],
  allowMissing = false,
): Promise<LiveIndex | undefined> {
  const raw = await fetchIndexText(origin, allowMissing);
  return raw === undefined ? undefined : verifiedIndex(raw, keys);
}

/** 比较被签名的完整正文，允许信封格式化或同正文重新签名。 */
export function sameIndex(
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.parse(a).payloadJson === JSON.parse(b).payloadJson;
}

export function readState(stateDir: string): PublicationState | undefined {
  const path = join(stateDir, "state.json");
  if (!existsSync(path)) return undefined;
  const state = JSON.parse(readFileSync(path, "utf8")) as PublicationState;
  if (
    typeof state.origin !== "string" ||
    (state.online !== undefined && typeof state.online !== "string") ||
    (state.revision !== undefined && typeof state.revision !== "string") ||
    (state.pending !== undefined &&
      (typeof state.pending.online !== "string" ||
        typeof state.pending.revision !== "string"))
  )
    throw new Error("发布检查点格式错误");
  return state;
}

export function writeState(stateDir: string, state: PublicationState): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temp = join(stateDir, `state.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, join(stateDir, "state.json"));
}

export async function withPublicationLock<T>(
  stateDir: string,
  task: () => Promise<T>,
): Promise<T> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, "publish.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `另一个发布/续发正在运行；异常退出后确认进程已停止再清理锁：${lock}`,
      );
    throw error;
  }
  try {
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    return await task();
  } finally {
    rmSync(lock, { recursive: true });
  }
}

/** 未知线上内容（包括回退）不自动采纳。上传成功但回读失败可在下一次完成检查点。 */
export async function reconcileState(
  state: PublicationState,
  live: LiveIndex | undefined,
  origin: string,
  keys: readonly PinnedKey[],
): Promise<PublicationState> {
  if (state.origin !== origin) throw new Error("发布检查点的源地址与本次不同");
  if (state.online) await verifiedIndex(state.online, keys);
  if (state.pending) await verifiedIndex(state.pending.online, keys);
  if (state.pending && sameIndex(state.pending.online, live?.raw)) {
    return {
      origin,
      online: state.pending.online,
      revision: state.pending.revision,
    };
  }
  if (!sameIndex(state.online, live?.raw))
    throw new Error(
      "线上目录与批准记录不一致（可能回退或被其他发布替换），停止发布/续发",
    );
  return state;
}

export async function uploadPending(input: {
  stateDir: string;
  state: PublicationState;
  readLive: () => Promise<LiveIndex | undefined>;
  upload: (raw: string) => Promise<void>;
}): Promise<PublicationState> {
  const pending = input.state.pending;
  if (!pending) throw new Error("没有待发布目录");
  if (!sameIndex((await input.readLive())?.raw, input.state.online))
    throw new Error("上传前线上目录已经改变，停止发布");
  writeState(input.stateDir, input.state);
  await input.upload(pending.online);
  if (!sameIndex((await input.readLive())?.raw, pending.online))
    throw new Error("上传后线上目录与待发布原文不一致；保留检查点供重试");
  const complete = {
    origin: input.state.origin,
    online: pending.online,
    revision: pending.revision,
  };
  writeState(input.stateDir, complete);
  return complete;
}

export function option(
  argv: readonly string[],
  key: string,
  fallback: string,
): string {
  const i = argv.indexOf(key);
  if (i < 0) return fallback;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${key} 缺少参数`);
  return value;
}

async function openTunnel(ssh: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    "ssh",
    [
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      "-L",
      `${port}:127.0.0.1:9000`,
      ssh,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let failed = false;
  child.on("error", () => {
    failed = true;
  });
  child.stderr?.resume();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (failed || child.exitCode !== null) break;
    try {
      // 隧道占用端口时不能误用另一个进程的服务。
      const res = await fetch(`http://127.0.0.1:${port}/minio/health/live`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.status === 200 && child.exitCode === null && !failed)
        return child;
    } catch {
      /* 等待隧道 */
    }
  }
  child.kill();
  throw new Error(`SSH 隧道不可用：${ssh}`);
}

export async function withUploadTarget<T>(
  argv: readonly string[],
  action: (target: S3Target) => Promise<T>,
): Promise<T> {
  const text = readFileSync(option(argv, "--creds", DEFAULTS.creds), "utf8");
  const accessKey = /^HUB_S3_ACCESS_KEY=(.+)$/m.exec(text)?.[1]?.trim();
  const secretKey = /^HUB_S3_SECRET_KEY=(.+)$/m.exec(text)?.[1]?.trim();
  if (!accessKey || !secretKey) throw new Error("上传凭据缺少必要字段");
  const port = Number(option(argv, "--tunnel-port", "19000"));
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("隧道端口无效");
  const tunnel = await openTunnel(option(argv, "--ssh", DEFAULTS.ssh), port);
  try {
    return await action({
      endpoint: `http://127.0.0.1:${port}`,
      bucket: "hub",
      accessKey,
      secretKey,
    });
  } finally {
    tunnel.kill();
  }
}

export async function uploadOnline(
  argv: readonly string[],
  raw: string,
): Promise<void> {
  await withUploadTarget(argv, (target) =>
    putObject(
      target,
      "v1/evowork/index.json",
      Buffer.from(raw),
      "application/json",
    ),
  );
}
