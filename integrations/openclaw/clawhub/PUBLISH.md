# Publishing the Sera skill to clawhub

`clawhub` is the public OpenClaw skill registry. It's a hosted backend (Convex), not a docs repo — skills are published via the `clawhub` CLI, not via PR.

## Prerequisites

- OpenClaw installed (gives you the `clawhub` CLI)
- A GitHub account (for OAuth into the clawhub backend)

## Steps

```bash
# 1. From the directory containing SKILL.md
cd integrations/openclaw/clawhub

# 2. Auth into clawhub (opens browser, GitHub OAuth)
clawhub login

# 3. Validate the skill manifest before publishing
clawhub skill validate ./SKILL.md

# 4. Publish
clawhub skill publish ./SKILL.md
```

The skill will appear in the public clawhub registry as `sera`.

## Why this isn't a PR

OpenClaw's `clawhub` repo is the source for the **clawhub web app** itself, not the registry of skills. Adding a SKILL.md to a fork wouldn't surface in any user's clawhub UI — the registry lives in the Convex backend.

## After publishing

- Skill is discoverable via `clawhub skill search sera`
- Users can install with `clawhub skill install sera`
- Updates: bump the version in `SKILL.md` frontmatter and re-run `publish`

OpenClaw's CONTRIBUTING.md asks new features to start in their Discord (`#clawhub`) before publication. Worth a hello before submitting.
