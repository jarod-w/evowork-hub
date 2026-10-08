import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { HUB_ROOT } from '../evowork.ts';

it('Kimi 技能：禁用用户包后可加载随包依赖，且导出、隔离和缺组件错误回归通过', () => {
  expect(() => execFileSync(process.env.EVOWORK_OFFICE_PYTHON ?? 'python3', [
    '-s', join(HUB_ROOT, 'pipeline/test/kimi_export_test.py'),
  ], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
    timeout: 10_000,
    stdio: 'pipe',
  })).not.toThrow();
});
