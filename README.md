# critical-decisions

A Claude Code mod that keeps you in the loop when the agent makes a call you never asked for, in the parts of your project you care about most.

You describe once what is critical in your project, such as pricing rules, a status flow, migrations or a folder. From then on:

- **An edit touches a critical area:** you get a toast, and the agent is reminded to declare whether the change was its own decision.
- **The agent decides something on its own** (a formula, a default, a rule, a schema) that you did not literally ask for: it calls `record_decision` with the decision, the reason and the alternative it ruled out.
- **Recorded decisions** show in a band above the prompt. The band stays until you dismiss it, across turns, so a decision does not scroll away unseen.

```
⚠️ 2 critical decisions  [ok]  (or /ok-decisions)
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

## Configure

Tell it what is critical, in your own words and in any language:

```
/alert-config pricing and tax rules, anything in src/billing, the orders.status flow, SQL migrations
```

A small model (Haiku) turns the text into areas, each with keywords and path globs, and shows you the result:

```
Critical in this project: "pricing and tax rules, anything in src/billing, ..."
• pricing — keywords: unit_price, tax_rate, discount · paths: src/billing/**
• order_status — keywords: orders.status, OrderStatus
• migrations — paths: **/*.sql, migrations/
```

Naming real identifiers, files or folders gives sharper rules. Run `/alert-config` again with new text to replace the rules.

The configuration is saved per project directory and kept across sessions.

| Command | What it does |
| --- | --- |
| `/alert-config <text>` | Describe what is critical; replaces the current rules |
| `/alert-config` | Show the current rules |
| `/alert-config clear` | Remove them (`limpar` works too) |
| `/decisions` | List every decision recorded in this session |
| `/ok-decisions` | Dismiss the band (same as its **ok** button) |

## How it detects

- **Which edits it watches:** `Edit`, `Write`, `MultiEdit` and `NotebookEdit` calls that succeed.
- **Paths:** an edit counts when its file path matches one of an area's globs.
- **Keywords:** an edit counts when its new text contains one of an area's keywords, matched case-insensitively from the start of a word. Prose files (`.md`, `.txt`, `.rst`) are skipped for keywords.
- **How often it warns:** at most once per area per turn.
- **What the agent is told:** your description goes into the system prompt, so the agent knows what to declare even when no keyword fires.

It warns; it never blocks an edit.

## Access

- **Model:** one Haiku call each time you run `/alert-config <text>`, through your own Claude Code session. Nothing else is sent anywhere.
- **Storage:** writes your rules to the plugin's own store, keyed by project directory.
- **Files and shell:** reads no files and runs no commands.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

## License

MIT
