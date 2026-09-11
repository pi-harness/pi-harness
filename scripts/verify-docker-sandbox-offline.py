"""Real Docker CLI diagnostics with process-local offline socket; no daemon changes."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
subprocess.run(['node', '--input-type=module', '-'], cwd=ROOT, check=True, text=True, input=r'''
import { Context } from '@deepseek-ai/cordis';
import { PiPluginUiRegistry, PiToolRegistry } from '@pi-harness/plugin-api';
import plugin from './packages/plugins/docker-sandbox/dist/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const dir = await mkdtemp(join(tmpdir(), 'pih-docker-offline-'));
const original = {DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT};
const restore = () => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
};
const context = new Context();
const tools = new PiToolRegistry();
context.provide('piHarnessLaunch', {cwd: dir, agentDir: dir, args: [], requestExit() {}});
context.provide('piTools', tools);
context.provide('piPluginUi', new PiPluginUiRegistry());
try {
  await context.plugin(plugin);
  const tool = tools.snapshot().customTools.find(t => t.name === 'sandbox_exec');
  process.env.DOCKER_HOST = 'unix://' + join(dir, 'absent.sock');
  delete process.env.DOCKER_CONTEXT;
  await assert.rejects(tool.execute('offline', {command: ['printf', 'ok']}, undefined, undefined, {}), error => {
    assert.match(error.message, /Docker image inspection failed/);
    assert.match(error.message, /connect|socket/i);
    assert.doesNotMatch(error.message, /image is not available locally/);
    return true;
  });
  console.log('real Docker unreachable socket correctly classified PASS');
  restore();
  const image = 'pih-audit-missing-image:' + randomUUID();
  await assert.rejects(tool.execute('missing', {command: ['printf', 'ok'], image}, undefined, undefined, {}),
    {message: 'Docker image is not available locally: ' + image});
  console.log('real Docker absent local image still classified PASS (no pull)');
} finally {
  restore();
  await context.fiber.dispose();
  await rm(dir, {recursive: true, force: true});
}
''')
