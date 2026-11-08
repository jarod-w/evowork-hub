/** 只读监测；只需客户端公钥，不读取私钥、上传凭据或发版机检查点。 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULTS, option, pinnedKeys, readLiveIndex } from "./publication.ts";
import { indexHealth, monitorEvent } from "./index-reader.ts";
export { indexHealth } from "./index-reader.ts";

async function main(argv: readonly string[]) {
  try {
    const origin = option(argv, "--origin", DEFAULTS.origin).replace(
      /\/+$/,
      "",
    );
    const live = await readLiveIndex(origin, await pinnedKeys());
    if (!live) throw new Error("目录不存在");
    const result = indexHealth(live.payload, Math.floor(Date.now() / 1000));
    process.stdout.write(`${JSON.stringify(monitorEvent(origin, result))}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    const i = argv.indexOf("--origin");
    const origin = i >= 0 ? (argv[i + 1] ?? DEFAULTS.origin) : DEFAULTS.origin;
    process.stderr.write(
      `${JSON.stringify(monitorEvent(origin, { status: "unavailable", exitCode: 4, message: error instanceof Error ? error.message : String(error) }))}\n`,
    );
    process.exitCode = 4;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main(process.argv.slice(2));
}
