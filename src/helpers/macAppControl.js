function compareVersions(a = "0", b = "0") {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const PRIVACY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";

// macOS 27.3 grants app control by picking the app from a list, replacing the
// drag into Accessibility. Callers check for macOS first: other platforms
// report unrelated version numbers.
function usesAppControlPicker(systemVersion = process.getSystemVersion?.()) {
  return compareVersions(systemVersion, "27.3") >= 0;
}

module.exports = { PRIVACY_SETTINGS_URL, usesAppControlPicker };
