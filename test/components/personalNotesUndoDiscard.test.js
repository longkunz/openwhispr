const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// PersonalNotesView's delayed saves, seen through the props it hands the
// editor. PersonalNotesView is real; NoteEditor is a stub that exposes them.

const NOTE = {
  id: 11,
  title: "Standup",
  content: "Notes",
  enhanced_content: "Summary",
  transcript: "",
  folder_id: null,
  space_id: 1,
  note_type: "meeting",
};

const MOCKS = {
  "/ui/useToast": `
    const toast = () => "1";
    export const useToast = () => ({ toast, dismiss() {} });
  `,
  "/icons": `export const Plus = () => null; export const Sparkles = () => null;`,
  "./NoteEditor": `
    export default function NoteEditor(props) {
      globalThis.__editorProps = props;
      return null;
    }`,
  "./SpacesTree": `export default (props) => { globalThis.__treeProps = props; return null; };`,
  "/overview/ContainerOverview": `export const ContainerOverview = () => null;`,
  "./NotesStructureIntroDialog": `export default () => null;`,
  "./ActionManagerDialog": `export default () => null;`,
  "./AddNotesToFolderDialog": `export default () => null;`,
  "./NotesOnboarding": `export default () => null;`,
  "/hooks/useActionProcessing": `
    export const useActionProcessing = () => ({ state: "idle", actionName: null, runAction(...args) { globalThis.__noteActionCalls?.push(args); } });
  `,
  "/stores/actionStore": `export const getActionName = (action) => action.name;`,
  "/hooks/useNotesOnboarding": `
    export const useNotesOnboarding = () => ({ isComplete: true, complete() {} });
  `,
  "/hooks/useTeamSpacesCapability": `export const useTeamSpacesCapability = () => false;`,
  "/useAuth": `export const useAuth = () => ({ isLoaded: true, isSignedIn: false, user: globalThis.__user ?? null });`,
  "/hooks/useSpaceRoster": `
    export const fetchSpaceRoster = async () => globalThis.__roster ?? [];
  `,
  "/stores/deviceNotesStore": `
    export const useDeviceNotesStore = (select) => select({ viewNoteId: null });
  `,
  "/stores/noteStore": `
    const note = () => globalThis.__note;
    export const setActiveNoteId = () => {};
    export const useActiveNoteId = () => note().id;
    export const useActiveNote = () => note();
    export const useNotes = () => [];
    export const useSpaces = () => globalThis.__spaces ?? [];
    export const useFolders = () => [];
    export const useActiveFolderId = () => null;
    export const useActiveContext = () => null;
    export const useIsTreeLoading = () => false;
    export const initializeNotes = async () => {};
    export const initializeNotesTree = async () => {};
    export const loadFolders = async () => {};
    export const setActiveContext = () => {};
    export const revealContainer = () => {};
    export const createFolder = async () => ({ success: false });
    export const getNoteFromStore = () => note();
    export const wasNoteDeletedHere = () => false;
    export const markNoteEdited = (id) => globalThis.__editedNotes?.push(id);
  `,
};

async function mountView(t, updateNote) {
  const calls = [];
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__editorProps;
    delete globalThis.__note;
  });
  globalThis.__note = NOTE;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNote: async () => NOTE,
        updateNote: async (...args) => {
          calls.push(["save", ...args]);
          return updateNote ? updateNote(...args) : { success: true };
        },
        discardNoteUndo: async (...args) => calls.push(["discard", ...args]),
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
    },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-personal-notes-undo-discard-",
    mockModules: MOCKS,
  });
  const { default: PersonalNotesView } = await vite.ssrLoadModule(
    "/components/notes/PersonalNotesView.tsx"
  );
  root = createRoot(container);
  const render = () => React.act(async () => root.render(React.createElement(PersonalNotesView)));
  await render();
  // Re-renders with the store's current note (globalThis.__note).
  Object.defineProperty(calls, "rerender", { value: render });
  Object.defineProperty(calls, "vite", { value: vite });
  Object.defineProperty(calls, "unmount", {
    value: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
  });
  return calls;
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const saves = (calls) => calls.filter(([kind]) => kind === "save");

test("a failed autosave is retried after navigating away from Notes", async (t) => {
  let success = false;
  const calls = await mountView(t, () => ({ success }));
  const { prepareControlPanelRelease } = await calls.vite.ssrLoadModule(
    "/utils/controlPanelRelease.ts"
  );
  await React.act(async () =>
    globalThis.__editorProps.onContentChange(NOTE.id, "Keep after navigation")
  );
  await React.act(() => settle(1100));
  await calls.unmount();
  assert.equal(await prepareControlPanelRelease(), false, "failed saves outlive the Notes view");
  success = true;
  assert.equal(await prepareControlPanelRelease(), true);
  assert.deepEqual(saves(calls).at(-1), [
    "save",
    NOTE.id,
    { title: NOTE.title, content: "Keep after navigation" },
  ]);
});

