# critical-decisions

A Claude Code mod that keeps you in the loop when the agent makes a call you never asked for. It works for any kind of project: code, an article, a book, a dataset.

- **The agent decides something on its own** that you did not literally ask for: it calls `record_decision` with the decision, the reason and the alternative it ruled out.
- **Recorded decisions** show in a band above the prompt. The band stays until you dismiss it, across turns, so a decision does not scroll away unseen.
- **Something you marked as critical is touched** (a file, a term, a command): you get a toast, and the agent is reminded to declare whether it was its own decision.

```
⚠️ 2 critical decisions  [ok]  (or /critical-ok)
  [14:32] (pricing) Rounded tax to 2 decimals — because the invoice shows 2
  [14:40] (migrations) Made orders.status nullable — because old rows have none
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install critical-decisions --marketplace Mucida/critical-decisions
```

From a shell:

```sh
claude plugin install critical-decisions --marketplace Mucida/critical-decisions
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Mucida/critical-decisions`, then **Add plugin**.

## Default protection

It works without any setup. The agent is told that a decision is critical when it makes it on its own and it:

- adds, removes or swaps something you did not ask for: a topic, source, claim, comparison, feature, dependency or step;
- picks a value, rule, formula, default, format, structure or schema you did not specify;
- departs from your instructions, or from the project's own instructions it already has (such as `CLAUDE.md`);
- is hard to undo or reaches outside the session: deleting, overwriting, publishing, sending, deploying, migrating data, spending money;
- fills a gap in your request with an assumption that changes the result.

For example, you ask for a paragraph on wind power and the agent brings in solar panels as a comparison:

```
⚠️ Critical decision  [ok]  (or /critical-ok)
  [10:05] (general) Added a comparison with solar panels — because the paragraph needed a reference point
```

The first time it runs in a project, a line above the prompt says the default protection is on and how to make it yours.

The agent judges by itself whether a decision is critical: the mod gives it the criteria and shows you what it records. It does not run a second model over the agent's work, so a decision the agent does not see as critical can go unrecorded. Marking areas (below) narrows that gap.

## Configure

Tell it what is critical for you, in your own words and in any language:

```
/critical-areas pricing and tax rules, anything in src/billing, the orders.status flow, SQL migrations
```

A small model (Haiku) turns the text into areas, each with keywords and path globs, and shows you the result:

```
Critical in this project: "pricing and tax rules, anything in src/billing, ..."
• pricing — keywords: unit_price, tax_rate, discount · paths: src/billing/**
• order_status — keywords: orders.status, OrderStatus
• migrations — paths: **/*.sql, migrations/
```

A writing project works the same way:

```
/critical-areas no topic or source I did not ask for, nothing published without me, anything in drafts/final
```

Your areas add to the default protection; they do not replace it. Naming real identifiers, files or folders gives sharper rules. Run `/critical-areas` again with new text to replace the rules.

The configuration is saved per project directory and kept across sessions.

| Command | What it does |
| --- | --- |
| `/critical-areas <text>` | Describe what is critical; replaces the current rules |
| `/critical-areas` | Show the current rules |
| `/critical-areas clear` | Remove them (`limpar` works too) |
| `/critical-list` | List every decision recorded in this session |
| `/critical-ok` | Dismiss the band (same as its **ok** button) |

## How it detects

- **Recorded decisions:** the agent's own judgement, against the default criteria and your areas, both in its system prompt. This is what catches a decision no keyword names, such as an extra topic in an article.
- **Toasts for your areas:** successful `Edit`, `Write`, `MultiEdit` and `NotebookEdit` calls, shell commands and MCP tool calls.
  - **Paths:** an edit counts when its file path matches one of an area's globs.
  - **Keywords:** an edit counts when its new text contains one of an area's keywords, matched case-insensitively from the start of a word, in code and prose alike. A shell command or MCP call counts when what it was given contains one.
  - **How often:** at most once per area per turn.

It warns; it never blocks an edit.

## Access

- **Model:** one Haiku call each time you run `/critical-areas <text>`, through your own Claude Code session. Nothing else is sent anywhere.
- **Storage:** writes your rules, and that you saw the first-use line, to the plugin's own store, keyed by project directory.
- **Files and shell:** reads no files and runs no commands. When the default criteria point the agent to your project's instructions, those are the ones Claude Code already gave the agent; the mod does not open them.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

## License

MIT
