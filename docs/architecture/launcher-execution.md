# Launcher execution

`@golem/launcher` keeps GOL-33 resolution pure, then owns the separate I/O
boundary that turns a qualified `LaunchPlan` plus an adapter contribution into
one native child process.

## Trust and preparation

- An explicit executable is accepted only when it is absolute, realpath-equal
  to a trusted configured path, regular, executable, and not world-writable.
- PATH search uses a bare command name and exact PATH order. Its first present
  candidate is decisive: an unsafe shadow, symlink loop, Golem executable, or
  compatibility shim is refused instead of falling through to another binary.
- Execution builds an argv array and uses `shell:false`. Spaces, `$()`,
  backticks, globs, and semicolons are data, never command language.
- The child receives only an intentional environment allowlist plus the plan's
  credential-key references resolved at execution time. Launch records expose
  sorted key names, redacted executable identity, capability/preference facts,
  and no secret values or temporary roots.

## Lifecycle and modes

Interactive TTY launches inherit stdio; noninteractive launches use bounded
capture. Unix launches own a detached process group, forward SIGINT/SIGTERM and
SIGWINCH, and terminate with SIGTERM followed by bounded SIGKILL. A timeout
uses the same owned-group cleanup. Managed plans call the injected GOL-32
control-plane ensure port before spawning; direct plans never claim or start
management. Dry-run performs the same discovery/environment validation and
returns the redacted record without ensuring or spawning.

## Evidence

The one J5 `native-spawn-safety` journey uses the real fake native executable.
It protects against recursive/shadowed discovery, shell interpolation,
credential propagation, TTY/noninteractive drift, signal/resize or exit-code
loss, orphan descendants, unsafe dry-run, and managed-control false claims.
Run it with Node 24 using `npm run test:launcher-process` or through the serial
journey runner.
