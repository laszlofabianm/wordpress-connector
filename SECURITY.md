# Security Policy

## Credentials

Use a dedicated WordPress Application Password with the least-privileged user
role that supports the required operations. Keep credentials in environment
variables and use HTTPS for remote WordPress sites.

The repository ignores `.env` files and includes only placeholders in
`.env.example`.

If an application password is exposed, revoke it immediately in the WordPress
user profile, generate a replacement, and remove it from Git history before
publishing the repository.

## Reporting A Vulnerability

Please report security issues privately to the repository owner instead of
opening a public issue containing credentials or exploit details.
