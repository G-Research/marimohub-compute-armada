# Security and Coordinated Vulnerability Disclosure Policy

This project appreciates and encourages coordinated disclosure of security vulnerabilities.
We prefer that you use the GitHub reporting mechanism to privately report vulnerabilities.
Under the main repository's Security tab, click "Report a vulnerability" to open the
advisory form.

If you are unable to report it via GitHub, have received no response after repeated
attempts, or have other security related questions, please contact
[security@gr-oss.io](mailto:security@gr-oss.io) and mention this project in the subject
line.

## What is in scope

The adapter runs inside marimohub's own process with its privileges, and the kernel agent
(`agent/`) is a command runner reachable over HTTP inside every kernel pod, guarded by a
per-session token. Anything that lets a caller run a command in a pod without that token,
reach a pod other than its own, recover the token from the pod spec, or derive one without
`ARMADA_AGENT_TOKEN_SECRET`, is in scope. So is
anything that lets a job set, queue or Lookout answer be confused between two sandboxes or
two installations. How the agent port is exposed and restricted in a given deployment is
described in the README's Deployment section and in `docs/DECISIONS.md`.
