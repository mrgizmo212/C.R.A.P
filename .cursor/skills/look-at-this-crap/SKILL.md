---
name: look-at-this-crap
description: Use when a user provides a Codebase Review Action Planner review folder, C.R.A.P. submission, cursor-prompt.md, summary.md, manifest.md, payload.json, ai-report.md, or screenshots captured for a codebase review.
---

# Look At This CRAP

## Purpose

Use this skill to turn a saved C.R.A.P. review into a real Cursor investigation. The review folder is evidence: treat it as the starting point, not the conclusion.

## Workflow

1. Read `summary.md` first to understand the reviewer, target app, captured sections, screenshots, notes, and final fields.
2. Read `manifest.md` and `payload.json` to map every screenshot, selected element, region, note, and URL back to the reported issue.
3. Read `ai-report.md` if it exists, but verify it against the raw evidence before trusting it.
4. Open relevant screenshots and compare them with the notes. Separate what is proven visually from what is inferred.
5. Trace each issue into the target codebase using actual code, routes, components, styles, API handlers, configs, tests, and runtime behavior.
6. Produce a concise investigation report with reproduction steps, severity, likely files/components, proof, and a concrete fix plan.
7. Do not edit code until the user explicitly asks for implementation.

## Output Format

Return Markdown with:

- `Summary`: what the review appears to report.
- `Evidence`: screenshots, notes, selectors, URLs, and files read.
- `Findings`: confirmed issues first, ordered by impact.
- `Likely Code Areas`: code-backed paths or clearly labeled hypotheses.
- `Fix Plan`: smallest safe steps to resolve the issues.
- `Open Questions`: only true blockers that cannot be answered from evidence or code.

## Rules

- C.R.A.P. evidence beats assumptions.
- Code beats screenshots when explaining why something happens.
- Screenshots beat guesses when explaining what the reviewer saw.
- If the evidence is weak, say so.
- If `ai-report.md` conflicts with raw evidence, trust the raw evidence.
- Keep the report action-ready for Cursor.
