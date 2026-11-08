/** 正常内容发布：批准本机内容 → 包 → 离线目录 → 在线目录 → 回读 → 保存批准记录。 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { HUB_ROOT } from "./evowork.ts";
import { publish } from "./publish.ts";
import { signPayload } from "./sign.ts";
import { putObject } from "./s3put.ts";
import {
  checkReleasePin,
  DEFAULTS,
  option,
  pinnedKeys,
  readLiveIndex,
  readState,
  reconcileState,
  sameIndex,
  sourceRevision,
  uploadPending,
  verifiedIndex,
  withPublicationLock,
  withUploadTarget,
  type PublicationState,
} from "./publication.ts";

export async function release(argv: readonly string[]) {
  checkReleasePin();
  const stateDir = option(argv, "--state-dir", DEFAULTS.stateDir);
  return withPublicationLock(stateDir, async () => {
    const revision = sourceRevision();
    const origin = option(argv, "--origin", DEFAULTS.origin).replace(
      /\/+$/,
      "",
    );
    const pinned = await pinnedKeys();
    const readLive = () => readLiveIndex(origin, pinned, true);
    const live = await readLive();
    const recorded = readState(stateDir);
    const state: PublicationState = recorded
      ? await reconcileState(recorded, live, origin, pinned)
      : { origin, online: live?.raw };
    // 手动发布可覆盖失败的待发布项，但跳过它已用过的序号，避免同序号出现两份正文。
    const pending = state.pending
      ? await verifiedIndex(state.pending.online, pinned)
      : undefined;
    const sequence =
      Math.max(live?.payload.sequence ?? 0, pending?.payload.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence))
      throw new Error("目录序号超出安全整数范围");
    const outDir = join(HUB_ROOT, "dist");
    const now = Math.floor(Date.now() / 1000);
    if (live && live.payload.issuedAt > now + 300)
      throw new Error("线上签发时间在未来，请检查时钟");
    process.stdout.write(
      `线上序号 ${live?.payload.sequence ?? 0} → 这次 ${sequence}\n`,
    );
    const built = await publish({
      contentDir: join(HUB_ROOT, "content"),
      outDir,
      sequence,
      now,
      ...(live ? { previous: live.payload } : {}),
    });
    const indexDir = join(outDir, "v1", "evowork");
    let online = "";
    for (const [payload, index] of [
      ["payload.online.json", "index.json"],
      ["payload.offline.json", "index.offline.json"],
    ] as const) {
      const raw = await signPayload({
        keyPath: option(argv, "--key", DEFAULTS.key),
        kid: option(argv, "--kid", DEFAULTS.kid),
        payloadText: readFileSync(join(outDir, payload), "utf8"),
      });
      await verifiedIndex(raw, pinned);
      writeFileSync(join(indexDir, index), raw);
      if (index === "index.json") online = raw;
    }
    const next = await verifiedIndex(online, pinned);
    for (const item of next.payload.items) {
      if (!("path" in item.package)) continue;
      const prior = live?.payload.items.find(
        (i) =>
          i.kind === item.kind &&
          i.id === item.id &&
          i.version === item.version,
      );
      if (
        prior &&
        "path" in prior.package &&
        prior.package.sha256 !== item.package.sha256
      )
        throw new Error(
          `${item.id} 的同版本内容发生变化，请先升级条目版本；不能覆盖已发布内容包`,
        );
    }
    process.stdout.write(`打包 ${built.items} 个条目；两份索引已签名并验签\n`);
    if (argv.includes("--dry-run")) {
      process.stdout.write(
        `--dry-run：不上传、不改变批准记录。产物在 ${indexDir}\n`,
      );
      return;
    }
    if (sourceRevision() !== revision)
      throw new Error("打包过程中内容发生变化，停止发布");
    if (!sameIndex((await readLive())?.raw, live?.raw))
      throw new Error("打包过程中线上目录发生变化，停止发布");
    await withUploadTarget(argv, async (target) => {
      const pkgs = next.payload.items.flatMap((item) =>
        "path" in item.package ? [item.package.path] : [],
      );
      for (const path of pkgs)
        await putObject(
          target,
          `v1/evowork/${path}`,
          readFileSync(join(indexDir, path)),
          "application/gzip",
        );
      await putObject(
        target,
        "v1/evowork/index.offline.json",
        readFileSync(join(indexDir, "index.offline.json")),
        "application/json",
      );
      if (sourceRevision() !== revision)
        throw new Error("上传过程中内容发生变化，停止发布在线目录");
      // 从此处开始，续发任务可安全恢复这份目录：其指向的包与离线目录已上传。
      await uploadPending({
        stateDir,
        state: { ...state, pending: { online, revision } },
        readLive,
        upload: (raw) =>
          putObject(
            target,
            "v1/evowork/index.json",
            Buffer.from(raw),
            "application/json",
          ),
      });
      process.stdout.write(`上传了 ${pkgs.length} 个内容包 + 两份索引\n`);
    });
    process.stdout.write(
      `线上完整目录验证通过，批准记录已保存：序号 ${sequence}\n`,
    );
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  release(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `发布失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
