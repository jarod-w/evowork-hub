/** 公开目录的只读读取与校验；可打包到不持私钥的独立监测机。 */
import type { HubProtocol } from "./evowork.ts";

export type PinnedKey = Parameters<HubProtocol["verifyHubIndex"]>[1][number];
export type IndexPayload = NonNullable<
  ReturnType<HubProtocol["parseHubIndexPayload"]>
>;
export interface LiveIndex {
  readonly raw: string;
  readonly payload: IndexPayload;
}

export function verifyIndex(
  raw: string,
  keys: readonly PinnedKey[],
  verify: HubProtocol["verifyHubIndex"],
): LiveIndex {
  const checked = verify(JSON.parse(raw), keys);
  if (!checked.ok) throw new Error(`目录验签失败：${checked.reason}`);
  if (checked.payload.source.id !== "evowork")
    throw new Error("目录来源不是 evowork");
  return { raw, payload: checked.payload };
}

export async function fetchIndexText(
  origin: string,
  allowMissing = false,
): Promise<string | undefined> {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
  )
    throw new Error("Hub 地址必须使用 HTTPS");
  const res = await fetch(`${origin}/v1/evowork/index.json`, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: { "cache-control": "no-cache" },
  });
  if (allowMissing && res.status === 404) return undefined;
  if (res.status !== 200) throw new Error(`取线上目录失败：HTTP ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error("线上目录没有正文");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 8 * 1024 * 1024) throw new Error("线上目录超过 8 MiB");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function indexHealth(payload: IndexPayload, now: number) {
  const remainingSeconds = payload.expiresAt - now;
  const status =
    payload.issuedAt > now + 300
      ? "clock-error"
      : remainingSeconds <= 0
        ? "expired"
        : remainingSeconds < 24 * 3600
          ? "critical"
          : remainingSeconds < 48 * 3600
            ? "warning"
            : "healthy";
  const exitCode = {
    healthy: 0,
    warning: 1,
    critical: 2,
    expired: 3,
    "clock-error": 4,
  }[status];
  return {
    status,
    exitCode,
    sequence: payload.sequence,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    remainingSeconds,
  };
}

/** 稳定的告警接入接口：每次检查一行 JSON；默认只输出到日志，不调用通知服务。 */
export function monitorEvent(
  origin: string,
  result:
    | ReturnType<typeof indexHealth>
    | { status: "unavailable"; exitCode: 4; message: string },
  checkedAt = new Date().toISOString(),
) {
  return {
    schemaVersion: 1 as const,
    event: "evowork.hub.catalog.health" as const,
    origin,
    checkedAt,
    ...result,
  };
}
