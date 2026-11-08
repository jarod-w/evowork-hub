/** macOS 发版机：安装每小时检查/失败重试的 LaunchAgent；不用 shell 拼命令或 CI 私钥。 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkPin, evoworkDir, HUB_ROOT } from "./evowork.ts";
import { DEFAULTS, option, readState, sourceRevision } from "./publication.ts";

const argv = process.argv.slice(2);
if (process.platform !== "darwin")
  throw new Error(
    "此安装器只支持 macOS 发版机；Linux 请按运维文档配置 systemd",
  );
checkPin(true);
const stateDir = option(argv, "--state-dir", DEFAULTS.stateDir);
const state = readState(stateDir);
if (!state?.revision || state.pending || state.revision !== sourceRevision())
  throw new Error("请先成功执行正常 release，确认批准记录与内容一致");
const label = "cn.nucleant.evowork-hub-renew";
const logDir = join(stateDir, "logs");
const out = option(
  argv,
  "--out",
  join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
);
const xml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const args = [
  process.execPath,
  createRequire(import.meta.url).resolve("tsx/cli"),
  join(HUB_ROOT, "pipeline", "renew-index.ts"),
  "--state-dir",
  stateDir,
];
for (const key of [
  "--origin",
  "--ssh",
  "--key",
  "--kid",
  "--creds",
  "--tunnel-port",
]) {
  if (argv.includes(key)) args.push(key, option(argv, key, ""));
}
mkdirSync(logDir, { recursive: true, mode: 0o700 });
mkdirSync(join(out, ".."), { recursive: true });
if (existsSync(out) && !argv.includes("--replace"))
  throw new Error(`计划已存在，检查后使用 --replace 更新：${out}`);
writeFileSync(
  out,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(HUB_ROOT)}</string>
<key>EnvironmentVariables</key><dict><key>EVOWORK_DIR</key><string>${xml(evoworkDir())}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>3600</integer>
<key>StandardOutPath</key><string>${xml(join(logDir, "renew.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logDir, "renew-error.log"))}</string>
</dict></plist>\n`,
  { mode: 0o600 },
);
execFileSync("/usr/bin/plutil", ["-lint", out], { stdio: "inherit" });
if (argv.includes("--install")) {
  const domain = `gui/${process.getuid!()}`;
  if (argv.includes("--replace")) {
    try {
      execFileSync("/bin/launchctl", ["bootout", `${domain}/${label}`], {
        stdio: "ignore",
      });
    } catch {
      /* 尚未加载 */
    }
  }
  execFileSync("/bin/launchctl", ["bootstrap", domain, out], {
    stdio: "inherit",
  });
  process.stdout.write(`已启用 ${label}，每小时检查；日志：${logDir}\n`);
} else process.stdout.write(`已生成计划，尚未加载：${out}\n`);
