# Security Policy

`pi-forgejo-toolkit` handles Forgejo credentials and can perform repository mutations. Treat the package and every extension update as trusted code with the same access as your Pi process.

## Supported versions

Security fixes are provided for the latest published version. Upgrade before reporting a problem that is already fixed in a newer release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting flow:

https://github.com/alpertarhan/pi-forgejo-toolkit/security/advisories/new

Include:

- Affected toolkit, Pi, Node.js, Bun, and Forgejo versions
- The credential provider in use (`env` or `fgj`), without any token value
- Reproduction steps or a minimal proof of concept
- Expected and observed security boundaries
- Potential impact

Remove tokens, internal hostnames, private repository names, issue bodies, workflow inputs, and artifact contents. You should receive an acknowledgement within seven days.

## Credential and deployment guidance

- Prefer a dedicated, least-privilege Forgejo token for each server.
- Store tokens in `fgj` or environment variables; plaintext token fields are rejected.
- Do not commit `.pi/forgejo.json` when it reveals private infrastructure.
- Review the npm tarball and source repository before installing updates.
- Keep TLS verification enabled.
- Use disposable repositories when testing mutation paths.
