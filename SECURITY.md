# Security

Report a vulnerability privately to the repository maintainer through
[GitHub security advisories](https://github.com/longkunz/openwhispr/security/advisories)
when private reporting is available. Otherwise contact the maintainer privately
to arrange a report. Include the affected commit, reproduction steps and impact;
keep credentials, recordings and personal notes out of public issues.

This self-hosted fork sends transcription audio to the configured server.
New installations use the endpoint documented in [README.md](README.md).
Choose an endpoint you trust and configure authentication where required.

Electron uses a restricted preload bridge and context isolation. Changes to IPC,
URL validation, credential storage, native helpers and dependency downloads need
security review. Renderer tests alone do not verify packaged-app security.

Upstream support windows, response-time promises and hosted-service policies
do not establish support commitments for this fork.
