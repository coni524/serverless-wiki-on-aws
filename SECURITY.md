# Security Policy

**English** | [日本語](SECURITY.ja.md)

## Reporting a vulnerability

If you find a vulnerability, please report it through **Security → Report a vulnerability** on this GitHub repository rather than in a public issue. A public issue would put the attack steps in front of running deployments before a fix exists.

Please include the steps to reproduce it and, if you can, what it reaches: which API, at which permission, and what becomes possible. No response time is promised, but every report that arrives is read.

## Scope

Only the latest revision of `main` is in scope. Fixes are not backported to older revisions.

## Known limitations, not vulnerabilities

There is no audit log, no request rate limiting, and no way to require MFA. Reports about those are treated as known limitations rather than vulnerabilities.
