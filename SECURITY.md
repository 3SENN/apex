# Security policy

Atelier is a browser, and it runs an AI agent inside your real tabs. We take reports about either very seriously.

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/3SENN/atelier/security/advisories/new)
(the **Report a vulnerability** button on the repository's Security tab).
If you can't use GitHub, email [contact@chinnovations.nl](mailto:contact@chinnovations.nl) instead.
Do not open a public issue, pull request or discussion for a security problem.

A good report includes:

- what an attacker can do, and what they need first (a malicious page, a pack, a local user, …);
- the Atelier version and platform;
- steps to reproduce, or a proof of concept;
- any idea you have for a fix.

## What happens next

- **Within 3 business days** we acknowledge your report.
- We confirm the problem, keep you posted while we work on it, and **aim to ship a fix within 90 days**; sooner for
  anything under active attack.
- We publish a **GitHub security advisory** for every fixed vulnerability, with a CVE requested through GitHub, and
  agree on the disclosure date with you.
- We credit you in the advisory unless you prefer not to be named.

## Supported versions

Security fixes go into the latest release. Atelier updates itself, so please make sure you are on the newest version
before reporting.

## Scope

In scope: the Atelier app and its update mechanism, the agent's guard and approval rules, the page bridge and preloads,
pack signing, review and sandboxing, and the local servers Atelier runs.

Out of scope: vulnerabilities in Chromium or Electron themselves (report those upstream), third-party websites,
MCP servers and connectors you add, and packs from outside the community index that you chose to install.

## Safe harbour

We will not take legal action against anyone who reports in good faith, avoids harming other people's data and
privacy, and gives us reasonable time to fix the issue before disclosing it.
