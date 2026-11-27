const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ipcHandlersSource = fs.readFileSync(
  path.join(__dirname, "../../src/helpers/ipcHandlers.js"),
  "utf8"
);

const cleanupHandler = ipcHandlersSource.match(
  /ipcMain\.handle\("cleanup-app", async \(event\) => \{([\s\S]*?)ipcMain\.handle\("update-hotkey"/
);

test("Reset app removes the skills folder and its versions folder", () => {
  assert.ok(cleanupHandler, "cleanup-app handler is present");
  const list = cleanupHandler[1].match(/for \(const directoryName of (\[[^\]]*\])\)/);
  assert.ok(list, "device cleanup still removes its userData folders in one list");
  assert.deepEqual(JSON.parse(list[1]), [
    "bin",
    "llama-cpp",
    "connectors",
    "skills",
    "skill-versions",
  ]);
});
