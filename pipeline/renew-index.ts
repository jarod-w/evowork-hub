/** 仅续发已批准的在线目录。内容/吊销变更仍走 release，私钥不进入 CI。 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { signPayload } from "./sign.ts";
import {
  checkReleasePin,
  DEFAULTS,
  ONLINE_TTL_SEC,
  RENEW_BEFORE_SEC,
  option,
  pinnedKeys,
  readLiveIndex,
  readState,
  reconcileState,
  sameIndex,
  sourceRevision,
  uploadOnline,
  uploadPending,
  verifiedIndex,
  withPublicationLock,
  writeState,
  type LiveIndex,
  type PinnedKey,
} from "./publication.ts";

export interface RenewInput {
  origin: string;
  stateDir: string;
  keys: readonly PinnedKey[];
  keyPath: string;
  kid: string;
  now: number;
  dryRun?: boolean;
  revision: () => string;
  readLive: () => Promise<LiveIndex | undefined>;
  upload: (raw: string) => Promise<void>;
}

export async function renewIndex(
  input: RenewInput,
): Promise<{
  status: "skipped" | "renewed" | "resumed" | "dry-run";
  sequence: number;
  expiresAt: number;
}> {
  return withPublicationLock(input.stateDir, async () => {
    const recorded = readState(input.stateDir);
    if (!recorded)
      throw new Error(
        "没有批准记录；请先在发版机执行正常 release，不能直接信任线上旧目录并续签",
      );
    const live = await input.readLive();
    if (!live) throw new Error("线上目录不存在，停止续发");
    const state = await reconcileState(
      recorded,
      live,
      input.origin,
      input.keys,
    );
    const revision = input.revision();
    if (revision !== (state.pending?.revision ?? state.revision))
      throw new Error("内容或吊销记录与批准版本不同；请先执行正常 release");
    if (live.payload.issuedAt > input.now + 300)
      throw new Error("目录签发时间在未来，请检查发版机时钟");
    if (!input.dryRun && !sameIndex(recorded.online, state.online))
      writeState(input.stateDir, state);

    let raw: string;
    let status: "renewed" | "resumed";
    if (state.pending) {
      raw = state.pending.online;
      const pending = await verifiedIndex(raw, input.keys);
      if (pending.payload.expiresAt <= input.now)
        throw new Error(
          "待发布目录已过期，请执行正常 release 跳过此序号并恢复",
        );
      status = "resumed";
    } else {
      if (live.payload.expiresAt - input.now > RENEW_BEFORE_SEC)
        return {
          status: "skipped",
          sequence: live.payload.sequence,
          expiresAt: live.payload.expiresAt,
        };
      if (!Number.isSafeInteger(live.payload.sequence + 1))
        throw new Error("目录序号超出安全整数范围");
      // 用签名原文保留全部字段，避免解析器忽略的扩展字段被静默删掉。
      const original = JSON.parse(JSON.parse(live.raw).payloadJson);
      raw = await signPayload({
        keyPath: input.keyPath,
        kid: input.kid,
        payloadText: JSON.stringify({
          ...original,
          sequence: live.payload.sequence + 1,
          issuedAt: input.now,
          expiresAt: input.now + ONLINE_TTL_SEC,
        }),
      });
      status = "renewed";
    }
    const next = await verifiedIndex(raw, input.keys);
    if (input.dryRun)
      return {
        status: "dry-run",
        sequence: next.payload.sequence,
        expiresAt: next.payload.expiresAt,
      };
    if (input.revision() !== revision)
      throw new Error("续发过程中内容发生变化，停止上传");
    await uploadPending({
      stateDir: input.stateDir,
      state: { ...state, pending: { online: raw, revision } },
      readLive: input.readLive,
      upload: input.upload,
    });
    return {
      status,
      sequence: next.payload.sequence,
      expiresAt: next.payload.expiresAt,
    };
  });
}

async function main(argv: readonly string[]) {
  checkReleasePin();
  const keys = await pinnedKeys();
  const origin = option(argv, "--origin", DEFAULTS.origin).replace(/\/+$/, "");
  const result = await renewIndex({
    origin,
    keys,
    stateDir: option(argv, "--state-dir", DEFAULTS.stateDir),
    keyPath: option(argv, "--key", DEFAULTS.key),
    kid: option(argv, "--kid", DEFAULTS.kid),
    now: Math.floor(Date.now() / 1000),
    dryRun: argv.includes("--dry-run"),
    revision: sourceRevision,
    readLive: () => readLiveIndex(origin, keys),
    upload: (raw) => uploadOnline(argv, raw),
  });
  process.stdout.write(
    `${JSON.stringify({ ...result, checkedAt: new Date().toISOString() })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `续发失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
