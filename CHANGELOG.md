# Changelog

All notable changes to this mod. Versions follow [Semantic Versioning](https://semver.org/); each one is tagged `vX.Y.Z`.

## [Unreleased]

### Known issues
- Widening the scope is recorded as "know" instead of "undo" ([#7](https://github.com/Mucida/critical-decisions/issues/7)).

## [0.3.3] - 2026-10-20

### Changed
- A band row is the agent's own plain sentence, in the user's language, saying it was its call and what it replaced, with the reason right after it ([#6](https://github.com/Mucida/critical-decisions/issues/6)). The alternative ruled out stays in `/critical-list`.

## [0.3.2] - 2026-10-20

### Changed
- Band rows split into decided / instead of / why (superseded by 0.3.3).

## [0.3.1] - 2026-10-20

### Fixed
- The agent told decisions in prose instead of recording them. One hidden line after the first edit or MCP write of a turn reminds it, skipped once something is recorded ([#5](https://github.com/Mucida/critical-decisions/issues/5)).

## [0.3.0] - 2026-10-20

### Added
- Two levels: red "to rethink" and yellow "to know", red first ([#3](https://github.com/Mucida/critical-decisions/issues/3)).
- Per-decision **rethink** (sends it back to the agent) and **not critical** (teaches the agent, up to 10 examples per project) buttons.
- `/critical-areas auto`: the agent proposes and saves the areas through `save_critical_areas`.

### Changed
- Stricter default bar: record only what the user would likely want to undo; naming, formatting and convention-following choices are not critical.

### Fixed
- A choice the user left to the agent ("you decide") is recorded when it changes the result ([#4](https://github.com/Mucida/critical-decisions/issues/4)).

## [0.2.0] - 2026-10-20

### Added
- Default protection with no setup, for any kind of project, and a first-use notice ([#1](https://github.com/Mucida/critical-decisions/issues/1)).
- Keyword matching on prose files, shell commands and MCP calls ([#2](https://github.com/Mucida/critical-decisions/issues/2)).

## [0.1.0] - 2026-10-19

### Added
- `/critical-areas` turns a description into areas (keywords and paths); edits that touch them warn the user and remind the agent.
- `record_decision` tool and a band above the prompt that stays until dismissed; `/critical-list`, `/critical-ok`.

[Unreleased]: https://github.com/Mucida/critical-decisions/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/Mucida/critical-decisions/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Mucida/critical-decisions/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Mucida/critical-decisions/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Mucida/critical-decisions/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Mucida/critical-decisions/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Mucida/critical-decisions/releases/tag/v0.1.0
