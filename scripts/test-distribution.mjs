// Real exe and locally packed npm distribution; all student files are isolated.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeRouter, sandbox } from './test-windows-exe.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const box = await sandbox();
const router = await fakeRouter();
const env = { ...box.env, CLASSROOM_ROUTER_BASE_URL: router.url, CLASSROOM_APP_PORT: '49901' };
const exeDirectory = path.join(box.root, 'tools');
const exe = path.join(exeDirectory, 'VansPod.exe');
let runtime;
const wait = async condition => {
  for (let attempt = 0; attempt < 300; attempt++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Distribution verification timed out');
};
const manage = async (action, body) => {
  const response = await fetch(`${runtime.origin}/_vanspod/${action}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${runtime.token}` }, body: body ? JSON.stringify(body) : undefined });
  assert.equal(response.status, 200);
  return response.json();
};
try {
  await fs.mkdir(exeDirectory);
  await fs.copyFile(path.join(root, 'dist/VansPod.exe'), exe);
  assert.equal((await execute(exe, ['--version'], { env })).stdout.trim(), '0.1.0');
  // Pack excludes SEA output, tests, and build-machine paths.
  const packed = JSON.parse((await execute(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', box.root], { cwd: root })).stdout)[0];
  assert(!packed.files.some(file => /sea-|\.exe$|dist\/test\//.test(file.path)));
  const prefix = path.join(box.root, 'npm');
  await execute(process.execPath, [npmCli, 'install', '--global', '--prefix', prefix, path.join(box.root, packed.filename)], { env, timeout: 60000 });
  const registration = JSON.parse(await fs.readFile(path.join(box.env.LOCALAPPDATA, 'VansPod/installations.json'), 'utf8'));
  assert.equal(registration.some(item => item.kind === 'npm' && item.root === path.join(prefix, 'node_modules/vanspod')), true);
  assert.equal(await fs.stat(path.join(box.env.LOCALAPPDATA, 'VansPod/runtime')).catch(() => undefined), undefined);
  const npmEntry = path.join(prefix, 'node_modules/vanspod/bin/vanspod.cjs');
  await execute(exe, ['start'], { env, timeout: 20000 });
  runtime = JSON.parse(await fs.readFile(path.join(box.env.LOCALAPPDATA, 'VansPod/runtime/instance.json'), 'utf8'));
  const status = JSON.parse((await execute(process.execPath, [npmEntry, 'status', '--json'], { env })).stdout);
  assert.equal(status.pid, runtime.pid);
  await execute(process.execPath, [npmEntry, 'start'], { env, timeout: 20000 });
  assert.equal((await manage('status')).pid, runtime.pid);
  assert.equal((await fetch(`${runtime.origin}/brand-logo.png`)).status, 200);
  const icon = Buffer.from(await (await fetch(`${runtime.origin}/favicon.ico`)).arrayBuffer());
  assert.deepEqual(icon, await fs.readFile(path.join(root, 'media/brand-icon.ico')));
  // Enter Classroom, then verify exit restores personal files and remembers mode.
  const post = async (action, body) => fetch(`${runtime.origin}/${action}`, { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
  await post('redeem', { invite_code: 'first', nickname: 'Student' });
  await post('switch', { client: 'claude', mode: 'classroom' });
  assert.match(await fs.readFile(box.paths.claude, 'utf8'), /ANTHROPIC_BASE_URL/);
  const classroomSettings = await fs.readFile(box.paths.claude, 'utf8');
  await fs.writeFile(box.paths.claude, '{invalid JSON');
  const failedStop = await manage('stop', {});
  assert.equal(failedStop.ok, false);
  assert.match(failedStop.message, /claudeCode/);
  assert.equal((await manage('status')).running, true);
  assert(await fs.stat(path.join(path.dirname(box.paths.claude), 'classroom-claude-code-settings-backup.json')));
  await fs.writeFile(box.paths.claude, classroomSettings);
  await execute(process.execPath, [npmEntry, 'stop'], { env, timeout: 20000 });
  assert.equal(JSON.parse(await fs.readFile(box.paths.claude, 'utf8')).env?.ANTHROPIC_BASE_URL, undefined);
  assert.equal(JSON.parse(await fs.readFile(box.paths.preferences, 'utf8')).routes.claudeCode.mode, 'classroom');
  // Restart from npm, while exe remains a registered installation.
  await execute(process.execPath, [npmEntry, 'start'], { env, timeout: 20000 });
  runtime = JSON.parse(await fs.readFile(path.join(box.env.LOCALAPPDATA, 'VansPod/runtime/instance.json'), 'utf8'));
  assert.match(await fs.readFile(box.paths.claude, 'utf8'), /ANTHROPIC_BASE_URL/);
  router.state.holdResponses = true;
  const pending = fetch(`http://127.0.0.1:49902/v1/messages`, {method: 'POST', body: JSON.stringify({model: 'synthetic-model-a', messages: [{role: 'user', content: 'hello'}]})}).catch(() => undefined);
  await wait(async () => (await manage('status')).activeRequests > 0);
  assert.equal((await manage('stop', {})).confirmation, true);
  await assert.rejects(execute(process.execPath, [npmEntry, 'stop'], {env}), /仍有模型回答/);
  assert.equal((await manage('status')).running, true);
  assert.equal((await manage('stop', {confirmed: true})).ok, true);
  await pending;
  router.state.holdResponses = false;
  await wait(async () => !(await fs.stat(path.join(box.env.LOCALAPPDATA, 'VansPod/runtime')).catch(() => undefined)));
  await execute(process.execPath, [npmEntry, 'start'], {env, timeout: 20000});
  runtime = JSON.parse(await fs.readFile(path.join(box.env.LOCALAPPDATA, 'VansPod/runtime/instance.json'), 'utf8'));
  // Unconfirmed and unrelated-origin destructive operations do nothing.
  assert.equal((await manage('uninstall', {})).ok, false);
  assert.equal((await manage('uninstall-preview')).ok, true);
  // Changing a registered executable must produce a retryable failure, not delete it.
  await fs.appendFile(exe, 'changed-after-registration');
  const removing = await manage('uninstall', { confirmed: true });
  assert.equal(removing.ok, true, removing.message);
  await wait(async () => !!(await fs.stat(path.join(box.env.LOCALAPPDATA, 'VansPod/removal-result.json')).catch(() => undefined)));
  const incomplete = JSON.parse(await fs.readFile(path.join(box.env.LOCALAPPDATA, 'VansPod/removal-result.json'), 'utf8'));
  assert.equal(incomplete.ok, false);
  assert(incomplete.remaining.includes(exe));
  assert(incomplete.remaining.includes(path.join(prefix, 'node_modules/vanspod')));
  assert(await fs.stat(path.join(box.env.LOCALAPPDATA, 'VansPod/uninstall-tool.ps1')));
  assert(await fs.stat(path.join(prefix, 'node_modules/vanspod')));
  await fs.copyFile(path.join(root, 'dist/VansPod.exe'), exe);
  await execute(process.execPath, [npmEntry, 'start'], {env, timeout: 20000});
  runtime = JSON.parse(await fs.readFile(path.join(box.env.LOCALAPPDATA, 'VansPod/runtime/instance.json'), 'utf8'));
  await post('redeem', {invite_code: 'first', nickname: 'Student'});
  await post('switch', {client: 'vscode', mode: 'classroom'});
  const classroomProviders = await fs.readFile(box.paths.copilot, 'utf8');
  await assert.rejects(execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(box.env.LOCALAPPDATA, 'VansPod/uninstall-tool.ps1')], {env, timeout: 10000}));
  assert.equal((await manage('status')).running, true);
  assert.equal(await fs.readFile(box.paths.copilot, 'utf8'), classroomProviders);
  assert(await fs.stat(box.paths.connection));
  assert(await fs.stat(path.join(prefix, 'node_modules/vanspod')));
  assert.equal((await manage('stop', {confirmed: true})).ok, true);
  await wait(async () => !(await fs.stat(path.join(box.env.LOCALAPPDATA, 'VansPod/runtime')).catch(() => undefined)));
  // A registered ordinary leaf beneath a replaced ancestor must never delete
  // the identical binary in the student's other folder.
  const savedDirectory = path.join(box.root, 'tools-saved');
  const foreignDirectory = path.join(box.root, 'student-binaries');
  await fs.mkdir(foreignDirectory);
  await fs.copyFile(exe, path.join(foreignDirectory, 'VansPod.exe'));
  await fs.rename(exeDirectory, savedDirectory);
  await fs.symlink(foreignDirectory, exeDirectory, 'junction');
  await assert.rejects(execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(box.env.LOCALAPPDATA, 'VansPod/uninstall-tool.ps1')], {env, timeout: 10000}));
  assert(await fs.stat(path.join(foreignDirectory, 'VansPod.exe')));
  await fs.unlink(exeDirectory);
  await fs.rename(savedDirectory, exeDirectory);
  await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(box.env.LOCALAPPDATA, 'VansPod/uninstall-tool.ps1')], {env, timeout: 40000});
  try { await wait(async () => !(await fs.stat(path.join(box.env.LOCALAPPDATA, 'VansPod')).catch(() => undefined))); }
  catch (error) {
    const result = await fs.readFile(path.join(box.env.LOCALAPPDATA, 'VansPod/removal-result.json'), 'utf8').catch(() => error.message);
    throw new Error(result);
  }
  assert.equal(await fs.stat(exe).catch(() => undefined), undefined);
  assert.equal(await fs.stat(path.join(prefix, 'node_modules/vanspod')).catch(() => undefined), undefined);
  assert.equal(JSON.parse(await fs.readFile(box.paths.claude, 'utf8')).env?.ANTHROPIC_BASE_URL, undefined);
  assert.equal(await fs.readFile(box.paths.unrelated, 'utf8'), 'unrelated student file must survive');
  assert.equal(JSON.parse(await fs.readFile(box.paths.vscode, 'utf8'))['editor.fontSize'], 17);
  process.stdout.write('Windows exe/npm verification passed: background, single instance, embedded assets, settings restore and complete removal.\n');
} finally {
  if (runtime) { try { await manage('stop', { confirmed: true }); } catch {} }
  await router.close();
  await box.cleanup();
}
