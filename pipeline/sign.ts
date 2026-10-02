/**
 * G7（后半）：**在离线签名机上**给 payload 签名（evowork 13 §4.3，CLAUDE.md H2）。
 *
 * ```bash
 * pnpm tsx pipeline/sign.ts --key /secure/evowork-hub-2026a.pem --kid evowork-hub-2026a \
 *   --in dist/payload.online.json --out dist/v1/evowork/index.json
 * pnpm tsx pipeline/sign.ts --key … --kid … --in dist/payload.offline.json --out dist/v1/evowork/index.offline.json
 * ```
 *
 * 签的是 payload 文件的**原文**（去掉末尾换行），不重新编码 —— 客户端对同一段字符串验签。
 *
 * 守住的几条：
 * - 私钥文件在本仓库目录里 → 拒绝（H2：私钥永远不进仓库）。
 * - 环境变量里放私钥 → 不支持（H2：也不进 CI 的环境变量）。只接受文件路径。
 * - 签之前用客户端的解析器过一遍：不认的 payload 不签。
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { evoworkDir, HUB_ROOT, loadHubProtocol } from './evowork.ts';

export async function signPayload(input: {
  readonly keyPath: string;
  readonly kid: string;
  readonly payloadText: string;
}): Promise<string> {
  const hub = await loadHubProtocol();
  const key = realpathSync(resolve(input.keyPath));
  const rel = relative(realpathSync(HUB_ROOT), key);
  if (!rel.startsWith('..')) {
    throw new Error('私钥文件在 evowork-hub 仓库目录里。私钥永远不进仓库（CLAUDE.md H2），挪到仓库外面再签');
  }
  const payloadJson = input.payloadText.replace(/\n$/, '');
  if (hub.parseHubIndexPayload(payloadJson) === undefined) {
    throw new Error('payload 不符合索引协议，不签');
  }
  const { signEnvelope } = await import(
    pathToFileURL(resolve(evoworkDir(), 'packages', 'account', 'src', 'envelope.ts')).href
  );
  const envelope = (signEnvelope as (pem: string, json: string, kid: string) => unknown)(
    readFileSync(key, 'utf8'),
    payloadJson,
    input.kid,
  );
  return `${JSON.stringify(envelope)}\n`;
}

async function main(argv: readonly string[]) {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const keyPath = arg('--key');
  const kid = arg('--kid');
  const inPath = arg('--in');
  const outPath = arg('--out');
  if (!keyPath || !kid || !inPath || !outPath) {
    throw new Error('用法：--key <私钥 pem 路径> --kid <kid> --in <payload.json> --out <index.json>');
  }
  writeFileSync(outPath, await signPayload({ keyPath, kid, payloadText: readFileSync(inPath, 'utf8') }));
  process.stdout.write(`▸ 已签：${outPath}（kid ${kid}）\n`);
}

if (process.argv[1]?.endsWith('sign.ts')) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
