# Security policy

Report suspected vulnerabilities privately through GitHub's **Report a
vulnerability** security-advisory form. Do not open a public issue containing
an exploit, secret, journal, database, or identifying path. Include affected
versions, impact, reproduction steps, and suggested mitigation. Maintainers
will acknowledge the report and coordinate disclosure; only the latest release
receives security fixes.

Golem executes hooks and an MCP server with the permissions of the local user.
Keep the dashboard and channel bound to trusted interfaces, inspect third-party
plugins, and protect `$GOLEM_HOME`. General usage questions belong in GitHub
issues, not the security channel.
