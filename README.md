# OpenWhispr

A self-hosted desktop dictation app for macOS, Windows and Linux, forked from
[OpenWhispr](https://github.com/OpenWhispr/openwhispr). This fork focuses on
dictation, local Notes and audio transcription. Its UI is English.

## Development

Use Node.js 24 (see [.nvmrc](.nvmrc)) and npm.

```sh
git clone https://github.com/longkunz/openwhispr.git
cd openwhispr
npm ci
npm run dev
```

The development command builds native helpers before launching Electron.
Native compilation needs the platform's C/C++ tools; macOS helpers also need
Xcode command-line tools. Build scripts print any missing platform requirements.

## Self-hosted transcription

New installations default to `https://stt.gehihi.dev/v1` and model `vietasr`.
Existing saved endpoints and models take precedence. Configure your own server
and any required headers in Settings → Speech. Review [.env.example](.env.example)
for environment options; keep real credentials in local configuration.

[VietASR streaming](docs/vietasr-streaming.md) describes the optional streaming
switch, protocol and fallback behavior. Notes recording and audio uploads use
batch transcription.

## Checks and packaging

```sh
npm run lint
npm run typecheck
npm test
npm run build:renderer
```

Use `npm run build:win`, `npm run build:mac` or `npm run build:linux` on the
corresponding host for packaging. The Windows command produces an unsigned
installer for personal use and disables publishing; no Azure signing credentials
are required. Native platform acceptance is separate from renderer builds and
mocked tests.

## Documentation

- [Dictation startup and bundle checks](docs/dictation-startup.md)
- [VietASR streaming](docs/vietasr-streaming.md)
- [Retained Orukeet adapter contract](docs/orukeet-streaming.md)
- [Orukeet language routing](docs/orukeet-streaming-language.md)
- [Model registry](model-registry/README.md)
- [Dependency patches](patches/README.md)
- [Contributing](.github/CONTRIBUTING.md)
- [Security](SECURITY.md)

The Orukeet documents describe retained adapter code and its backend requirements;
they do not certify managed Cloud support in this self-hosted build.

## Diagnostics and repository hygiene

For verbose logs, launch Electron with `--log-level=debug` or set
`OPENWHISPR_LOG_LEVEL=debug` in local configuration. Keep logs, benchmark captures
and generated reports outside tracked source; redact credentials before sharing.

`npm run clean` removes build output and **deletes the development transcription
database**, including its SQLite sidecars. Use it only when you intend to reset
that development data.

## License

[MIT](LICENSE). Upstream and third-party license notices remain with their assets.
