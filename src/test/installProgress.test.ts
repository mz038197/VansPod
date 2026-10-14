import assert from "node:assert/strict";
import { it } from "node:test";
import vm from "node:vm";
import { installProgressScript } from "../installProgress";


function harness(cancelOk = true, confirmAbort = true) {
  let submit!: (event: unknown) => Promise<void>;
  let click!: (event: unknown) => void;
  let complete!: (response: { ok: boolean; succeeded?: boolean; aborted?: boolean; output?: string; installedActionIds?: string[] }) => void;
  let aborts = 0;
  let nextUpdate!: () => Promise<void>;
  let reloads = 0;
  let confirmations = 0;
  let cancellations = 0;
  let removals = 0;
  let installedTag: { className?: string; textContent?: string } | undefined;
  const dialog = { remove() { removals += 1; } };
  let latestOutput = "Downloading demo…\n";
  const title = { textContent: "確認安裝" };
  const status = { textContent: "" };
  const output = { textContent: "", hidden: true, scrollTop: 0, clientHeight: 100, scrollHeight: 100 };
  const dismiss = { disabled: false, hidden: true, closest: () => dialog };
  const choices = { hidden: false };
  const buttons = [{ disabled: false }, { disabled: false }, dismiss];
  const panel = {
    querySelector(selector: string) {
      if (selector === "[data-install-dismiss]") return dismiss;
      if (selector === ".choices") return choices;
      if (selector === "form[data-abort-install]") return abortForm;
      return selector === "h2" ? title : selector === "[data-install-status]" ? status : output;
    },
    querySelectorAll() { return buttons; },
    setAttribute() {},
  };
  const abortButton = { disabled: false };
  const abortForm = { hidden: true, action: "/abort-install", querySelector: () => abortButton, matches: (selector: string) => selector.includes("data-abort-install"), closest: (selector: string) => selector === ".confirm-panel" ? panel : undefined };
  const form = { action: "/confirm", matches: (selector: string) => selector.includes('action="/confirm"'), closest: (selector: string) => selector === ".confirm-dialog" ? dialog : panel };
  const pending = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
    complete = (response) => resolve({ ...response, json: async () => response });
  });
  vm.runInNewContext(installProgressScript, {
    document: { addEventListener(event: string, handler: typeof submit) {
      if (event === "submit") submit = handler;
      if (event === "click") click = handler;
    },
      querySelectorAll() { return [{ value: "demo", closest: () => ({ querySelector: (selector: string) => selector === ".installed-tag" ? installedTag : { appendChild(tag: typeof installedTag) { installedTag = tag; } } }) }]; },
      createElement() { return {}; },
    },
    window: { location: { reload() { reloads += 1; } }, confirm: () => confirmAbort },
    FormData: class {},
    URLSearchParams: class {},
    fetch: async (url: string) => {
      if (url === "/abort-install") { aborts += 1; return { ok: true }; }
      if (url === "/confirm") { confirmations += 1; return pending; }
      if (url === "/cancel") { cancellations += 1; return { ok: cancelOk }; }
      return { ok: true, json: async () => ({ running: true, output: latestOutput }) };
    },
    setTimeout(update: typeof nextUpdate) { nextUpdate = update; return 1; },
    clearTimeout() {},
  });
  return {
    submit: () => submit({ target: form, preventDefault() {} }),
    cancel: () => submit({ target: { ...form, action: "/cancel", matches: (selector: string) => selector.includes('action="/cancel"') }, preventDefault() {} }),
    abort: () => submit({ target: abortForm, preventDefault() {} }),
    abortForm, abortButton, aborts: () => aborts,
    complete, title, status, output, buttons, dismiss, choices,
    acknowledge: () => click({ target: { closest: () => dismiss } }),
    update: async (value: string) => { latestOutput = value; await nextUpdate(); },
    counts: () => ({ confirmations, reloads, cancellations, removals }),
    installedTag: () => installedTag,
  };
}

it("opens an installation dialog in place without reloading or losing pending input", async () => {
  let submit!: (event: unknown) => Promise<void>;
  let dialog: object | undefined;
  let requests = 0;
  let reloads = 0;
  const button = { disabled: false };
  const expectedDialog = {};
  const form = {
    action: "/prepare",
    matches: (selector: string) => selector.includes('action="/prepare"'),
    querySelector: () => button,
    closest: () => ({ querySelector: () => null }),
  };
  vm.runInNewContext(installProgressScript, {
    document: {
      addEventListener(event: string, handler: typeof submit) { if (event === "submit") submit = handler; },
      querySelector: () => dialog,
      body: { appendChild(value: object) { dialog = value; } },
    },
    window: { location: { reload() { reloads += 1; } } },
    FormData: class {}, URLSearchParams: class {},
    DOMParser: class { parseFromString() { return { querySelector: () => expectedDialog }; } },
    fetch: async () => { requests += 1; return { ok: true, text: async () => "dialog markup" }; },
  });
  await submit({ target: form, preventDefault() {} });
  assert.equal(dialog, expectedDialog);
  assert.equal(button.disabled, false);
  assert.equal(reloads, 0);
  await submit({ target: form, preventDefault() {} });
  assert.equal(requests, 1);
});

