# critical-decisions

A Claude Code mod that keeps you in the loop when the agent makes a call you never asked for. It works for any kind of project: code, an article, a book, a dataset.

- **The agent decides something on its own** that you did not literally ask for: it calls `record_decision` with the decision, the reason and the alternative it ruled out.
- **Recorded decisions** show in a band above the prompt: red for what you may want to take back, yellow for what is worth knowing. The band stays until you dismiss it, across turns, so a decision does not scroll away unseen.
- **Each decision has two buttons:** **rethink** sends it back to the agent ("undo it if you can, propose other ways, ask me first"); **not critical** takes it off and teaches the agent not to record its like again.
- **Something you marked as critical is touched** (a file, a term, a command): you get a toast, and the agent is reminded to declare whether it was its own decision.

```
⚠️ Critical decisions: 1 to rethink · 1 to know  [ok]  (or /critical-ok)
  [14:40] (migrations) Made orders.status nullable — because old rows have none  [rethink] [not critical]   ← red
  [14:32] (pricing) Rounded tax to 2 decimals — because the invoice shows 2       [rethink] [not critical]   ← yellow
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

It works without any setup. The agent is told to record a decision only when you would likely want to undo or rethink it if you saw it, and, when in doubt, not to record. That holds when it made the decision on its own and it:

- adds, removes or swaps something you did not ask for: a topic, source, claim, comparison, feature, dependency or step;
- picks a value, rule, formula, default, format, structure or schema you did not specify;
- departs from your instructions, or from the project's own instructions it already has (such as `CLAUDE.md`);
- is hard to undo or reaches outside the session: deleting, overwriting, publishing, sending, deploying, migrating data, spending money;
- fills a gap in your request with an assumption that changes the result.

A choice you left to the agent ("you decide") still counts when it changes the result: you delegated it, so you get told what it picked.

Naming, wording, formatting, refactors that keep behaviour, steps that follow straight from your request and choices that follow the project's conventions are not critical. Related choices go in one record.

For example, you ask for a paragraph on wind power and the agent brings in solar panels as a comparison:

```
⚠️ Critical decisions: 1 to rethink  [ok]  (or /critical-ok)
  [10:05] (general) Added a comparison with solar panels — because the paragraph needed a reference point  [rethink] [not critical]
```

If it records something you do not care about, press **not critical**. The mod keeps the last 10 such records per project and shows them to the agent as examples of what not to record.

The first time it runs in a project, a line above the prompt says the default protection is on and how to make it yours.

The agent judges by itself whether a decision is critical: the mod gives it the criteria and shows you what it records. It does not run a second model over the agent's work, so a decision the agent does not see as critical can go unrecorded. Marking areas (below) narrows that gap.

## Configure

Not sure what to write? Let the agent propose it:

```
/critical-areas auto
```

The agent uses what it already knows of the project, its instructions included, saves up to 6 areas and shows them to you. `/critical-areas clear` undoes it.

Or tell it what is critical for you, in your own words and in any language:

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
| `/critical-areas auto` | The agent proposes the areas and saves them |
| `/critical-areas <text>` | Describe what is critical; replaces the current rules |
| `/critical-areas` | Show the current rules and what was marked as not critical |
| `/critical-areas clear` | Remove the rules and the not-critical examples (`limpar` works too) |
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

- **Model:** one Haiku call each time you run `/critical-areas <text>`, through your own Claude Code session. `/critical-areas auto` and **rethink** send one message to your own agent, only when you ask. Nothing else is sent anywhere.
- **Tokens:** about 450 tokens of criteria in the system prompt, cached with it, plus up to about 200 for the not-critical examples. No reminder per turn; a toast's reminder only when an edit touches an area you marked.
- **Storage:** writes your rules, the not-critical examples and that you saw the first-use line to the plugin's own store, keyed by project directory.
- **Files and shell:** reads no files and runs no commands. When the default criteria point the agent to your project's instructions, those are the ones Claude Code already gave the agent; the mod does not open them.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

## License

MIT
