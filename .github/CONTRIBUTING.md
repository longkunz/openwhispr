# Contributing

Create a branch from `main` and open a pull request in
[longkunz/openwhispr](https://github.com/longkunz/openwhispr).
Describe the behavior changed, checks run and remaining acceptance gaps.

Use Node.js 24 and `npm ci`. See [README.md](../README.md) for development and
packaging commands. Run lint, typecheck and relevant tests before submitting.
Use Prettier on changed files rather than formatting the whole repository.

Keep documentation aligned with this self-hosted fork. Put temporary logs,
benchmark captures and generated reports outside tracked source.
Keep test fixtures, native source and third-party license notices with their code.

Model catalog changes follow [the registry guide](../model-registry/CONTRIBUTING.md).
Report vulnerabilities using [SECURITY.md](../SECURITY.md).
