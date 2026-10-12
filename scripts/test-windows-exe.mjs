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
        return reply(res, 200, state.models === 'empty' ? [] : [{ name: 'VCRouter', vendor: 'customendpoint', models: [{ id: selected.model, name: 'Synthetic Classroom Model', toolCalling: true, vision: true, maxInputTokens: 32000, api_key: 'must-be-removed', headers: { authorization: 'must-be-removed' } }] }]);
      }
      if (['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(pathname)) {
        const input = JSON.parse(await body(req));
        state.calls.at(-1).model = input.model;
        if (Object.hasOwn(input, 'access_programs')) return reply(res, 400, { error: { message: 'Unknown parameter access_programs' } });
        state.calls.at(-1).hasClientMetadata = Object.hasOwn(input, 'client_metadata');
        if (pathname === '/v1/responses' && Array.isArray(input.input) && input.input.some(item => item.type === 'additional_tools')) return reply(res, 400, { error: { message: 'input[0]: unknown input item type: "additional_tools"' } });
        if (pathname === '/v1/responses' && Array.isArray(input.input)) {
          const index = input.input.findIndex(item => item.type === 'custom_tool_call' || item.type === 'custom_tool_call_output');
          if (index >= 0) return reply(res, 400, { error: { message: `input[${index}]: unknown input item type: "custom_tool_call"` } });
          state.calls.at(-1).hasFunctionResult = input.input.some(item => item.type === 'function_call_output' && item.call_id === 'call_exec');
        }
        state.calls.at(-1).toolNames = (input.tools ?? []).map(tool => tool.function?.name ?? tool.name);
        if (input.model !== selected.model) return reply(res, 403, { error: 'synthetic denied model' });
        const wire = pathname.endsWith('/responses') ? 'responses' : pathname.endsWith('/messages') ? 'messages' : 'chat';
        const usage = { input_tokens: 2, output_tokens: 3 };
        const output = { id: 'synthetic-response', object: 'response', status: 'completed', model: input.model, output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'synthetic success', annotations: [] }] }], usage };
        const executor = wire === 'responses' && state.calls.at(-1).toolNames.includes('exec') ? { type: input.stream ? 'function_call' : 'custom_tool_call', id: 'f', call_id: 'call_exec', name: 'exec', ...(input.stream ? { arguments: JSON.stringify({ code: 'text("hello")' }) } : { input: JSON.stringify({ code: 'text("hello")' }) }), status: 'completed' } : undefined;
        if (executor) output.output.push(executor);
        const message = { id: 'synthetic-message', type: 'message', role: 'assistant', model: input.model, content: [{ type: 'text', text: 'synthetic success' }], stop_reason: 'end_turn', stop_sequence: null, usage };
        if (input.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if (wire === 'chat') res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'synthetic success', ...(input.tools?.some(tool => tool.function?.name === 'exec') ? { reasoning: 'synthetic plan' } : {}) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
          else if (wire === 'responses') {
            if (executor) for (const event of [
              { type: 'response.output_item.added', output_index: 1, item: { ...executor, arguments: '', status: 'in_progress' } },
              { type: 'response.function_call_arguments.delta', item_id: 'f', output_index: 1, delta: executor.arguments },
              { type: 'response.function_call_arguments.done', item_id: 'f', output_index: 1, arguments: executor.arguments },
              { type: 'response.output_item.done', output_index: 1, item: executor },
            ]) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
            res.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: output }) + '\n\n');
          }
          else res.end('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { ...message, content: [] } }) + '\n\nevent: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic success' } }) + '\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
          return;
        }
        return reply(res, 200, wire === 'responses' ? output : wire === 'messages' ? message : { id: 'synthetic-response', choices: [{ message: { role: 'assistant', content: 'synthetic success', ...(input.tools?.some(tool => tool.function?.name === 'exec') ? { reasoning: 'synthetic plan' } : {}) }, finish_reason: 'stop' }] });
      }
      reply(res, 404, { error: 'synthetic not found' });
    } catch { reply(res, 500, { error: 'synthetic fixture error' }); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

export async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'classroom-sea-verify-'));
  const home = path.join(root, 'home'), roaming = path.join(root, 'roaming'), local = path.join(root, 'local'), temp = path.join(root, 'tmp'), bin = path.join(root, 'bin');
  const paths = {
    codex: path.join(home, '.codex/config.toml'), codexCatalog: path.join(home, '.codex/classroom-catalog.json'), codexCache: path.join(home, '.codex/models_cache.json'),
    claude: path.join(home, '.claude/settings.json'), claudeCatalog: path.join(home, '.claude/cache/gateway-models.json'),
    vscode: path.join(roaming, 'Code/User/settings.json'), copilot: path.join(roaming, 'Code/User/chatLanguageModels.json'),
    connection: path.join(home, '.vanspod/connection.json'), preferences: path.join(home, '.vanspod/settings.json'), vsCodeJournal: path.join(home, '.vanspod/vscode-route-journal.json'),
    unrelated: path.join(home, 'student-work/keep-me.txt'), bin,
  };
  const seeds = { codex: 'model = "personal-model"\npersonal_marker = "preserve-codex"\n', claude: JSON.stringify({ personal_marker: 'preserve-claude', env: { PERSONAL_ENV: 'preserve-env' } }), vscode: JSON.stringify({ 'editor.fontSize': 17, personal_marker: 'preserve-vscode' }), copilot: JSON.stringify([{ name: 'PersonalProvider', marker: 'preserve-provider', apiKey: 'synthetic-personal-only' }]) };
  for (const dir of [home, roaming, local, temp, bin, path.dirname(paths.unrelated)]) await fs.mkdir(dir, { recursive: true });
  for (const [name, data] of Object.entries(seeds)) { await fs.mkdir(path.dirname(paths[name]), { recursive: true }); await fs.writeFile(paths[name], data); }
  await fs.writeFile(paths.unrelated, 'unrelated student file must survive');
  for (const command of ['codex', 'claude', 'code']) await fs.writeFile(path.join(bin, command + '.cmd'), '@exit /b 0\r\n');
  const env = { ...process.env, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local, TEMP: temp, TMP: temp, PATH: bin + path.delimiter + process.env.PATH, CLASSROOM_APP_HEADLESS: '1' };
  for (const target of [...Object.values(paths), home, roaming, local, temp]) safeAssert(path.resolve(target).startsWith(path.resolve(root) + path.sep), 'Sandbox path escaped the intended root');
  return { root, paths, env, async cleanup() {
    const target = path.resolve(root), expected = path.resolve(os.tmpdir()) + path.sep;
    safeAssert(target.startsWith(expected) && path.basename(target).startsWith('classroom-sea-verify-'), 'Refusing unsafe sandbox deletion');
    await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
  let url = `http://127.0.0.1:${port}`;
  const handle = { child, get url() { return url; }, routeUrl(route) { return `http://127.0.0.1:${port + ({ codex: 0, claude: 1, vscode: 2 }[route] ?? 0)}`; }, output: () => output, async stop() {
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
      const announced = output.match(/VansPod: (http:\/\/127\.0\.0\.1:\d+)\//)?.[1];
      if (announced) url = announced;
      try { const response = await fetch(url, { signal: AbortSignal.timeout(500) }); if (response.ok && announced) return handle; } catch {}
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
function selectedMode(html, mode) { return new RegExp(`value="${mode}"[^>]*class="on"`).test(html); }
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
  const response = await fetch(app.url + '/v1/responses', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'synthetic-copilot-verification' },
    body: JSON.stringify({ model, input: 'synthetic request', stream: false }), signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  for (const session of Object.values(sessions)) safeAssert(!text.includes(session.key), 'API key appeared in HTTP response');
  return response.status;
}

async function routeRequest(app, route, endpoint, bodyValue, expected = 200) {
  const response = await fetch(app.routeUrl(route) + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyValue), signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  assertPrivateOutput(text);
  safeAssert(response.status === expected, `${route} ${endpoint} returned ${response.status}: ${text.slice(0, 160)}`);
  return text;
}

function clientCard(html, client) {
  const match = html.match(new RegExp(`<div class="model-client">(?:(?!<div class="model-client">)[\\s\\S])*?<input type="hidden" name="client" value="${client}">(?:(?!<div class="model-client">)[\\s\\S])*?<\\/form><\\/div>`));
  safeAssert(match, `Missing ${client} card`);
  return match[0];
}

function assertRoute(html, client, health, mode) {
  const card = clientCard(html, client);
  safeAssert(card.includes(health === 'green' ? 'client-light detected' : `client-light health-${health}`), `${client} was not ${health}`);
  safeAssert(new RegExp(`value="${mode}"[^>]*class="on"`).test(card), `${client} was not ${mode}`);
}

function assertHealthyRoute(html, client, mode) {
  const card = clientCard(html, client);
  safeAssert(card.includes('client-light detected') || card.includes('client-light health-yellow'), `${client} was not healthy`);
  safeAssert(new RegExp(`value="${mode}"[^>]*class="on"`).test(card), `${client} was not ${mode}`);
}

async function occupy(port) {
  const server = http.createServer((_req, res) => { res.writeHead(409); res.end('occupied'); });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  return () => new Promise(resolve => server.close(resolve));
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

async function freeBasePort() {
  for (let base = 50000; base < 65000; base += 3) {
    const servers = [];
    try {
      for (const port of [base, base + 1, base + 2]) {
        const server = http.createServer();
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
        servers.push(server);
      }
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
      return base;
    } catch {
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    }
  }
  throw new Error('No three-port verification range is available');
}

export async function runMultiRouteLifecycle({ exe }) {
  safeAssert(process.platform === 'win32', 'Packaged multi-route verification requires Windows');
  const restoreCheck = await personalSettingsSnapshot();
  const router = await fakeRouter();
  const box = await sandbox();
  const base = await freeBasePort();
  let app, releaseCollision, locked;
  const results = [];
  const record = message => { results.push(message); console.log('PASS ' + message); };
  const restart = async () => { if (app) await app.stop(); app = await startExe(path.resolve(exe), box, router, base); };
  const switchRoute = (client, mode) => post(app, '/switch', { client, mode });
  try {
    const personal = {
      codex: await fs.readFile(box.paths.codex, 'utf8'), claude: await fs.readFile(box.paths.claude, 'utf8'),
      vscode: await fs.readFile(box.paths.vscode, 'utf8'), copilot: await fs.readFile(box.paths.copilot, 'utf8'), unrelated: await fs.readFile(box.paths.unrelated, 'utf8'),
    };
    const legacyProvider = [{ name: 'PersonalProvider', marker: 'preserve-provider', apiKey: 'synthetic-personal-only' }, { name: 'VCRouter', url: `http://127.0.0.1:${base}` }];
    await fs.writeFile(box.paths.copilot, JSON.stringify(legacyProvider));
    await restart();
    let html = await page(app);
    for (const client of ['codex', 'claude', 'vscode']) assertRoute(html, client, 'green', 'native');
    for (const route of ['codex', 'claude', 'vscode']) safeAssert((await fetch(app.routeUrl(route), { signal: AbortSignal.timeout(2000) })).status === 200, `${route} fixed route did not listen`);
    safeAssert(!JSON.parse(await fs.readFile(box.paths.copilot, 'utf8')).some(provider => provider.url === `http://127.0.0.1:${base}`), 'Legacy VansPod provider was not migrated');
    safeAssert(await fs.readFile(box.paths.codex, 'utf8') === personal.codex && await fs.readFile(box.paths.claude, 'utf8') === personal.claude && await fs.readFile(box.paths.vscode, 'utf8') === personal.vscode, 'Native startup changed personal settings');
    record(`configured base port owns ${base}, ${base + 1}, ${base + 2}; deterministic clients and legacy provider migration`);

    await post(app, '/redeem', { invite_code: 'first', nickname: sessions.first.nickname });
    for (const client of ['codex', 'claude', 'vscode']) await switchRoute(client, 'classroom');
    html = await page(app);
    for (const client of ['codex', 'claude', 'vscode']) assertRoute(html, client, 'yellow', 'classroom');
    const codexConfig = await fs.readFile(box.paths.codex, 'utf8');
    const claudeConfig = JSON.parse(await fs.readFile(box.paths.claude, 'utf8'));
    const codexCatalog = JSON.parse(await fs.readFile(box.paths.codexCatalog, 'utf8'));
    const claudeCatalog = await (await fetch(app.routeUrl('claude') + '/v1/models')).json();
    const providers = JSON.parse(await fs.readFile(box.paths.copilot, 'utf8'));
    const vcr = providers.find(provider => provider.name === 'VCRouter');
    safeAssert(codexConfig.includes(`http://127.0.0.1:${base}/v1`) && claudeConfig.env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${base + 1}`, 'Client-native routes used wrong listener origin');
    safeAssert(codexCatalog.models.some(model => model.slug === `VCRouter/${sessions.first.model}`), 'Codex catalog missed allowlist');
    safeAssert(claudeCatalog.data.some(model => model.id === sessions.first.model), 'Claude discovery missed allowlist');
    safeAssert(vcr.models.some(model => model.id === sessions.first.model && model.url === `http://127.0.0.1:${base + 2}/v1`), 'VS Code provider missed allowlist or route');
    safeAssert(!JSON.stringify(vcr).match(/api.?key|authorization|must-be-removed/i), 'VS Code provider retained Router credentials');
    record('one Session Model Allowlist is projected through Codex catalog, Claude discovery, and credential-free VS Code provider');

    await post(app, '/adapter', { client: 'codex', adapter: 'chat' });
    await post(app, '/adapter', { client: 'claude', adapter: 'messages' });
    await post(app, '/adapter', { client: 'vscode', adapter: 'chat' });
    const callStart = router.state.calls.length;
    await Promise.all([
      routeRequest(app, 'codex', '/v1/responses', { model: sessions.first.model, input: 'codex', stream: false }),
      routeRequest(app, 'claude', '/v1/messages', { model: sessions.first.model, messages: [{ role: 'user', content: 'claude' }], max_tokens: 20, stream: false }),
      routeRequest(app, 'vscode', '/v1/chat/completions', { model: sessions.first.model, messages: [{ role: 'user', content: 'vscode' }], stream: false }),
    ]);
    const concurrent = router.state.calls.slice(callStart).map(call => call.pathname).sort();
    safeAssert(concurrent.filter(value => value === '/v1/chat/completions').length === 2 && concurrent.includes('/v1/messages'), 'Concurrent listeners did not retain per-route adapter selection');
    for (const route of ['codex', 'claude', 'vscode']) await routeRequest(app, route, route === 'claude' ? '/v1/messages' : route === 'vscode' ? '/v1/chat/completions' : '/v1/responses', route === 'claude' ? { model: 'invalid-model', messages: [], max_tokens: 1 } : route === 'vscode' ? { model: 'invalid-model', messages: [] } : { model: 'invalid-model', input: 'x' }, 409);
    record('concurrent packaged requests preserve listener-owned route identity, adapter choice, and reject invalid models');

    await switchRoute('vscode', 'native');
    await Promise.all([
      routeRequest(app, 'codex', '/v1/responses', { model: sessions.first.model, input: 'still live' }),
      routeRequest(app, 'vscode', '/v1/chat/completions', { model: sessions.first.model, messages: [] }, 409),
    ]);
    await switchRoute('vscode', 'classroom');
    record('stale VS Code session is rejected while another Client Route remains live');

    await post(app, '/stop');
    safeAssert(await fs.readFile(box.paths.codex, 'utf8') === personal.codex && await fs.readFile(box.paths.claude, 'utf8') === personal.claude && await fs.readFile(box.paths.vscode, 'utf8') === personal.vscode, 'Stop did not restore personal route settings');
    safeAssert(JSON.parse(await fs.readFile(box.paths.copilot, 'utf8')).some(provider => provider.marker === 'preserve-provider'), 'Stop removed a personal VS Code provider');
    await app.stop(); app = undefined; await restart();
    html = await page(app); for (const client of ['codex', 'claude', 'vscode']) assertHealthyRoute(html, client, 'classroom');
    record('packaged Stop restores all personal settings before listeners close; restart safely restores saved Classroom routes');

    router.state.offline = true;
    await post(app, '/reload');
    html = await page(app);
    safeAssert(html.includes('保留上次成功的模型清單'), 'Failed refresh did not retain and report the previous allowlist');
    router.state.offline = false;
    await routeRequest(app, 'codex', '/v1/responses', { model: sessions.first.model, input: 'retained' });
    router.state.models = 'empty';
    await post(app, '/reload');
    html = await page(app);
    for (const client of ['codex', 'claude', 'vscode']) assertRoute(html, client, 'green', 'native');
    safeAssert(await fs.readFile(box.paths.codex, 'utf8') === personal.codex && await fs.readFile(box.paths.claude, 'utf8') === personal.claude && await fs.readFile(box.paths.vscode, 'utf8') === personal.vscode, 'Empty allowlist did not restore personal settings');
    router.state.models = 'valid'; await post(app, '/reload');
    for (const client of ['codex', 'claude', 'vscode']) await switchRoute(client, 'classroom');
    record('failed refresh retains the catalog; authoritative empty allowlist returns all routes to Native');

    await app.stop(); app = undefined;
    releaseCollision = await occupy(base + 1); await restart();
    html = await page(app); assertHealthyRoute(html, 'codex', 'classroom'); assertRoute(html, 'claude', 'red', 'native'); assertHealthyRoute(html, 'vscode', 'classroom');
    await releaseCollision(); releaseCollision = undefined; await post(app, '/reload'); assertRoute(await page(app), 'claude', 'green', 'native');
    await switchRoute('claude', 'classroom'); await app.stop(); app = undefined;
    releaseCollision = await occupy(base + 2); await restart();
    html = await page(app); assertHealthyRoute(html, 'codex', 'classroom'); assertHealthyRoute(html, 'claude', 'classroom'); assertRoute(html, 'vscode', 'red', 'native');
    await releaseCollision(); releaseCollision = undefined; await post(app, '/reload'); assertRoute(await page(app), 'vscode', 'green', 'native');
    record('Claude and VS Code port collisions isolate red health and recover Native on Reload');

    await app.stop(); app = undefined;
    releaseCollision = await occupy(base); await restart();
    safeAssert(app.url !== app.routeUrl('codex'), 'Base-port collision did not open emergency UI');
    html = await page(app); assertRoute(html, 'codex', 'red', 'native'); safeAssert((await fetch(app.url + '/v1/responses', { method: 'POST', body: '{}' })).status === 503, 'Emergency UI accepted model traffic');
    assertHealthyRoute(html, 'claude', 'classroom');
    await releaseCollision(); releaseCollision = undefined; await post(app, '/reload'); assertRoute(await page(app), 'codex', 'green', 'native');
    record('base-port collision opens UI-only emergency listener, marks Codex red, and leaves other routes independent');

    await fs.writeFile(box.paths.copilot, JSON.stringify([{ name: 'PersonalProvider', marker: 'preserve-provider' }, { name: 'VCRouter', vendor: 'customendpoint', apiKey: '${input:chat.lm.secret.old}', models: [] }]));
    await switchRoute('vscode', 'classroom');
    html = await page(app); assertRoute(html, 'vscode', 'red', 'native'); safeAssert(html.includes('舊擴充'), 'Old-extension conflict lacked remediation');
    await fs.writeFile(box.paths.copilot, JSON.stringify([{ name: 'PersonalProvider', marker: 'preserve-provider' }])); await post(app, '/reload');
    assertRoute(await page(app), 'vscode', 'green', 'native');
    record('old-extension secret provider is never adopted and red-route retry recovers after cleanup');

    await switchRoute('codex', 'classroom'); await switchRoute('claude', 'classroom'); await switchRoute('vscode', 'classroom');
    locked = await helper('lock-verification-file.ps1', ['-Path', box.paths.claude]); safeAssert(locked.status === 'READY', 'Claude restore lock did not become ready');
    await post(app, '/clear');
    html = await page(app); assertRoute(html, 'claude', 'red', 'native'); assertRoute(html, 'codex', 'green', 'native'); assertRoute(html, 'vscode', 'green', 'native');
    await locked.finish(); locked = undefined; await post(app, '/reload'); assertRoute(await page(app), 'claude', 'green', 'native');
    safeAssert(await fs.readFile(box.paths.unrelated, 'utf8') === personal.unrelated, 'Unrelated user file changed');
    safeAssert((await fs.readFile(box.paths.codex, 'utf8')).includes('preserve-codex') && JSON.parse(await fs.readFile(box.paths.claude, 'utf8')).personal_marker === 'preserve-claude' && JSON.parse(await fs.readFile(box.paths.copilot, 'utf8')).some(provider => provider.marker === 'preserve-provider'), 'Personal settings did not survive lifecycle');
    await assertPrivateDisk(box.root); assertPrivateOutput(app.output());
    safeAssert(router.state.calls.every(call => !JSON.stringify(call).includes('synthetic-key-')), 'Captured Router traffic retained Classroom API Key');
    record('partial restore failure is isolated and retryable; switch, Reload, Stop, Clear and restart preserve personal and unrelated files; scans find no Classroom key');
    return { base, results };
  } finally {
    const failures = [];
    for (const [name, cleanup] of Object.entries({ lock: () => locked?.finish(), collision: () => releaseCollision?.(), app: () => app?.stop(), router: () => router.close(), sandbox: () => box.cleanup(), personalSettings: () => restoreCheck() })) {
      try { await cleanup(); } catch (error) { failures.push(name + ':' + String(error)); }
    }
    if (failures.length) throw new Error('Multi-route cleanup failed: ' + failures.join(', '));
  }
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
    safeAssert(!/<form\b[^>]*\baction="\/copy"[^>]*>/i.test(html), 'Disconnected app still offers Copy Key');
    for (const session of Object.values(sessions)) safeAssert(!html.includes(session.class_name) && !html.includes(session.nickname), 'Disconnected page contains identity');
    safeAssert(selectedMode(html, 'native'), 'Disconnected app did not remain Native');
    safeAssert(await proxy(app) >= 400, 'Disconnected proxy accepted classroom request');
  };
  try {
    const personalCodex = await fs.readFile(box.paths.codex, 'utf8');
    const personalClaude = await fs.readFile(box.paths.claude, 'utf8');
    const personalVsCode = await fs.readFile(box.paths.vscode, 'utf8');
    await restart();
    safeAssert(await fs.readFile(box.paths.codex, 'utf8') === personalCodex, 'Native startup changed personal Codex settings');
    safeAssert(await fs.readFile(box.paths.claude, 'utf8') === personalClaude, 'Native startup changed personal Claude settings');
    safeAssert(await fs.readFile(box.paths.vscode, 'utf8') === personalVsCode, 'Native startup changed personal VS Code Claude settings');
    record('Native startup: Codex and Claude CLI/VS Code personal files unchanged');
    stopMonitor = await monitorArguments(app);
    await post(app, '/redeem', { invite_code: 'first', nickname: sessions.first.nickname });
    assertSession(await page(app), 'first'); await assertPrivateDisk(box.root); record('redeem: whole-record protected disk and metadata');
    for (const client of ['codex', 'claude', 'vscode']) await post(app, '/switch', { client, mode: 'classroom' });
    safeAssert(selectedMode(await page(app), 'classroom'), 'Classroom mode unavailable after valid allowlist');
    const independentCodex = await fs.readFile(box.paths.codex, 'utf8');
    await post(app, '/switch', { client: 'claude', mode: 'native' });
    safeAssert(await fs.readFile(box.paths.codex, 'utf8') === independentCodex, 'Claude switch changed Codex files');
    safeAssert(await fs.readFile(box.paths.claude, 'utf8') === personalClaude, 'Native Claude failed to restore original CLI settings');
    safeAssert(await fs.readFile(box.paths.vscode, 'utf8') === personalVsCode, 'Native Claude failed to restore original VS Code settings');
    safeAssert(!/aria-label="Claude Code API 協定" disabled/.test(await page(app)), 'Healthy Native Claude adapter was disabled');
    await post(app, '/adapter', { client: 'claude', adapter: 'messages' });
    safeAssert(JSON.parse(await fs.readFile(box.paths.preferences, 'utf8')).routes.claudeCode.adapter === 'messages', 'Native Claude adapter preference was not saved');
    await restart();
    safeAssert(await fs.readFile(box.paths.claude, 'utf8') === personalClaude, 'Mixed restart rewrote Native Claude settings');
    safeAssert(await fs.readFile(box.paths.vscode, 'utf8') === personalVsCode, 'Mixed restart rewrote Native VS Code Claude settings');
    const mixedHtml = await page(app);
    safeAssert(!/aria-label="Claude Code API 協定" disabled/.test(mixedHtml) && !/aria-label="Codex API 協定" disabled/.test(mixedHtml), 'Healthy mixed modes did not restore');
    await post(app, '/switch', { client: 'claude', mode: 'classroom' });
    record('independent modes: Claude switch preserves Codex files, adapter gating, mixed restart');
    safeAssert(await proxy(app) === 200, 'Allowed classroom proxy request failed');
    safeAssert(await proxy(app, 'synthetic-denied-model') === 409, 'Out-of-allowlist model was not rejected');
    record('proxy: allowed model succeeds and denied model is rejected before Router');
    for (const client of ['codex', 'claude']) for (const adapter of client === 'codex' ? ['chat', 'responses'] : ['chat', 'responses', 'messages']) {
      await post(app, '/adapter', { client, adapter });
      for (const stream of [false, true]) {
        const endpoint = client === 'codex' ? '/v1/responses' : '/v1/messages';
        const body = client === 'codex' ? { input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }, { type: 'custom', name: 'exec', format: { type: 'text' } }] }, { role: 'user', content: 'hello' }], include: ['reasoning.encrypted_content'], prompt_cache_key: 'synthetic-cache', client_metadata: { thread_id: 'synthetic-thread', future_client_field: { version: 2 } }, access_programs: { cyber: ['standard'] }, future_client_extension: { version: 3 }, reasoning: { effort: 'medium', summary: 'auto', context: { source: 'synthetic-exe' } }, text: { verbosity: 'low' }, stream } : { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100, stream };
        const clientUrl = app.routeUrl(client === 'claude' ? 'claude' : 'codex');
        const response = await fetch(clientUrl + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, model: sessions.first.model }), signal: AbortSignal.timeout(10000) });
        const text = await response.text();
        safeAssert(response.status === 200 && text.includes('synthetic success'), `Packaged ${client}/${adapter}/${stream} failed`);
        safeAssert(!text.includes(sessions.first.key), 'Adapter leaked Classroom key');
        safeAssert(router.state.calls.at(-1).pathname === (adapter === 'chat' ? '/v1/chat/completions' : '/v1/' + adapter), 'Wrong packaged upstream protocol');
        if (client === 'codex') safeAssert(router.state.calls.at(-1).toolNames.includes('apply_patch'), 'Packaged adapter lost inline custom tool');
        if (client === 'codex' && adapter === 'chat') safeAssert(text.includes('"type":"reasoning"') && text.includes('synthetic plan'), 'Packaged Chat lost plaintext reasoning');
        if (client === 'codex') safeAssert(router.state.calls.at(-1).hasClientMetadata === (adapter === 'responses'), 'Packaged adapter misclassified client metadata');
        if (client === 'codex' && adapter === 'responses') {
          safeAssert(text.includes('"type":"custom_tool_call"') && text.includes('"input":"text(\\"hello\\")"'), 'Packaged Responses did not restore freeform executor');
          safeAssert(!text.includes('response.function_call_arguments'), 'Packaged Responses leaked function arguments events for freeform executor');
          const result = stream ? JSON.parse(text.match(/event: response.completed\ndata: ([^\n]+)/)[1]).response : JSON.parse(text);
          const next = await fetch(clientUrl + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, model: sessions.first.model, input: [...body.input, ...result.output, { type: 'custom_tool_call_output', call_id: 'call_exec', output: 'hello' }] }), signal: AbortSignal.timeout(10000) });
          safeAssert(next.status === 200, 'Packaged Responses rejected freeform history on the next turn');
          await next.text();
          safeAssert(router.state.calls.at(-1).hasFunctionResult, 'Packaged Responses lost the paired tool result');
        }
        if (stream) safeAssert(text.includes(client === 'codex' ? 'response.completed' : 'message_stop'), 'Packaged adapter omitted terminal event');
      }
    }
    record('adapters: all five routes in JSON and SSE through packaged EXE');
    await post(app, '/adapter', { client: 'codex', adapter: 'chat' });
    await post(app, '/adapter', { client: 'claude', adapter: 'messages' });
    const copied = await verifyCopy(app, box);
    if (copied === 'COPY_AND_RESTORE_OK') record('packaged Copy Key: all original clipboard formats/order/raw bytes restored and verified');
    else unverified.push('packaged Copy Key: clipboard backup helper ' + copied + '; original clipboard untouched');
    const sampled = await stopMonitor(); stopMonitor = undefined;
    if (sampled) record('sampled real child command lines: ' + sampled + ' built-in PowerShell observations, no synthetic key');
    else unverified.push('real command-line sampling observed no DPAPI child; controlled spawn boundary tests cover argv');
    await restart();
    assertSession(await page(app), 'first'); safeAssert(selectedMode(await page(app), 'classroom'), 'Stored Classroom mode did not restore');
    const adaptersHtml = await page(app);
    safeAssert(/value="chat" selected/.test(adaptersHtml) && /value="messages" selected/.test(adaptersHtml), 'Adapter preferences did not restore in packaged EXE');
    record('adapters: independent preferences restored across packaged restart');
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
    await post(app, '/switch', { client: 'codex', mode: 'classroom' });
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
    safeAssert(/<form\b[^>]*\baction="\/copy"[^>]*>/i.test(migratedPage), 'Legacy key did not migrate');
    safeAssert(!migratedPage.includes(sessions.first.class_name) && !migratedPage.includes(sessions.first.nickname), 'Legacy migration invented identity');
    await post(app, '/switch', { client: 'codex', mode: 'classroom' });
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
    await post(app, '/switch', { client: 'codex', mode: 'classroom' });
    safeAssert(await proxy(app, sessions.second.model) >= 400, 'Temporary connection bypassed failed route-preference persistence');
    await assertPrivateDisk(box.root);
    await restoreAcl(); restoreAcl = undefined;
    await restart(); await disconnected();
    record('real sandbox create-file denial: migration failure deletes legacy, fresh memory connection remains Native, no restart recovery');
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
    await post(app, '/switch', { client: 'codex', mode: 'classroom' });
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
    const cleanupFailures = [];
    const cleanups = { lock: () => lock?.finish(), monitor: () => stopMonitor?.(), app: () => app?.stop(), acl: () => restoreAcl?.(), router: () => router.close(), sandbox: () => box.cleanup(), personalSettings: () => restoreCheck() };
    for (const [name, cleanup] of Object.entries(cleanups)) {
      try { await cleanup(); } catch (error) { cleanupFailures.push(name + (typeof error?.code === 'string' ? ':' + error.code : '')); }
    }
    if (cleanupFailures.length) throw new Error('Isolated verification cleanup failed: ' + cleanupFailures.join(', '));
    record('real user configuration hashes unchanged; sandbox files and ACL fixture removed');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exe = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/VansPod.exe');
  const multiRoute = await runMultiRouteLifecycle({ exe });
  const secureStorage = await runLifecycle({ exe });
  console.log(JSON.stringify({ multiRoute, secureStorage }, null, 2));
}
