# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in sae, please **do not open a public
issue**. Instead, report it privately using GitHub's
[private vulnerability reporting](https://github.com/rbtavares/sae/security/advisories/new)
or email **support@lighthouse.one**.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce
- Any relevant logs, configs (with secrets redacted), or proof of concept

We aim to acknowledge reports within 3 business days and provide a resolution
timeline after initial triage.

## Supported versions

sae is under active development. Security fixes are applied to the `main` branch.
We recommend running the latest version.

## Scope

sae is a self-hosted RPC load balancer. Note that:

- By default it binds to `0.0.0.0` and includes permissive CORS headers. Do not
  expose it to untrusted networks without your own access controls.
- Upstream RPC endpoints and any API keys in your `config.json` are your
  responsibility to secure. Never commit real credentials.
