# Dictation startup footprint

The default window loads the dictation UI and startup/account-scope mirror. Notes/Settings, agent chat, meeting notifications and permission guides load through separate routes. Dictation does not initialize the onboarding assistant demo, which is unused by this self-hosted build.

Reasoning loads on demand. Cancelling while its chunk loads prevents that request from starting; credential changes invalidate an already loaded cache without loading the service. Account session restoration and background cloud sync are retired. UI translations and default prompt bundles ship in English only; speech recognition languages and transcript text remain independent.

## Build comparison

The static JavaScript dependency closure of the default dictation route was measured with `scripts/report-dictation-bundle.mjs`:

|                  | Before (d772cd36) |     After |
| ---------------- | ----------------: | --------: |
| JavaScript bytes |         6,090,014 | 1,485,424 |
| Gzip bytes       |         1,666,195 |   432,078 |
| Modules          |               652 |       465 |

This is about 76% less JavaScript to load/parse, not a measurement of total app RAM. Preload/native processes, browser state and recording buffers are outside this report.

Run from the repository root:

```powershell
node scripts/report-dictation-bundle.mjs "$env:TEMP/dictation-bundle.json" --check
```

The check rejects a startup closure containing the reasoning implementation, AI SDKs, chat engine, Notes store, sync service, auth UI or non-English locale resources. Optional features can still load their chunks when used.

## Retired background services

Startup no longer constructs the Assistant window or meeting process/microphone detection engine. Completing onboarding cannot prewarm an Assistant renderer. The Windows loopback capability probe runs when capture is requested rather than at startup.

The activation SQLite collector and product-event collector are no longer initialized. Workspace policy and enterprise account configuration are not fetched at launch; effective policy uses the device policy only. Notes/provider discovery returns an empty managed-provider list without a network request. Self-hosted and BYOK provider settings remain independent.

The account hook returns a settled local session without importing the auth client, affiliate collector or reconciliation/sync dependencies. Control Panel mount and opening a note no longer register cloud sync polling. A previously validated SQLite account scope is still restored locally so its notes remain visible; this cleanup does not purge or migrate those rows.

Validate the retirement paths with `test/helpers/retiredServicesStartup.test.js`, `test/hooks/useAuthOfflineAccount.test.js`. These checks do not measure full-app RAM or validate a physical microphone.

`test/components/appRouterOnboarding.test.js` exercises the current local startup through the real router and lifecycle: device-policy gating, note-file recovery, legacy account state, and auxiliary windows without normal-app startup effects. Tests for deleted guided-onboarding components were retired; compatibility tests for the surviving session utilities and permission overlay remain. Resetting a legacy onboarding session also clears its pending local-model selection.

`npm run lint` includes `lint:ipc` and `lint:audio`, which explicitly check the main-process IPC handler and renderer audio manager that the broad ESLint configurations otherwise ignore. Both reject warnings and errors.

The preload no longer exposes retired Assistant, authentication, cloud-sync, dictionary, action, updater or local-engine requests. The local analytics write/summary APIs remain for Insights. Version reads use Electron directly, and relaunch no longer calls the removed updater. Saved speaker names remain available for transcript export and note-file recovery. A legacy local-engine retry fails with `LOCAL_TRANSCRIPTION_RETIRED` and asks for a self-hosted endpoint.

The floating pill menu and router no longer offer the retired Assistant or meeting-detection windows. `windowIpcSenders.test.js` exercises local startup, version reads, removed preload/handler entry points and updates to existing notes without the removed speaker engines. `vietAsrDictationIpc.test.js` and the VietASR case in `audioManagerStreamingFinalization.test.js` cover the actual socket lifecycle, final acknowledgement, frozen endpoint/headers, batch fallback and cancellation. Tests dedicated to retired features have been removed; surviving Notes, self-hosted, lifecycle and platform tests remain. The full retained suite passes on Windows: 4,685 passed, 486 skipped, no failures. Skipped platform checks and physical microphone acceptance remain unverified.
