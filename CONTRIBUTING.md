# Contributing

Use Node.js 20 or newer. Fork the repository, create a focused branch, run
`npm ci`, and make source changes in `substrate/` rather than the generated
`plugin/` tree. If generated output changes, render it with the documented sync
command and include it in the same change.

Before opening a pull request run `npm test`, `npm pack --dry-run`, and relevant
smokes. Use temporary `GOLEM_HOME` and `XDG_CONFIG_HOME` directories and a
non-default port so tests cannot read or mutate live Golem state. Explain the
behavioral change, test evidence, privacy/permission impact, and deferred work.

Use GitHub issues for reproducible bugs, support questions, and proposals.
Never include secrets, journal content, tracker databases, or private paths.
By contributing you agree that your contribution is licensed under MIT.
