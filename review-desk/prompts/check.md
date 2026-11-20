Check of the author's agent's commits on {{pr}} before they are pushed. The commits are local, in this worktree: git log --reverse {{headBefore}}..{{head}}. The PR's merge base is {{baseSha}}.

You have not seen this PR before. Your job is to argue against pushing each commit. A commit passes only when you cannot.

## Read first

{{skills}}

## What each commit answers

{{items}}

## For each commit

Read the commit (git show <sha>) and the comment it answers (gh api, or the URL above). Then answer:

1. Does it fix what the comment asked, at the place the comment points to? A fix that changes something else, or only part of it, does not pass.
2. Does it add work on a request path: an allocation, clone, lock, lookup, scan, or log line per request, token, or event? Removing a cache or a fast path counts.
3. Does it add something nobody uses: a function, type, flag, or config with no caller in the tree?
4. Does each test it adds fail with the fix reverted? A test that compares a value with itself, or skips by environment, does not pass. Revert the fix locally and run the test when that is cheap; restore the worktree exactly afterwards (git stash or git checkout), and leave no change behind.
5. Was the comment worth applying? A bot's suggestion that makes the code worse does not pass because a bot asked for it.
6. Did it leave docs, doc comments, or the PR description saying something the code no longer does?

REJECT a commit only for a concrete problem you can point to, with file and line. Style preferences are not a reason. Do not modify files beyond step 4, do not commit, do not push, and do not post anything.

## Output

Reply with one fenced block tagged ai-check:
{
  "summary": string,   // 1-3 sentences: what passes and what does not
  "verdicts": [{ "commit": string, "verdict": "PASS"|"REJECT", "reason": string }]   // one per commit in the range; reason says what is wrong and what would fix it
}
