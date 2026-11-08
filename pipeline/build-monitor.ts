/** 构建只含公钥的单文件监测程序；目标机器只需 Node，不需仓库或签名材料。 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { checkPin, evoworkDir, HUB_ROOT } from "./evowork.ts";

process.stdout.write(`${checkPin(true).message}\n`);
const { build } = createRequire(join(evoworkDir(), "package.json"))(
  "esbuild",
) as typeof import("../../evowork/node_modules/esbuild/lib/main.js");
const source = `
import { fetchIndexText, verifyIndex, indexHealth, monitorEvent } from './pipeline/index-reader.ts';
import { verifyHubIndex } from ${JSON.stringify(join(evoworkDir(), "packages/hub-protocol/src/index.ts"))};
import { OFFICIAL_HUB_KEYS } from ${JSON.stringify(join(evoworkDir(), "apps/desktop/src/main/hub-config.ts"))};
const origin = (process.argv[2] ?? 'https://hub.nucleant.cn').replace(/\\/+$/, '');
try {
  const raw = await fetchIndexText(origin);
  const live = verifyIndex(raw, OFFICIAL_HUB_KEYS, verifyHubIndex);
  const result = indexHealth(live.payload, Math.floor(Date.now()/1000));
  process.stdout.write(JSON.stringify(monitorEvent(origin,result))+'\\n');
  process.exitCode = result.exitCode;
} catch(error) {
  process.stderr.write(JSON.stringify(monitorEvent(origin,{status:'unavailable',exitCode:4,message:error instanceof Error?error.message:String(error)}))+'\\n');
  process.exitCode = 4;
}
`;
await build({
  stdin: {
    contents: source,
    resolveDir: HUB_ROOT,
    sourcefile: "monitor-entry.mjs",
  },
  outfile: join(HUB_ROOT, "dist", "monitor-index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "info",
});
