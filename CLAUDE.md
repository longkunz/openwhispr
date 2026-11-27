# Working in this repository

This is a self-hosted OpenWhispr fork. Preserve dictation, local Notes recording,
self-hosted endpoints and the optional VietASR streaming path. Removed account,
Cloud sync, sharing and Assistant UI should remain retired.

Use Node.js 24, pinned in `.nvmrc`, when changing dependencies or the lockfile.

When `.codegraph/` exists, use CodeGraph before locating or reading code.
Use the current source and package scripts as the architecture reference.
See [README.md](README.md) for setup and [docs/](docs/) for retained contracts.

Keep IPC changes aligned across main handlers, `preload.js` and renderer types.
UI strings use the English locale resources. UI icons come from
`src/components/icons/`; preserve third-party asset and font licenses.

Run checks appropriate to the changed behavior and report actual results.
For dictation startup changes, also run the bundle check described in
[docs/dictation-startup.md](docs/dictation-startup.md).
Distinguish automated checks from microphone, native paste and packaged-app
acceptance. Store temporary logs and generated reports outside the repository.

`npm run clean` also deletes the development transcription database and its
SQLite sidecars; it is not a build-only cleanup command.
