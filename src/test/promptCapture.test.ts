import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPromptCapture } from "../promptCapture";

describe("Prompt Capture recorder", () => {
  it("starts with recording off and nothing captured", () => {
    const capture = createPromptCapture();
    assert.equal(capture.recording, false);
    assert.deepEqual(capture.list(), { captures: [], dropped: 0 });
  });

  it("records only between start and pause", () => {
    const capture = createPromptCapture();
    capture.start();
    assert.equal(capture.recording, true);
    capture.pause();
    assert.equal(capture.recording, false);
  });

  it("clear empties the recorder without changing the recording state", () => {
    const capture = createPromptCapture();
    capture.start();
    capture.clear();
    assert.equal(capture.recording, true);
    assert.deepEqual(capture.list(), { captures: [], dropped: 0 });
  });
});
