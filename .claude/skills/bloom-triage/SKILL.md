---
name: bloom-triage
description: Use whenever the user wants to check, triage, work through, or clear out the GitHub issues on MetroidRhyme/Bloom - phrases like "check for issues", "look into the open issues", "let's fix the open issues", "what's outstanding on GitHub", "clear the issue tracker", or "spin up agents to handle the issues" all trigger this. Walks the full pipeline end to end: pull open issues, ground them against the actual index.html code, get explicit user approval on which ones to build, confirm exactly how each should be built, implement (dispatching one sub-agent per issue in an isolated worktree when there's more than one), ship via the bloom-ship skill, then close each fixed issue on GitHub with a comment linking the fix. The pipeline has real stop points - it does not push to main or close issues just because it was asked to "look into" or "check" them; those later stages only run once the user has actually said to build/ship/close.
---

# Working through Bloom's GitHub issues

This skill covers the layer *around* a code change - finding out what's
outstanding, deciding what's worth building, agreeing on how, then closing
the loop on GitHub once it's shipped. It does not duplicate the mechanics of
safely shipping an `index.html` change - that's the `bloom-ship` skill's job,
and this skill hands off to it at the implementation stage rather than
re-describing ASCII scans and version bumps here.

Repo is `MetroidRhyme/Bloom` throughout - don't substitute a different
owner/repo, and don't guess at it from context.

## The five stages, and why they stay separate

1. Check current issues
2. Get approval on *whether* to build each one
3. Confirm *how* to build each approved one
4. Implement and ship
5. Close the issue and push to main

These are written as five stages instead of one loop because stages 2 and 3
are genuinely different questions, and collapsing them loses information.
"Should we build this at all" is a product call - some open issues turn out
to be declined, deferred, or duplicates once you actually look at them, and
that's a legitimate outcome, not a failure to find work to do. "Exactly how
should this be built" is a design call that only makes sense to ask about
things already approved - asking it too early wastes the user's attention on
options for something they might not even want. Keep them as two separate
answers, not one merged "yes and here's the plan" question, even though it's
tempting to fold them into a single AskUserQuestion call.

**Stop points matter.** If the user asked to "check the issues" or "look
into what's open" - anything short of an explicit instruction to build,
ship, or close - run stages 1-3 (survey, approve, confirm) and then stop.
Present what you found and what was decided, and wait. Do not continue into
stage 4/5 on your own initiative. Shipping to `main` and closing someone
else's issue tracker are both outward-facing and hard to walk back, and
"the user will probably want this shipped too" is exactly the kind of
inference that belongs in a question, not an assumption. Only skip stages
2-3 as *questions* (not as steps) when the user's own request already
answers them - e.g. "implement and ship issue #7 exactly as described" has
already given both approvals; you'd be asking a question you already know
the answer to.

## 1. Check current issues

```
mcp__github__list_issues(owner: "MetroidRhyme", repo: "Bloom", state: "OPEN",
  fields: ["number","title","body","user","labels","comments","created_at","updated_at"])
```

Include `user` in the fields - it's how stage 2 tells whether an issue was
opened by the repo owner (see the auto-approval rule below).

Read every open issue's title and body. For any issue that touches actual
game behavior (which is most of them - this is a single-file game, see
CLAUDE.md), go find the relevant code in `index.html` before summarizing
anything to the user. An issue report describes a symptom; the code tells
you the actual mechanism, whether it's already been "fixed" once before
(check the `CHANGELOG` array - a repeat report on something the changelog
already claims to have solved means the earlier fix was incomplete, not
that the reporter is wrong), and roughly how contained a fix would be. A
summary built only from the issue text, without opening the code, is a
guess wearing a report's clothing.

Also check for open PRs (`mcp__github__list_pull_requests`) so you're not
about to duplicate work already in flight.

## 2. Get approval on whether to build each one

Present a short summary of every open issue - what it's asking for, and
what you found when you looked at the code (is it a contained bug, a real
new subsystem, already half-addressed, ambiguous, etc.). For anything
beyond a single obvious issue, use `AskUserQuestion` to get an explicit
per-issue decision rather than assuming "open issue" means "build it now."
Plenty of legitimate outcomes here aren't "yes, build it": declined,
deferred to later, needs more info, or a duplicate of something else.

Don't skip this even when an issue looks obviously worth fixing to you -
"obviously worth it" is still a judgment the user gets to make, not one to
make on their behalf because the answer seems clear from where you're
sitting.

**Exception: issues opened by MetroidRhyme are auto-approved.** MetroidRhyme
is the repo owner and the person this pipeline is run for - an issue with
`user.login == "MetroidRhyme"` is already a decision that it's worth
building, the same as if they'd typed "build issue #N" directly. Skip the
stage-2 approval question for these and treat them as approved; still
summarize what the issue asks for and what you found in the code (that part
never gets skipped), just without the "should we build this" question
attached. An issue filed by anyone else (a player report, a collaborator)
still goes through the normal approval question.

This exception only ever answers "should we build this" - it does not
touch stage 3. An auto-approved issue can still need a real "how should
this be built" question if it has genuine design ambiguity; auto-approval
buys it a green light, not a blank check on specifics.

## 3. Confirm exactly how to build each approved one

For issues with real design ambiguity - UI shape, scope, balance/economy
numbers, naming, anything where two reasonable people could build genuinely
different things from the same issue text - surface the specific open
decisions and use `AskUserQuestion` with a recommended default plus real
alternatives. Look at the existing codebase for precedent first (an
existing pattern to mirror is worth more than an invented one - e.g. a new
map-marker mechanic should look at how `wild` flowers or `sprinklers`
already solve spawn placement/range-check/marker-diffing before proposing
something novel) so the options you offer are grounded, not arbitrary.

For issues that are unambiguous, well-scoped fixes - a rendering glitch, a
layout tweak with one obvious correct arrangement - a one-line "here's the
approach, proceeding" is enough; forcing a multiple-choice question on
something with only one sane answer just adds friction. Use judgment, but
when genuinely unsure whether something is a design decision or not, ask -
under-asking here is the more expensive mistake, since it's what leads to
building the wrong thing.

This stage has to actually complete - the user has to answer - before any
code gets written. A plan you assembled but didn't get confirmation on is
not a green light.

## 4. Implement and ship

Once stages 2-3 are settled, build. How you organize this depends on how
many issues got approved:

**One issue, or issues small enough to do in sequence:** just implement it
directly in the current session. No need for the multi-agent machinery
below.

**Multiple approved issues in one session:** dispatch one sub-agent per
issue via the `Agent` tool with `isolation: "worktree"` - each agent gets
its own git worktree, so concurrent agents editing the single `index.html`
file can't step on each other's uncommitted changes. This has already run
successfully in this repo: four issues, four parallel worktree agents, zero
conflicts on merge. For each agent's prompt, give it:

- Full standalone context (it starts cold) - the relevant CLAUDE.md rules
  (ASCII-only, single-file structure, emoji-as-escape convention), the
  specific issue and the decision made for it in stage 3, and pointers to
  the actual code regions/functions it'll be touching.
- An explicit instruction to commit locally on its own branch but **not**
  bump `#game-version`, **not** touch the `CHANGELOG` array, and **not**
  push - those get done once, centrally, after every agent's work is
  merged, to avoid every agent racing to bump the same version span and
  produce a pile of unmergeable changelog entries.
- Explicit scope limits naming the other issues/areas it should leave
  alone, so agents don't accidentally wander into each other's territory
  even though they're in separate worktrees (they still share review
  surface once merged).
