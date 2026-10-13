import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "node:test";
import { windowsFolderPickerCommand } from "../folderPicker";

const run = promisify(execFile);

it("creates a visible topmost owner before opening the Windows folder picker", {
  skip: process.platform !== "win32",
}, async () => {
  // Run the actual setup in Windows Forms, stopping at the modal dialog boundary.
  const command = windowsFolderPickerCommand.replace(
    "$dialog.ShowDialog($owner)",
    "$(if (!$owner.Visible -or !$owner.TopMost -or !$owner.IsHandleCreated) { throw 'Folder picker owner is not visible and topmost' }; 'Cancel')",
  );
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-STA", "-Command", command], {
    windowsHide: true,
    timeout: 30_000,
    encoding: "utf8",
  });
  assert.equal(stdout.trim(), "");
});

it("returns Chinese folder paths as UTF-8", {
  skip: process.platform !== "win32",
}, async () => {
  const command = windowsFolderPickerCommand.replace(
    "$dialog.ShowDialog($owner)",
    "$( $dialog.SelectedPath = 'C:\\課堂\\專案'; 'OK' )",
  );
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-STA", "-Command", command], {
    windowsHide: true,
    timeout: 30_000,
    encoding: "utf8",
  });
  assert.equal(stdout.trim(), "C:\\課堂\\專案");
});