test("an idle panel retries a failed autosave before releasing", async (t) => {
  let success = false;
  const calls = await mountView(t, () => ({ success }));
  const { prepareControlPanelRelease } = await calls.vite.ssrLoadModule(
    "/utils/controlPanelRelease.ts"
  );
  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Retry me"));
  await React.act(() => settle(1100));
  assert.equal(await prepareControlPanelRelease(), false);
  success = true;
  assert.equal(await prepareControlPanelRelease(), true);
  assert.deepEqual(saves(calls).at(-1), [
    "save",
    NOTE.id,
    { title: NOTE.title, content: "Retry me" },
  ]);
});

test("a store rerender cannot replace the draft after an autosave failure", async (t) => {
  let success = false;
  const calls = await mountView(t, () => ({ success }));
  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Keep my draft"));
  await React.act(() => settle(1100));
  globalThis.__note = { ...NOTE, title: "Store update" };
  await calls.rerender();
  assert.equal(globalThis.__editorProps.note.content, "Keep my draft");
  success = true;
  const { prepareControlPanelRelease } = await calls.vite.ssrLoadModule(
    "/utils/controlPanelRelease.ts"
  );
  assert.equal(await prepareControlPanelRelease(), true);
});

test("a successful title save also recovers an earlier failed content autosave", async (t) => {
  let success = false;
  const calls = await mountView(t, (id, updates) => ({
    success,
    note: { ...NOTE, ...updates },
  }));
  const { prepareControlPanelRelease } = await calls.vite.ssrLoadModule(
    "/utils/controlPanelRelease.ts"
  );
  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Recovered body"));
  await React.act(() => settle(1100));
  success = true;
  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Recovered title"));
  await React.act(() => settle(1100));
  assert.deepEqual(saves(calls).at(-1), [
    "save",
    NOTE.id,
    { title: "Recovered title", content: "Recovered body" },
  ]);
  assert.equal(globalThis.__editorProps.note.content, "Recovered body");
  assert.equal(await prepareControlPanelRelease(), true);
  assert.equal(saves(calls).length, 2, "a successful recovery must retire the failed write");
});

test("a failed close flush retains its draft and retries before release", async (t) => {
  let success = false;
  const calls = await mountView(t, () => ({ success }));
  const { prepareControlPanelRelease } = await calls.vite.ssrLoadModule(
    "/utils/controlPanelRelease.ts"
  );
  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Unsaved"));
  assert.equal(await prepareControlPanelRelease(), false);
  assert.equal(globalThis.__editorProps.note.content, "Unsaved");
  success = true;
  assert.equal(await prepareControlPanelRelease(), true);
  assert.equal(saves(calls).length, 2);
});

test("an autosave already in flight keeps the panel alive until the database acknowledges", async (t) => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const calls = await mountView(t, () => pending);
  const { prepareControlPanelRelease } = await calls.vite.ssrLoadModule(
    "/utils/controlPanelRelease.ts"
  );
  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Saving now"));
  await React.act(() => settle(1100));
  assert.equal(saves(calls).length, 1);
  assert.equal(await prepareControlPanelRelease(), false);
  await React.act(async () => finish({ success: true }));
  assert.equal(await prepareControlPanelRelease(), true);
});

// A pull or ack can apply a clear made elsewhere while a title save waits.
// The editor's notes are then stale: the save writes only the title, and the
// editor then shows the stored notes instead of bringing the cleared text back.
test("a title save after a pull or ack writes only the title, then shows the stored notes", async (t) => {
  const calls = await mountView(t, (id, updates) => ({
    success: true,
    note: { ...globalThis.__note, ...updates },
  }));

  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Retitled"));
  globalThis.__note = { ...NOTE, content: "" };
  await calls.rerender();
  assert.equal(globalThis.__editorProps.note.content, "Notes", "a pending save keeps the draft");
  await React.act(() => settle(1100));
  assert.deepEqual(saves(calls), [["save", NOTE.id, { title: "Retitled" }]]);
  assert.equal(globalThis.__editorProps.note.content, "");
  assert.equal(globalThis.__editorProps.note.title, "Retitled");
});

test("a title edit after a notes edit still saves the notes", async (t) => {
  const calls = await mountView(t);

  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Typed"));
  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Retitled"));
  await React.act(() => settle(1100));
  assert.deepEqual(saves(calls), [["save", NOTE.id, { title: "Retitled", content: "Typed" }]]);

  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, ""));
  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Again"));
  await React.act(() => settle(1100));
  assert.deepEqual(saves(calls).at(-1), [
    "save",
    NOTE.id,
    { title: "Again", content: "", clear_fields: ["content"] },
  ]);
});
