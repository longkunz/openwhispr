const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/notes/shareNoteRules.ts");

const PREFIX = "ow_share_abc1234";
const TOKEN = `${PREFIX}${"x".repeat(25)}`;
// A token minted before a rotation on another device: same format, other prefix.
const ROTATED_AWAY_TOKEN = `ow_share_zzz9999${"y".repeat(25)}`;

test("reconciling leaves a note alone when it already matches the server", async () => {
  const { reconcileLocalShareState } = await load();

  assert.equal(
    reconcileLocalShareState(
      { isShared: true, shareToken: TOKEN },
      { visibility: "link", token_prefix: PREFIX }
    ),
    null
  );
  assert.equal(
    reconcileLocalShareState(
      { isShared: true, shareToken: null },
      { visibility: "invited", token_prefix: PREFIX }
    ),
    null
  );
  assert.equal(
    reconcileLocalShareState(
      { isShared: false, shareToken: null },
      { visibility: "private", token_prefix: null }
    ),
    null
  );
});

// Every share-state write re-pushes a shared note, and while share mutations
// bump the cloud version that push can 409 into a conflict banner. A stale
// token is already ignored when copying, so it never earns a write alone.
test("a stale token alone does not cause a write", async () => {
  const { reconcileLocalShareState } = await load();

  assert.equal(
    reconcileLocalShareState(
      { isShared: true, shareToken: ROTATED_AWAY_TOKEN },
      { visibility: "link", token_prefix: PREFIX }
    ),
    null
  );
  assert.equal(
    reconcileLocalShareState(
      { isShared: false, shareToken: TOKEN },
      { visibility: "private", token_prefix: null }
    ),
    null
  );
});

test("a flag write also clears a stored token that a rotation elsewhere made stale", async () => {
  const { reconcileLocalShareState } = await load();

  assert.deepEqual(
    reconcileLocalShareState(
      { isShared: false, shareToken: ROTATED_AWAY_TOKEN },
      { visibility: "domain", token_prefix: PREFIX }
    ),
    { is_shared: 1, share_token: null }
  );
});

test("reconciling follows the server's shared flag", async () => {
  const { reconcileLocalShareState } = await load();

  assert.deepEqual(
    reconcileLocalShareState(
      { isShared: false, shareToken: null },
      { visibility: "invited", token_prefix: PREFIX }
    ),
    { is_shared: 1 }
  );
  assert.deepEqual(
    reconcileLocalShareState(
      { isShared: true, shareToken: TOKEN },
      { visibility: "private", token_prefix: null }
    ),
    { is_shared: 0, share_token: null }
  );
});
