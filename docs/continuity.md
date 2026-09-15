# Continuity

Portrail is maintained by one person. That is a fair thing to ask about before you put it
between an agent and your files, so here is what happens in each case that matters.

## The free core outlives its maintainer

`portrail` is MIT. You may fork it, ship it, and charge for it, with no permission and no
contributor agreement to sign. There is nothing to revoke.

Every release is a tag in the repository and a version on npm, with the tarball attached
to the GitHub release. A fork starts from any of them:

```sh
git clone https://github.com/PortRail/portrail && cd portrail
npm install && npm test        # deterministic, no network, no agent, no key
```

The suite is the specification. `test/rules-corpus.test.ts` says what the built-in rules
promise, one command line per row; `test/openapi.test.ts` keeps the routes and
`openapi.json` in step; `docs/security.md` states what the product does and does not do,
and each claim has a test behind it. A fork that keeps those green has kept the product.

## If releases stop

Nothing installed stops working. Portrail runs entirely on your machine, talks to no
service of ours, and checks nothing over the network — there is no licence server, no
telemetry and no phone-home in the free product. An unmaintained Portrail keeps deciding
exactly as it did the day it was installed.

What you would lose is future fixes. The honest consequence: watch the repository for
security advisories, and if it goes quiet for long enough to worry you, pin the version
you audited and fork.

## Portrail Pro

Pro is proprietary and sold by **Socialinsiders UG (haftungsbeschränkt)**, not by a
private individual, so a licence survives the person who wrote the code.

- **A licence that lapses does not disarm anything.** The rules, the approvals and the
  audit log keep working; only the conveniences that need a live product — the relay,
  webhooks, signed approval links and editing the policy over the API — switch off. An
  expired customer is never left with an agent that decides for itself.
- **Source escrow is available on request** for Team and Fleet customers, so the code that
  enforces your policy does not depend on a company continuing to exist.
- **Pro is an extension, not a fork.** It plugs into the free core through
  `portrail/extension`. Remove it and the core keeps running with its own allow/deny
  lists — that is tested, not asserted.

## Reporting something

Security problems go to `security@portrail.dev` or GitHub's private vulnerability
reporting; see [SECURITY.md](../SECURITY.md) for the timelines. Everything else belongs in
an issue.
