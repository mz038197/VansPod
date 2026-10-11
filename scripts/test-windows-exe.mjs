// Repeatable verification of the real Windows SEA executable with isolated user files.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const sessions = {
  first: { key: 'synthetic-key-first-never-real', class_name: '繁體測試課堂甲', name: '第一堂 🐕', nickname: '測試學生甲', model: 'synthetic-model-a' },
  second: { key: 'synthetic-key-second-never-real', class_name: '繁體測試課堂乙', name: '第二堂 🐕', nickname: '測試學生乙', model: 'synthetic-model-b' },
};
const sensitive = Object.values(sessions).flatMap(s => [s.key, s.class_name, s.name, s.nickname]);
function safeAssert(condition, message) { if (!condition) throw new Error(message); }
async function body(req) { let text = ''; for await (const chunk of req) text += chunk; return text; }
function reply(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }

export async function fakeRouter() {
  const state = { invalidRedeem: undefined, models: 'valid', offline: false, calls: [], hanging: false };
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (state.offline) return reply(res, 503, { error: 'synthetic offline' });
      if (pathname === '/extension/sessions/nickname-redeem' && req.method === 'POST') {
        const input = JSON.parse(await body(req));
        const selected = sessions[input.invite_code];
        if (!selected) return reply(res, 400, { error: 'synthetic invalid invite' });
        return reply(res, 200, { api_key: selected.key, session: state.invalidRedeem === 'array' ? [] : state.invalidRedeem === 'number' ? { class_name: 42 } : { class_name: selected.class_name, name: selected.name } });
      }
      const selected = Object.values(sessions).find(s => req.headers.authorization === `Bearer ${s.key}`);
      // Never save headers or keys in call records or error messages.
      state.calls.push({ pathname, authorizedSession: selected === sessions.first ? 'first' : selected === sessions.second ? 'second' : undefined });
      if (!selected) return reply(res, 401, { error: 'synthetic unauthorized' });
      if (pathname === '/extension/course-catalog') return reply(res, 200, { course_catalog_yaml: 'actions: []\nsnippets: []\n' });
      if (pathname === '/extension/chat-language-models') {
        if (state.hanging) return;
        if (state.models === 'missing') return reply(res, 200, {});
        return reply(res, 200, state.models === 'empty' ? [] : [{ name: 'VCRouter', models: [{ id: selected.model }] }]);
      }
      if (pathname === '/v1/chat/completions') {
        const input = JSON.parse(await body(req));
        state.calls.at(-1).model = input.model;
        if (input.model !== selected.model) return reply(res, 403, { error: 'synthetic denied model' });
        return reply(res, 200, { id: 'synthetic-response', choices: [{ message: { role: 'assistant', content: 'synthetic success' } }] });
      }
      reply(res, 404, { error: 'synthetic not found' });
    } catch { reply(res, 500, { error: 'synthetic fixture error' }); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

export async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'classroom-sea-verify-'));
  const home = path.join(root, 'home'), roaming = path.join(root, 'roaming'), local = path.join(root, 'local'), temp = path.join(root, 'tmp');
  const paths = { codex: path.join(home, '.codex/config.toml'), claude: path.join(home, '.claude/settings.json'), vscode: path.join(roaming, 'Code/User/settings.json'), copilot: path.join(roaming, 'Code/User/chatLanguageModels.json'), connection: path.join(local, 'classroom-app/connection.json') };
  const seeds = { codex: 'model = "personal-model"\npersonal_marker = "preserve-codex"\n', claude: JSON.stringify({ personal_marker: 'preserve-claude', env: { PERSONAL_ENV: 'preserve-env' } }), vscode: JSON.stringify({ 'editor.fontSize': 17, personal_marker: 'preserve-vscode' }), copilot: JSON.stringify([{ name: 'PersonalProvider', marker: 'preserve-provider', apiKey: 'synthetic-personal-only' }]) };
  for (const dir of [home, roaming, local, temp]) await fs.mkdir(dir, { recursive: true });
  for (const [name, data] of Object.entries(seeds)) { await fs.mkdir(path.dirname(paths[name]), { recursive: true }); await fs.writeFile(paths[name], data); }
  const env = { ...process.env, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local, TEMP: temp, TMP: temp, CLASSROOM_APP_HEADLESS: '1' };
  for (const target of [...Object.values(paths), home, roaming, local, temp]) safeAssert(path.resolve(target).startsWith(path.resolve(root) + path.sep), 'Sandbox path escaped the intended root');
  return { root, paths, env, async cleanup() {
    const target = path.resolve(root), expected = path.resolve(os.tmpdir()) + path.sep;
    safeAssert(target.startsWith(expected) && path.basename(target).startsWith('classroom-sea-verify-'), 'Refusing unsafe sandbox deletion');
    await fs.rm(target, { recursive: true, force: true });
  } };
}

