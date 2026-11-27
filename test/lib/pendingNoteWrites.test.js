const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/lib/pendingNoteWrites.ts");
const release = async () =>
  (await import("../../src/utils/controlPanelRelease.ts")).prepareControlPanelRelease();

test("a replacement view merges a failed body with its title save and retires the retry", async () => {
  const { persistNoteWrite, hasPendingNoteWrite } = await load();
  await persistNoteWrite({ noteId: 1, updates: { content: "Unsaved body" } }, async () => ({
    success: false,
  }));
  const writes = [];
  await persistNoteWrite({ noteId: 1, updates: { title: "New title" } }, async (write) => {
    writes.push(write);
    return { success: true };
  });
  assert.deepEqual(writes, [
    { noteId: 1, updates: { title: "New title", content: "Unsaved body" } },
  ]);
  assert.equal(hasPendingNoteWrite(1), false);
  assert.equal(await release(), true);
});

test("a later note save cannot overtake an earlier in-flight save", async () => {
  const { persistNoteWrite } = await load();
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const writes = [];
  const first = persistNoteWrite({ noteId: 2, updates: { content: "First" } }, async (write) => {
    writes.push(write);
    return gate;
  });
  const second = persistNoteWrite({ noteId: 2, updates: { content: "Latest" } }, async (write) => {
    writes.push(write);
    return { success: true };
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.equal(await release(), false);
  finish({ success: true });
  await Promise.all([first, second]);
  assert.deepEqual(
    writes.map(({ updates }) => updates.content),
    ["First", "Latest"]
  );
  assert.equal(await release(), true);
});

test("explicitly discarding a failed save prevents its retry from restoring old text", async () => {
  const { persistNoteWrite, cancelPendingNoteWrite } = await load();
  let writes = 0;
  await persistNoteWrite({ noteId: 3, updates: { content: "Discarded" } }, async () => {
    writes += 1;
    return { success: false };
  });
  cancelPendingNoteWrite(3);
  assert.equal(await release(), true);
  assert.equal(writes, 1);
});

test("discard cancels a save queued behind in-flight IPC", async () => {
  const { persistNoteWrite, cancelPendingNoteWrite } = await load();
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const writes = [];
  const first = persistNoteWrite({ noteId: 4, updates: { content: "First" } }, async () => gate);
  const queued = persistNoteWrite(
    { noteId: 4, updates: { content: "Discarded" } },
    async (write) => {
      writes.push(write);
      return { success: true };
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  cancelPendingNoteWrite(4);
  finish({ success: true });
  await Promise.all([first, queued]);
  assert.deepEqual(writes, []);
  assert.equal(await release(), true);
});

test("close cannot retry a stale snapshot after a newer save of another note", async () => {
  const { persistNoteWrite } = await load();
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  let firstAttempt = true;
  await persistNoteWrite({ noteId: 5, updates: { content: "A" } }, async () => {
    if (firstAttempt) {
      firstAttempt = false;
      return { success: false };
    }
    return gate;
  });
  const writes = [];
  await persistNoteWrite({ noteId: 6, updates: { content: "Old B" } }, async (write) => {
    writes.push(write.updates.content);
    return { success: false };
  });
  const closing = release();
  await new Promise((resolve) => setImmediate(resolve));
  await persistNoteWrite({ noteId: 6, updates: { content: "New B" } }, async (write) => {
    writes.push(write.updates.content);
    return { success: true };
  });
  finish({ success: true });
  assert.equal(await closing, true);
  assert.deepEqual(writes, ["Old B", "New B"]);
});

test("a new failed write during another note's retry retains the panel", async () => {
  const { persistNoteWrite, cancelPendingNoteWrite, hasPendingNoteWrite } = await load();
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  let firstAttempt = true;
  await persistNoteWrite({ noteId: 7, updates: { content: "A" } }, async () => {
    if (firstAttempt) {
      firstAttempt = false;
      return { success: false };
    }
    return gate;
  });
  const closing = release();
  await new Promise((resolve) => setImmediate(resolve));
  await persistNoteWrite({ noteId: 8, updates: { content: "New failed note" } }, async () => ({
    success: false,
  }));
  finish({ success: true });
  assert.equal(await closing, false);
  assert.equal(hasPendingNoteWrite(8), true);
  cancelPendingNoteWrite(8);
  assert.equal(await release(), true);
});
