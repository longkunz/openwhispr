const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const read = (relativePath) => readFileSync(join(__dirname, "../..", relativePath), "utf8");

test("Your usage skips only a check for remote changes while its summary is fresh", () => {
  const view = read("src/components/InsightsView.tsx");

  assert.ok(
    view
      .replace(/\s+/g, " ")
      .includes(
        "!dataChanged && !accountReadFailedRef.current && accountId && isInsightFresh(readCachedInsightsSummary(accountId))"
      ),
    "a dictation always reloads; focus and the interval wait out a fresh summary, not a failure"
  );
  assert.ok(view.includes("else cacheInsightsSummary(accountId, account);"));
  assert.ok(
    view.includes('return load(dataChanged ? "refresh" : "allow");'),
    "only a check may be answered from the API's copy"
  );
});

test("clearing or shortening history drops the kept Insights answers", () => {
  const panel = read("src/components/ControlPanel.tsx");
  const onClear = panel.slice(panel.indexOf("const clearAllTranscriptions = useCallback"));
  assert.ok(
    onClear.indexOf("clearInsightsCache();") > onClear.indexOf("if (result.success) {") &&
      onClear.indexOf("clearInsightsCache();") < onClear.indexOf("} else {"),
    "a cleared history must not reopen Insights on the totals it removed"
  );
  const settings = read("src/components/SettingsPage.tsx");
  const retentionStart = settings.indexOf("setTranscriptRetentionDays(parseInt(");
  const onRetentionChange = settings.slice(
    retentionStart,
    settings.indexOf("className={RETENTION_SELECT_CLASS}", retentionStart)
  );
  assert.ok(
    onRetentionChange.includes("clearInsightsCache();"),
    "a shorter retention period deletes counters the kept summary still counts"
  );
});