it("updates output and holds a successful result until the student acknowledges it", async () => {
  const ui = harness();
  const request = ui.submit();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ui.title.textContent, "安裝中");
  assert.ok(ui.buttons.every((button) => button.disabled));
  assert.equal(ui.output.hidden, false);
  assert.equal(ui.output.textContent, "Downloading demo…\n");
  assert.equal(ui.counts().reloads, 0);
  await ui.update("Downloading demo…\nInstalling…\n");
  assert.equal(ui.output.textContent, "Downloading demo…\nInstalling…\n");
  await ui.submit();
  assert.equal(ui.counts().confirmations, 1);
  ui.complete({ ok: true, succeeded: true, output: "Installed 1 package\n", installedActionIds: ["demo"] });
  await request;
  assert.equal(ui.title.textContent, "安裝成功");
  assert.equal(ui.output.textContent, "Installed 1 package\n");
  assert.equal(ui.counts().reloads, 0);
  assert.equal(ui.choices.hidden, true);
  assert.equal(ui.dismiss.hidden, false);
  assert.equal(ui.dismiss.disabled, false);
  assert.equal(ui.installedTag()?.textContent, "已安裝");
  ui.acknowledge();
  assert.equal(ui.counts().reloads, 0);
  assert.equal(ui.counts().removals, 1);
});

it("holds a failed installation result until the student acknowledges it", async () => {
  const ui = harness();
  const request = ui.submit();
  ui.complete({ ok: true, succeeded: false, output: "dependency failed\n" });
  await request;
  assert.equal(ui.title.textContent, "安裝失敗");
  assert.equal(ui.output.textContent, "dependency failed\n");
  assert.equal(ui.counts().reloads, 0);
  assert.equal(ui.dismiss.hidden, false);
  assert.equal(ui.dismiss.disabled, false);
  await ui.submit();
  assert.equal(ui.counts().confirmations, 1);
  ui.acknowledge();
  assert.equal(ui.counts().reloads, 0);
  assert.equal(ui.counts().removals, 1);
});

it("cancels on the server and closes only the dialog without reloading the page", async () => {
  const ui = harness();
  await ui.cancel();
  assert.equal(ui.counts().cancellations, 1);
  assert.equal(ui.counts().confirmations, 0);
  assert.equal(ui.counts().removals, 1);
  assert.equal(ui.counts().reloads, 0);
});

it("keeps the dialog open and allows another cancellation attempt if cancellation fails", async () => {
  const ui = harness(false);
  await ui.cancel();
  assert.equal(ui.counts().removals, 0);
  assert.match(ui.status.textContent, /取消失敗/);
  assert.ok(ui.buttons.every((button) => !button.disabled));
  await ui.cancel();
  assert.equal(ui.counts().cancellations, 2);
});

it("keeps the result warning visible if confirmation fails without allowing a duplicate installation", async () => {
  const ui = harness();
  const request = ui.submit();
  ui.complete({ ok: false });
  await request;
  assert.equal(ui.title.textContent, "無法確認安裝結果");
  assert.match(ui.status.textContent, /重新整理頁面/);
  assert.equal(ui.counts().reloads, 0);
  await ui.submit();
  assert.equal(ui.counts().confirmations, 1);
});

it("offers 停止安裝 while installing and shows 已中止 after a confirmed abort", async () => {
  const ui = harness();
  const running = ui.submit();
  assert.equal(ui.abortForm.hidden, false);
  assert.equal(ui.abortButton.disabled, false);
  await ui.abort();
  assert.equal(ui.aborts(), 1);
  assert.equal(ui.status.textContent, "正在停止安裝…");
  ui.complete({ ok: true, succeeded: false, aborted: true, output: "serving\n已中止。\n" });
  await running;
  assert.equal(ui.title.textContent, "已中止");
  assert.equal(ui.abortForm.hidden, true);
  assert.equal(ui.dismiss.hidden, false);
});

it("keeps installing when the student declines to abort", async () => {
  const ui = harness(true, false);
  void ui.submit();
  await ui.abort();
  assert.equal(ui.aborts(), 0);
  assert.equal(ui.abortForm.hidden, false);
});

it("lets 停止安裝 reload the page when this page did not start the install", async () => {
  const ui = harness();
  await ui.abort();
  assert.equal(ui.aborts(), 0);
});
