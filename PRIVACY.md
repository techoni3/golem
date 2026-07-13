# Privacy and support

Golem has no built-in analytics or telemetry. It stores project/session
metadata, tracker records, channel messages, logs, gates, and event journals on
the local machine under the state location described in the README. Journals
may contain prompts, tool arguments, paths, and model output. Durable journals
and tracker records remain until the user deletes them; transient registrations
and logs may be expired, capped, pruned, or rotated by their runtime owners.
Back up or remove `$GOLEM_HOME` according to local policy.

Optional ntfy notifications send their message text, topic, and a
`golem: <project-directory>` title to `https://ntfy.sh`. Harnesses, model
providers, and package registries have their own policies. Do not expose local
HTTP services publicly or submit private runtime artifacts in reports.

For support, search or open a GitHub issue with the Golem/Node/harness versions,
sanitized logs, expected behavior, and reproduction steps. Security reports
must follow `SECURITY.md`.
