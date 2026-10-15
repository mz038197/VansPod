import assert from "node:assert/strict";
import { it } from "node:test";
import vm from "node:vm";
import { classroomUpdateScript } from "../classroomUpdate";

const VS_CODE = "設定幫你更新好了，VS Code 還在裝睡。";

// Loads the script as a fresh page would, sharing sessionStorage across loads like a browser tab.
function page(storage: Map<string, string>, restart: string) {
  const spoken: string[] = [];
  const template = {
    content: { textContent: restart },
    set innerHTML(html: string) { this.content.textContent = html; },
  };
  const element = () => ({ setAttribute() {}, append() {}, className: "", textContent: "" });
  const stage = {
    querySelector: () => null,
    prepend(speech: { children?: unknown }) { void speech; spoken.push(context.lastQuote); },
    classList: { add() {} },
  };
  const context: Record<string, unknown> & { lastQuote: string; mascotSpeechDismissed: boolean } = {
    lastQuote: "",
    mascotSpeechDismissed: false,
    settingsBusy: false,
    hideMascotSpeech() {},
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    window: { addEventListener() {}, scrollY: 0, scrollTo() {} },
    document: {
      body: { classList: { toggle() {} } },
      querySelector(selector: string) {
        if (selector === "[data-classroom-restart]") return template;
        if (selector === ".classroom-update .connection-mascot") return stage;
        return null;
      },
      createElement() {
        const created = element();
        return new Proxy(created, {
          set(target, key, value) {
            if (key === "textContent" && target.className === "mascot-quote") context.lastQuote = value;
            return Reflect.set(target, key, value);
          },
        });
      },
    },
  };
  vm.runInNewContext(`${classroomUpdateScript}; this.refresh = refreshClassroomRestart;`, context);
  return {
    spoken,
    poll: (html: string) => (context.refresh as (html: string) => void)(html),
  };
}

it("Fadou announces a restart reminder once per tab instead of on every reload", () => {
  const storage = new Map<string, string>();
  assert.deepEqual(page(storage, VS_CODE).spoken, [VS_CODE]);

  const reloaded = page(storage, VS_CODE);
  reloaded.poll(VS_CODE);
  assert.deepEqual(reloaded.spoken, []);
});

it("Fadou speaks again when the reminder changes or returns after clearing", () => {
  const storage = new Map<string, string>();
  const first = page(storage, VS_CODE);
  first.poll("");
  first.poll(VS_CODE);
  assert.deepEqual(first.spoken, [VS_CODE, VS_CODE]);

  const reloaded = page(storage, VS_CODE);
  reloaded.poll("設定幫你更新好了，Codex 還在裝睡。");
  assert.deepEqual(reloaded.spoken, ["設定幫你更新好了，Codex 還在裝睡。"]);
});
