import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { parseHubIndexPayload, sha256Hex, unpackTarGz } from '../../../evowork/packages/hub-protocol/src/index.ts';
import { HUB_ROOT } from '../evowork.ts';
import { publish } from '../publish.ts';

it('Kimi 发布包能被客户端解包，且禁用用户包后从安装副本启动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ew-kimi-package-'));
  try {
    await publish({ contentDir: join(HUB_ROOT, 'content'), outDir: dir, sequence: 1, now: 1_800_000_000 });
    const payload = parseHubIndexPayload(readFileSync(join(dir, 'payload.online.json'), 'utf8'));
    const item = payload?.items.find((entry) => entry.id === 'open-kimi-ppt');
    expect(item?.interface.displayName).toBe('Kimi 演示文稿');
    if (!item || !('path' in item.package)) throw new Error('missing hosted skill');
    const bytes = readFileSync(join(dir, 'v1/evowork', item.package.path));
    expect(sha256Hex(bytes)).toBe(item.package.sha256);
    const unpacked = unpackTarGz(bytes);
    if (!unpacked.ok) throw new Error(unpacked.reason);
    const paths = unpacked.files.map((file) => file.path);
    expect(paths).toContain('scripts/vendor/yaml/LICENSE');
    expect(paths).toContain('scripts/vendor/websocket/LICENSE');
    expect(paths).not.toContain('hub.json');
    const metadata = unpacked.files.find((file) => file.path === 'interface.json');
    expect(JSON.parse(Buffer.from(metadata?.bytes ?? []).toString('utf8')).runtimeDependencies).toEqual(['office']);
    expect(item.minAppVersion).toBe('0.0.6');
    expect(paths.some((path) => /\.(so|pyc|exe|dylib)$/.test(path))).toBe(false);
    for (const file of unpacked.files) {
      const target = join(dir, 'installed', file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
    const output = execFileSync('python3', ['-s', join(dir, 'installed/scripts/export_pptx.py'), '--help'], {
      encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 10_000,
    });
    expect(output).toContain('office runtime');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
