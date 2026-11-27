# Dictation startup footprint

The default window loads the dictation UI and startup/account-scope mirror. Notes/Settings, agent chat, meeting notifications and permission guides load through separate routes. Dictation does not initialize the onboarding assistant demo, which is unused by this self-hosted build.

Reasoning loads on demand. Cancelling while its chunk loads prevents that request from starting; credential changes invalidate an already loaded cache without loading the service. Transcription sync loads only when cloud backup is enabled. UI translations and default prompt bundles ship in English only; speech recognition languages and transcript text remain independent.

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
