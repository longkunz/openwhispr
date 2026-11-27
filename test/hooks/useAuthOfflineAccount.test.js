const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

for (const signedIn of ["false", "true"]) {
  test(`local session does not resume or purge a stored account (isSignedIn=${signedIn})`, async (t) => {
    const initialStorage = {
      isSignedIn: signedIn,
      "openwhispr:accountScopeUserId": "old-account",
      "openwhispr:accountScopeValidated": "true",
      "openwhispr:accountProfile": JSON.stringify({ id: "old-account", name: "Local notes owner" }),
    };
    const { storage } = installBrowserGlobals(t, {
      initialStorage,
      window: {
        electronAPI: new Proxy(
          {},
          {
            get() {
              throw new Error("Unexpected account IPC");
            },
          }
        ),
      },
    });
    const vite = await createRendererServer(t, {
      mockModules: {
        "/lib/auth": 'throw new Error("Account client must not load");',
        "/services/SyncService.js": 'throw new Error("Cloud sync must not load");',
        "/stores/affiliateStore": 'throw new Error("Affiliate collector must not load");',
      },
    });
    const { useAuth } = await vite.ssrLoadModule("/hooks/useAuth.ts");
    for (let mount = 0; mount < 3; mount++) {
      const session = useAuth();
      assert.equal(session.isLoaded, true);
      assert.equal(session.isSignedIn, false);
      assert.equal(session.user, null);
      assert.equal(session.session, null);
      assert.equal(session.isOfflineAccount, false);
      assert.equal(await session.refetch(), null);
    }
    for (const [key, value] of Object.entries(initialStorage))
      assert.equal(storage.getItem(key), value);
  });
}
