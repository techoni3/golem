# Privacy and support

Golem has no built-in analytics or telemetry. It stores project/session
metadata, tracker records, channel messages, logs, gates, and event journals on
the local machine under the state location described in the README. Journals
may contain prompts, tool arguments, paths, and model output. Data remains until
the user deletes it; back up or remove `$GOLEM_HOME` according to local policy.

Optional ntfy notifications disclose their message text and topic to the
configured ntfy operator. Harnesses, model providers, and package registries
have their own policies. Do not expose local HTTP services publicly or submit
private runtime artifacts in reports.

For support, search or open a GitHub issue with the Golem/Node/harness versions,
sanitized logs, expected behavior, and reproduction steps. Security reports
must follow `SECURITY.md`.