- For anything visual/interactive, a nudge to use the `bloom-playtest`
  skill and actually look at a screenshot rather than reasoning about CSS
  transforms blind - this has caught real bugs (a stem-clipping report that
  turned out to have a different root cause than the obvious first guess).
- A request to report back its branch name and commit SHA in its final
  message, since that's what you'll merge.

Once agents report back (they run in the background - you'll get a
notification per agent, not all at once), merge each branch into the
working branch as it completes, one at a time:

```
git merge --no-ff worktree-agent-<id> -m "Merge fix for issue #N: <summary>

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Merging incrementally as each agent finishes (rather than waiting for all
of them) surfaces a conflict against a small diff instead of a pile of
them at once, and lets you report real progress to the user as it happens
instead of going quiet for the whole run.

After every approved issue is merged in: run **one** combined version bump
and **one** `CHANGELOG` entry covering everything shipped this round (see
the `bloom-ship` skill for the exact mechanics - patch vs. minor bump,
where the changelog array lives, writing it for a player not a developer).
Then run the *entire* `bloom-ship` checklist - ASCII scan, syntax check,
and a regression/smoke test - before committing. For a multi-issue round,
build one combined Playwright smoke test that exercises all the merged
changes together in a single page load (open every touched panel, click
every new button, trigger every new interaction), not just each agent's
own isolated test - the individual agents already proved their own change
works in isolation; what you're checking here is that they didn't
interfere with each other once combined, which their separate worktrees
couldn't have caught.

## 5. Close the issue and push to main

Push first, then close - a closed issue pointing at a commit that isn't
live yet is worse than a closed issue with no comment at all.

Always push to `main` once the user has approved shipping - no PRs, no
branches left unmerged. This holds even in a session that was given
different git-branch instructions for developing the change (e.g. a
designated feature branch for this particular piece of work): do the
work on that branch as instructed, but the moment the user has approved
it, fast-forward or merge that branch into `main` and push `main` -
don't stop at "pushed to the feature branch" and leave it there. The
user's approval is what triggers the push to `main`; branch instructions
only ever govern where the work happens *before* that point.

For each issue that actually got shipped this round:

```
mcp__github__add_issue_comment(owner: "MetroidRhyme", repo: "Bloom",
  issue_number: N, body: "Fixed in vX.Y.Z (main@<short-sha>). <one or two
  sentences on what changed, in player-facing terms - and if the fix
  involved a non-obvious root cause, say what it actually was, the same
  way you'd write it up for the user>.

---
_Generated by [Claude Code](https://claude.ai/code)_")

mcp__github__issue_write(method: "update", owner: "MetroidRhyme",
  repo: "Bloom", issue_number: N, state: "closed", state_reason: "completed")
```

The comment always ends with the attribution footer above, verbatim - blank
line, `---`, then the italic link line.

**Only issues actually shipped this round get closed as `completed`.** An
issue declined or deferred back in stage 2 is a different outcome and needs
different handling: leave it open with a comment explaining the decision,
or close it with `state_reason: "not_planned"` **only if the user
explicitly said not to build it** - never close a declined issue as
`completed` just because the pipeline touched it. The GitHub issue state is
supposed to be a true record of what happened; don't let "we ran the
pipeline on it" get confused with "we built it."
