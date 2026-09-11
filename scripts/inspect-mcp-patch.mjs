// Validate only the synthetic audit fragment; never launch its servers.
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { parse } from 'yaml';
import { PiToolRegistry, PiPluginUiRegistry } from '@pi-harness/plugin-api';
import mcpClient from '../packages/plugins/mcp-client/dist/index.js';

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a configuration object');
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} value @returns {unknown[]} */
function array(value) {
  assert(Array.isArray(value), 'Expected configuration entries');
  return value;
}
/** @param {unknown} entry @returns {import('../packages/plugins/mcp-client/dist/index.js').McpClientConfig} */
function inactiveConfig(entry) {
  const row = record(entry);
  assert(row.name === '@pi-harness/plugin-mcp-client', 'Only MCP client fragments may be inspected');
  const config = record(row.config);
  for (const item of array(config.servers)) {
    const server = record(item);
    assert(server.autoStart === false, 'Only inactive synthetic MCP fragments may be inspected');
    assert(typeof server.id === 'string', 'Expected a server ID');
  }
  return config;
}
assert(process.argv[2], 'Pass the synthetic fragment path');
const source = await readFile(process.argv[2], 'utf8');
let entries;
try {
  entries = array(parse(source));
} catch {
  throw new Error('MCP fragment must be a valid YAML list');
}
const configs = entries.map(inactiveConfig);
const context = new Context();
context.provide('piHarnessLaunch', { cwd: process.cwd(), agentDir: process.cwd(), args: [], requestExit() {} });
context.provide('piTools', new PiToolRegistry());
context.provide('piPluginUi', new PiPluginUiRegistry());
const report = { clientEntries: entries.length, serverIds: configs.flatMap(config => (config.servers ?? []).map(server => server.id)), loadable: false };
let failed = false;
try {
  for (const config of configs) await context.plugin(mcpClient, config);
  report.loadable = true;
} catch {
  failed = true;
  process.exitCode = 1;
} finally {
  await context.fiber.dispose();
}
process.stdout.write(JSON.stringify({ ...report, ...(failed ? { error: 'MCP fragment failed to load' } : {}) }) + '\n');
