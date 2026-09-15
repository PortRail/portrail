# The agents' own terms

Portrail drives Codex and Claude Code with the login already on your machine. Whether that
is allowed is the vendors' decision, not ours, and they have changed it before. This page
quotes what they say, with the date each quote was read, so you can judge for yourself.

**This page was accurate on 2026-09-15. Terms change without notice. Your account is your
responsibility.**

The short version, and the only sentence you need to remember:

> Your own subscription, on your own machine, driven by you, is ordinary use. The moment a
> machine works on behalf of other people — a shared build box, a team's automation — give
> the agent an API key instead.

## Anthropic — Claude Code and the Agent SDK

From [Claude Code — Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
read 2026-09-15:

> "**OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro,
> Max, Team, and Enterprise subscription plans and is designed to support ordinary use of
> Claude Code and other native Anthropic applications."

> "**Developers** building products or services that interact with Claude's capabilities,
> including those using the Agent SDK, should use API key authentication through Claude
> Console or a supported cloud provider. Anthropic does not permit third-party developers
> to offer Claude.ai login into their own applications, or to route requests through Free,
> Pro, or Max plan credentials on behalf of their users. Moreover, developers may not
> collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a
> Claude account must complete through Anthropic's own flow."

> "This does not restrict how customers provision and manage their own API keys or
> third-party inference provider credentials — for example, configuring an API key in a
> development environment, secrets manager, or machine image **for use by the customer's
> own authorized users** — provided the resulting usage is billed to the key owner under
> their agreement with Anthropic (or the applicable provider) and is not resold or
> intermediated as described above."

> "**Customers may not pay for, resell, or intermediate Claude usage on their end users'
> behalf.** Each end user must authenticate with their own Anthropic API key, Claude
> subscription plan credentials, or 3P inference provider credential."

> "Advertised usage limits for Pro and Max plans assume **ordinary, individual usage** of
> Claude Code and the Agent SDK."

> "Anthropic reserves the right to take measures to enforce these restrictions and may do
> so without prior notice."

On whether the Agent SDK draws on a subscription, from
[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
read 2026-09-15 (the notice itself is dated 15 June 2026):

> "We're pausing the changes to Claude Agent SDK usage described below. For now, nothing
> has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from
> your subscription's usage limits."

Anthropic restricted this in April 2026, reinstated it in May with separate credits, and
paused that change in June. Read the page before you build a business on it.

## OpenAI — ChatGPT plans and Codex

`openai.com` answers an automated fetch with HTTP 403, so the clauses below are reproduced
from secondary sources rather than read at the source.
**Open <https://openai.com/policies/row-terms-of-use/> in a browser and confirm the wording
before you rely on it.** Reported prohibitions from the ChatGPT Terms of Use include
automatically or programmatically extracting data or output, using output to build
competing models, and reverse engineering the services; the Services Agreement adds that a
customer "may not resell or lease access to their account or any end user account".

Against that: **Codex CLI is OpenAI's own product, Apache-2.0, and ships `codex exec` for
scripted runs**, available to anyone on a paid ChatGPT plan
([Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)).
A prohibition on programmatic extraction cannot sensibly mean "do not script the CLI we
published for scripting". OpenAI's own guidance still points automation at API keys, and
accounts have been suspended over automated usage patterns.

Gray, leaning allowed, for one person driving their own subscription on their own machine.

## Where Portrail sits

| The vendors' red line                                          | Portrail                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offer a vendor login inside your product                       | No. You run `codex login` or `claude` once, in the vendor's own flow.                                                                                                                                                                         |
| Collect, store or intermediate credentials or session tokens   | No. Codex's login is shared with a symlink to its own `auth.json`; Claude Code's stays in the OS keychain, which is why Portrail sets no `env` and no `CLAUDE_CONFIG_DIR`. Portrail reads the auth _mode_ to report it, never the credential. |
| Route requests through a subscription on behalf of other users | Not by design — one machine, one login, one operator. This is the line a shared machine crosses.                                                                                                                                              |
| Pay for, resell or intermediate usage                          | No. Portrail never touches billing and has no account of its own.                                                                                                                                                                             |
| "Ordinary, individual usage"                                   | Yours to keep. A schedule that hammers an agent around the clock is not ordinary, whatever the tooling.                                                                                                                                       |

**So:** on your own machine, with your own subscription, Portrail is a way of driving a
tool you are already licensed to use. On a shared or team machine, configure an API key for
the agent — Anthropic's carve-out for "the customer's own authorized users" is written for
exactly that, and `portrail doctor` reports which mode each agent is in.