async function freePort() { const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p; }
async function allFiles(root) { const result = []; for (const d of await fs.readdir(root, { withFileTypes: true })) { const p = path.join(root, d.name); if (d.isDirectory()) result.push(...await allFiles(p)); else if (d.isFile()) result.push(p); } return result; }
async function assertPrivateDisk(root) { for (const filename of await allFiles(root)) { const data = await fs.readFile(filename); for (const secret of sensitive) safeAssert(!data.includes(Buffer.from(secret)), `Sensitive data found in sandbox file ${path.relative(root, filename)}`); } }
function assertPrivateOutput(text) { for (const secret of sensitive) safeAssert(!text.includes(secret), 'Sensitive data found in child output'); }

async function startExe(exe, box, router, port, overrides = {}) {
  const child = spawn(exe, [], { cwd: box.root, env: { ...box.env, CLASSROOM_APP_PORT: String(port), CLASSROOM_ROUTER_BASE_URL: router.url, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', spawnFailed = false;
  child.on('error', () => { spawnFailed = true; });
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const url = `http://127.0.0.1:${port}`;
  const handle = { child, url, async stop() {
    if (!spawnFailed && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
    assertPrivateOutput(output);
  } };
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (spawnFailed || child.exitCode !== null || child.signalCode !== null) {
        assertPrivateOutput(output);
        throw new Error('Isolated SEA process failed before readiness: ' + output.slice(0, 1000));
      }
      try { const response = await fetch(url, { signal: AbortSignal.timeout(500) }); if (response.ok && output.includes(`Classroom App: ${url}/`)) return handle; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Isolated SEA process readiness timeout');
  } catch (error) {
    await handle.stop();
    throw error;
  }
}
async function post(app, route, fields = {}) { const res = await fetch(app.url + route, { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual', signal: AbortSignal.timeout(15000) }); safeAssert(res.status === 303, `Unexpected status for ${route}`); }
async function page(app) { const html = await (await fetch(app.url)).text(); for (const s of Object.values(sessions)) safeAssert(!html.includes(s.key), 'API Key appeared on app page'); return html; }
function selectedMode(html, mode) { return new RegExp(`value="${mode}" class="on"`).test(html); }
function assertSession(html, which) { for (const field of ['class_name', 'name', 'nickname']) safeAssert(html.includes(sessions[which][field]), `Missing restored ${field}`); }

const scripts = path.dirname(fileURLToPath(import.meta.url));
const systemPowerShell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

async function helper(filename, args = []) {
  const child = spawn(systemPowerShell, ['-NoProfile', '-NonInteractive', '-STA', '-File', path.join(scripts, filename), ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let diagnostics = '';
  child.stderr.on('data', data => { diagnostics += data; });
  child.stdin.on('error', () => {});
  const exited = once(child, 'exit');
  let timer;
  const first = await Promise.race([lines.next(), new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error('Verification helper readiness timeout')); }, 10000); })]);
  clearTimeout(timer);
  return { child, status: first.value, async finish(input = '') {
    child.stdin.end(input);
    await exited;
    assertPrivateOutput(diagnostics);
    const messages = [];
    for await (const line of { [Symbol.asyncIterator]: () => lines }) messages.push(line);
    return messages;
  } };
}

async function verifyCopy(app, box) {
  const child = spawn(systemPowerShell, ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'verify-clipboard.ps1'), '-AppUrl', app.url], {
    windowsHide: true, env: box.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', diagnostics = '', pendingReported = false;
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => {
    diagnostics += data;
    if (!pendingReported && diagnostics.includes('CLIPBOARD_RESTORE_PENDING')) {
      pendingReported = true;
      process.stderr.write('CLIPBOARD_RESTORE_PENDING: helper retains the original clipboard backup and is retrying; do not terminate it.\n');
    }
  });
  child.stdin.on('error', () => {});
  const exited = once(child, 'exit');
  child.stdin.end(sessions.first.key, 'utf8');
  // No parent timeout: a restore retry must retain its in-memory backup until verified.
  const [code] = await exited;
  assertPrivateOutput(output); assertPrivateOutput(diagnostics);
  if (code !== 0 && /Unsupported non-HGLOBAL|Unsafe clipboard handle|Clipboard handle not lockable/.test(diagnostics)) return 'SKIP_UNSUPPORTED_NATIVE_FORMAT';
  safeAssert(code === 0, 'Native clipboard verification failed; inspect helper restoration status before retrying');
  const result = JSON.parse(output);
  safeAssert(result.actualCopyKey === true && result.exactFormatsAndBytesRestored === true, 'Copy or exact original clipboard restoration failed');
  return 'COPY_AND_RESTORE_OK';
}

async function monitorArguments(app) {
  const command = `$targetPid=${app.child.pid}; $watch=[Diagnostics.Stopwatch]::StartNew(); while ($watch.ElapsedMilliseconds -lt 10000) { Get-CimInstance Win32_Process -Filter "ParentProcessId = $targetPid" | ForEach-Object { [Console]::Out.WriteLine(($_ | Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress)) }; Start-Sleep -Milliseconds 25 }`;
  const child = spawn(systemPowerShell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let text = '', errors = '';
  child.stdout.on('data', data => { text += data; });
  child.stderr.on('data', data => { errors += data; });
  return async () => {
    child.stdin.end('\n'); await exited;
    assertPrivateOutput(text); assertPrivateOutput(errors);
    const snapshots = text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    for (const item of snapshots) if (item.Name?.toLowerCase() === 'powershell.exe' && item.ExecutablePath) safeAssert(path.win32.normalize(item.ExecutablePath).toLowerCase() === path.win32.normalize(systemPowerShell).toLowerCase(), 'DPAPI child did not use built-in Windows PowerShell');
    return snapshots.filter(item => item.Name?.toLowerCase() === 'powershell.exe' && item.ExecutablePath && item.CommandLine).length;
  };
}

async function proxy(app, model = sessions.first.model) {
  const response = await fetch(app.url + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'synthetic-copilot-verification' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'synthetic request' }] }), signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  for (const session of Object.values(sessions)) safeAssert(!text.includes(session.key), 'API key appeared in HTTP response');
  return response.status;
}

async function personalSettingsSnapshot() {
  const home = os.homedir(), roaming = process.env.APPDATA || path.join(home, 'AppData/Roaming');
  const targets = [path.join(home, '.codex/config.toml'), path.join(home, '.claude/settings.json'), path.join(roaming, 'Code/User/settings.json'), path.join(roaming, 'Code/User/chatLanguageModels.json')];
  const hash = async target => { try { return createHash('sha256').update(await fs.readFile(target)).digest('hex'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };
  const before = await Promise.all(targets.map(hash));
  return async () => {
    const after = await Promise.all(targets.map(hash));
    safeAssert(before.every((value, index) => value === after[index]), 'A real user configuration changed during isolated verification');
  };
}

async function denyCreateFiles(directory, sandboxRoot) {
  safeAssert(path.resolve(directory).startsWith(path.resolve(sandboxRoot) + path.sep), 'Refusing to alter ACL outside verification sandbox');
  const user = process.env.USERDOMAIN + '\\' + process.env.USERNAME;
  const icacls = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const run = promisify(execFile);
  await run(icacls, [directory, '/deny', user + ':(WD,AD)'], { windowsHide: true });
  return async () => { await run(icacls, [directory, '/remove:d', user], { windowsHide: true }); };
}

export async function runLifecycle({ exe }) {
  safeAssert(process.platform === 'win32', 'Real SEA verification requires Windows');
  const restoreCheck = await personalSettingsSnapshot();
  const router = await fakeRouter(), box = await sandbox(), port = await freePort();
  let app, lock, stopMonitor, restoreAcl;
  const results = []; const record = message => { results.push(message); console.log('PASS ' + message); }; const unverified = ['cross-account DPAPI: no second Windows account available', 'deterministic termination at every replacement instruction: not performed'];
  const restart = async overrides => { if (app) await app.stop(); app = await startExe(path.resolve(exe), box, router, port, overrides); };
  const disconnected = async () => {
    const html = await page(app);
    safeAssert(!html.includes('action="/copy"'), 'Disconnected app still offers Copy Key');
    for (const session of Object.values(sessions)) safeAssert(!html.includes(session.class_name) && !html.includes(session.nickname), 'Disconnected page contains identity');
    safeAssert(selectedMode(html, 'native'), 'Disconnected app did not remain Native');
    safeAssert(await proxy(app) >= 400, 'Disconnected proxy accepted classroom request');
  };
  try {
    await restart();
    stopMonitor = await monitorArguments(app);
    await post(app, '/redeem', { invite_code: 'first', nickname: sessions.first.nickname });
    assertSession(await page(app), 'first'); await assertPrivateDisk(box.root); record('redeem: whole-record protected disk and metadata');
    await post(app, '/switch', { mode: 'classroom' }); safeAssert(selectedMode(await page(app), 'classroom'), 'Classroom mode unavailable after valid allowlist');
    safeAssert(await proxy(app) === 200, 'Allowed classroom proxy request failed');
    safeAssert(await proxy(app, 'synthetic-denied-model') === 200, 'Existing disallowed-model substitution behavior changed');
    safeAssert(router.state.calls.at(-1).model === sessions.first.model, 'Proxy forwarded an out-of-allowlist model');
    record('proxy: allowed model and substitution never forward denied model');
    const copied = await verifyCopy(app, box);
    if (copied === 'COPY_AND_RESTORE_OK') record('packaged Copy Key: all original clipboard formats/order/raw bytes restored and verified');
    else unverified.push('packaged Copy Key: clipboard backup helper ' + copied + '; original clipboard untouched');
    const sampled = await stopMonitor(); stopMonitor = undefined;
    if (sampled) record('sampled real child command lines: ' + sampled + ' built-in PowerShell observations, no synthetic key');
    else unverified.push('real command-line sampling observed no DPAPI child; controlled spawn boundary tests cover argv');
    await restart();
    assertSession(await page(app), 'first'); safeAssert(selectedMode(await page(app), 'classroom'), 'Stored Classroom mode did not restore');
    safeAssert(await proxy(app) === 200, 'Restarted proxy did not restore the credential');
    record('same-account SEA restart: DPAPI key, Unicode class/session/nickname, Classroom mode');
    const beforeInvalidRedeem = await fs.readFile(box.paths.connection, 'utf8');
    for (const invalid of ['array', 'number']) {
      router.state.invalidRedeem = invalid;
      await post(app, '/redeem', { invite_code: 'second', nickname: sessions.second.nickname });
      assertSession(await page(app), 'first');
      safeAssert(selectedMode(await page(app), 'classroom'), 'Malformed redeem changed current mode');
      safeAssert(await fs.readFile(box.paths.connection, 'utf8') === beforeInvalidRedeem, 'Malformed redeem changed previous ciphertext');
      safeAssert(await proxy(app) === 200 && router.state.calls.at(-1).authorizedSession === 'first', 'Malformed redeem displaced old usable credential');
    }
    router.state.invalidRedeem = undefined;
    await restart(); assertSession(await page(app), 'first');
    record('malformed Router session array/metadata: old ciphertext, identity, mode and routed credential preserved across restart');

    for (const condition of ['empty', 'missing', 'offline', 'hanging']) {
      router.state.models = condition === 'empty' || condition === 'missing' ? condition : 'valid';
      router.state.offline = condition === 'offline'; router.state.hanging = condition === 'hanging';
      const stored = await fs.readFile(box.paths.connection, 'utf8');
      await restart();
      safeAssert(selectedMode(await page(app), 'native'), condition + ' startup allowlist did not force Native');
      assertSession(await page(app), 'first');
      safeAssert(await proxy(app) >= 400, condition + ' startup still authorized a classroom model');
      safeAssert(await fs.readFile(box.paths.connection, 'utf8') === stored, condition + ' startup discarded or rewrote protected credentials');
      router.state.models = 'valid'; router.state.offline = false; router.state.hanging = false;
      await post(app, '/reload'); await post(app, '/switch', { mode: 'classroom' });
      safeAssert(await proxy(app) === 200, condition + ' recovery reload failed');
      record(condition + ' startup: retained credential, Native gating, recovery reload');
    }
    lock = await helper('lock-verification-file.ps1', ['-Path', box.paths.connection]);
    safeAssert(lock.status === 'READY', 'Storage lock did not become ready');
    const lockedOriginal = await fs.readFile(box.paths.connection, 'utf8');
    await post(app, '/redeem', { invite_code: 'second', nickname: sessions.second.nickname });
    assertSession(await page(app), 'first');
    safeAssert((await page(app)).includes('換堂未完成'), 'Failed replacement was not visible');
    await post(app, '/clear');
    assertSession(await page(app), 'first');
    safeAssert((await page(app)).includes('重新啟動後仍可能恢復'), 'Failed clear was not visible');
    safeAssert(await fs.readFile(box.paths.connection, 'utf8') === lockedOriginal, 'Failed replacement/clear changed persistent record');
    safeAssert(await proxy(app) === 200, 'Failed replacement lost old usable connection');
    await lock.finish(); lock = undefined;
    await restart(); assertSession(await page(app), 'first');
    record('real shared-read file lock: replacement/delete fail, old UI/key/mode/restart preserved');
    await post(app, '/redeem', { invite_code: 'second', nickname: sessions.second.nickname }); assertSession(await page(app), 'second');
    safeAssert(await proxy(app, sessions.second.model) === 200, 'New session did not route with new credential');
    safeAssert(router.state.calls.at(-1).authorizedSession === 'second', 'New proxy kept previous session credential');
    await restart(); assertSession(await page(app), 'second'); await assertPrivateDisk(box.root); record('safe session switch: new identity, allowlist, Router key and restart');
    await post(app, '/clear'); await disconnected();
    await restart(); await disconnected(); await assertPrivateDisk(box.root); record('persistent clear: Native, no Copy Key/identity/models, proxy remains running, restart empty');
    await app.stop();
    await fs.mkdir(path.dirname(box.paths.connection), { recursive: true });
    await fs.writeFile(box.paths.connection, JSON.stringify({ apiKey: sessions.first.key }));
    await restart();
    const migratedPage = await page(app);
    safeAssert(migratedPage.includes('API KEY 已設定'), 'Legacy key did not migrate');
    safeAssert(!migratedPage.includes(sessions.first.class_name) && !migratedPage.includes(sessions.first.nickname), 'Legacy migration invented identity');
    safeAssert(await proxy(app) === 200, 'Migrated legacy credential could not route');
    await assertPrivateDisk(box.root); await restart(); safeAssert(await proxy(app) === 200, 'Migrated key did not survive restart');
    record('legacy success: encrypted replacement, missing metadata stays absent, restart/routes');
    await post(app, '/clear'); await app.stop();
    await fs.writeFile(box.paths.connection, JSON.stringify({ apiKey: sessions.first.key }));
    restoreAcl = await denyCreateFiles(path.dirname(box.paths.connection), box.root);
    await restart();
    await disconnected(); safeAssert((await page(app)).includes('已移除舊憑證'), 'Failed protect did not show migration result');
    await assertPrivateDisk(box.root);
    await post(app, '/redeem', { invite_code: 'second', nickname: sessions.second.nickname }); assertSession(await page(app), 'second');
    safeAssert(await proxy(app, sessions.second.model) === 200, 'Fresh temporary connection did not route');
    await assertPrivateDisk(box.root);
    await restoreAcl(); restoreAcl = undefined;
    await restart(); await disconnected();
    record('real sandbox create-file denial: migration failure deletes legacy, fresh memory fallback works, no restart recovery');
    await app.stop();
    await fs.writeFile(box.paths.connection, JSON.stringify({ apiKey: sessions.first.key }));
    lock = await helper('lock-verification-file.ps1', ['-Path', box.paths.connection]); safeAssert(lock.status === 'READY', 'Legacy storage lock did not become ready');
    router.state.calls = [];
    await restart(); await disconnected();
    safeAssert((await page(app)).includes('手動刪除'), 'Legacy delete failure omitted manual cleanup guidance');
    safeAssert(router.state.calls.length === 0, 'Blocked legacy key reached Router');
    safeAssert((await fs.readFile(box.paths.connection, 'utf8')).includes(sessions.first.key), 'Locked legacy fixture unexpectedly disappeared');
    await lock.finish(); lock = undefined;
    await post(app, '/redeem', { invite_code: 'first', nickname: sessions.first.nickname }); assertSession(await page(app), 'first');
    await assertPrivateDisk(box.root); record('legacy locked replace/delete: credential blocked, manual cleanup message, new safe redeem removes plaintext');
    await post(app, '/clear'); await app.stop();
    const corrupt = JSON.stringify({ secureStorage: 1, scheme: 'dpapi-current-user', ciphertext: 'Y29ycnVwdA==' });
    await fs.writeFile(box.paths.connection, corrupt); router.state.calls = [];
    await restart(); await disconnected();
    safeAssert(await fs.readFile(box.paths.connection, 'utf8') === corrupt, 'Unreadable ciphertext was deleted');
    safeAssert(router.state.calls.length === 0, 'Unreadable ciphertext produced a Router credential');
    await post(app, '/redeem', { invite_code: 'second', nickname: sessions.second.nickname }); assertSession(await page(app), 'second');
    await assertPrivateDisk(box.root); record('unreadable ciphertext: retained, refused, replaced only by successful redeem');
    const ciphertext = await fs.readFile(box.paths.connection, 'utf8');
    await fs.writeFile(box.paths.connection + '.abandoned.tmp', ciphertext);
    await restart(); assertSession(await page(app), 'second'); await assertPrivateDisk(box.root);
    record('abandoned protected temporary file: restart uses complete committed record only');
    await fs.unlink(box.paths.connection + '.abandoned.tmp');
    for (const delay of [150, 450, 900, 1400]) {
      await post(app, '/redeem', { invite_code: 'first', nickname: sessions.first.nickname });
      const pending = post(app, '/redeem', { invite_code: 'second', nickname: sessions.second.nickname }).then(() => true, () => false);
      await new Promise(resolve => setTimeout(resolve, delay)); await app.stop(); const completed = await pending;
      await restart(); const html = await page(app);
      const first = html.includes(sessions.first.class_name), second = html.includes(sessions.second.class_name);
      safeAssert(first !== second, 'Interrupted save restored missing or mixed session');
      if (completed) safeAssert(second, 'Completed session switch restarted into previous session');
      assertSession(html, second ? 'second' : 'first'); await assertPrivateDisk(box.root);
      safeAssert(await proxy(app, second ? sessions.second.model : sessions.first.model) === 200, 'Interrupted-save restart did not use matching key/allowlist');
    }
    record('four real termination timings: restart restored complete previous/new record; completed switch never reverted');
    await post(app, '/clear'); await disconnected(); await assertPrivateDisk(box.root);
    safeAssert((await fs.readFile(box.paths.codex, 'utf8')).includes('preserve-codex'), 'Codex personal setting lost');
    safeAssert(JSON.parse(await fs.readFile(box.paths.claude, 'utf8')).personal_marker === 'preserve-claude', 'Claude personal setting lost');
    safeAssert(JSON.parse(await fs.readFile(box.paths.vscode, 'utf8')).personal_marker === 'preserve-vscode', 'VS Code personal setting lost');
    safeAssert(JSON.parse(await fs.readFile(box.paths.copilot, 'utf8')).some(p => p.marker === 'preserve-provider'), 'Personal Copilot provider lost');
    safeAssert((await (await fetch(app.url + '/command-status')).text()).includes('"output":""'), 'Verification unexpectedly executed an installation');
    record('personal Codex/Claude/VS Code/Copilot preservation; no install commands; files/logs/pages scanned');
    return { platform: process.platform, node: process.version, results, unverified };
  } finally {
    let cleanupFailed = false;
    for (const cleanup of [() => lock?.finish(), () => stopMonitor?.(), () => app?.stop(), () => restoreAcl?.(), () => router.close(), () => box.cleanup(), () => restoreCheck()]) {
      try { await cleanup(); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new Error('Isolated verification cleanup did not complete successfully');
    record('real user configuration hashes unchanged; sandbox files and ACL fixture removed');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { const result = await runLifecycle({ exe: path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/classroom-app.exe') }); console.log(JSON.stringify(result, null, 2)); }
