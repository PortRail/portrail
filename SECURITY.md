# Security policy

## Reporting a vulnerability

Email **security@portrail.dev** — or use GitHub's private vulnerability
reporting on this repository (Security → Report a vulnerability).

Please do **not** open a public issue for a security problem.

Include: what you did, what happened, what you expected, and the versions of
Portrail, Node and the agent (`portrail doctor --json` covers most of it).

## What you can expect

|                          |                                                                     |
| ------------------------ | ------------------------------------------------------------------- |
| First reply              | within 3 working days                                               |
| Assessment and a plan    | within 10 working days                                              |
| Fix for a critical issue | target 14 days from the assessment                                  |
| Public advisory          | when the fix ships, or 90 days after the report, whichever is first |

Portrail has a single maintainer. If a deadline slips you will be told before it
slips, not after.

Support period: security fixes for the current major version. When a new major
version ships, the previous one receives security fixes for six months.

## Scope

**In scope**

- Any way to make an operation run without passing `Gateway.decide()`.
- Any way to make `decide()` return `allow` for an operation the configured
  rules should refuse.
- Any way to escape workspace containment.
- Privilege escalation between API-key scopes.
- Cross-machine access on the relay (Portrail Pro).
- Anything that makes a recorded verdict or audit entry wrong.

**Out of scope — by design, documented in `docs/security.md`**

- What an _allowed_ command does after it starts. Portrail is not a sandbox.
- An operator with a valid API key doing what their scopes permit.
- Data at rest being unencrypted (`~/.portrail`, mode 0700).
- The shipped default rule set being more permissive than your situation
  needs. Report _bypasses_ of the rules; tuning is a docs issue.
- Anything requiring an attacker who already has local shell as your user.

## Safe harbour

If you follow this policy in good faith, no legal action will be taken and your
report will be treated as authorised research. Please do not access other
people's data, degrade a service, or hold a finding for leverage.

## Credit

Reporters are credited in the advisory and the CHANGELOG unless they ask not
to be.
