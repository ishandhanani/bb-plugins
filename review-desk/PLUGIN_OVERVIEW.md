Review a GitHub pull request inside bb the way you would online, with a chat partner that has the code in front of it.

## What you get

- A **board** of the pull requests you are tracking: paste a link, and the PR becomes a card under Unreviewed, Changes requested, or Babysit (approved, now watching CI until it merges), following GitHub's state; drag a card to hold it elsewhere until GitHub moves it. Each card says in one glance what is in the way: failing checks by name, open threads, approvals, conflicts, your unsent comments; a Babysit card ends in one verdict, from merge conflicts to ready to merge. Merged and closed PRs fold away under the columns.
- A **Map** first: a [diffmap](https://github.com/tanishqkancharla/diffmap) walkthrough of the PR, with diagrams, call stacks, and code tied to the diff, written by a helper that reads the code. Then the **Diff** and the **Comments**.
- A **PR page**: state, title, author and branches, then Description, Discussion, and Commits, then the changes as collapsed file cards in path order with split, soft-wrapped, syntax-highlighted diffs, expandable context, viewed marks, and a lines-left counter.
- **GitHub threads inline** on their lines, with reply and resolve. Checks, reviewers, assignees, and labels live in the Info tab.
- **Simple English** on every comment: flip a GitHub comment to a plain rewrite in short common words that keeps the facts and the code, written on demand by a second hidden thread with your own simple-english skill rules.
- **Commits**: click one for its diff, shift-click two for the range, and see what is new since you last looked.
- **Comments from the diff**: select lines, write Markdown, keep them pending, then submit one review to GitHub as comment, approve, or request changes.
- **Private notes**: slop and cleanup notes only you see, from the helper reading the diff or your own. Dismiss them, or promote the ones worth saying into pending comments.
- **Chat with the PR**: an analyst per provider runs in a worktree at the PR head. Ask anything. Code goes in as pills: select lines and press `a`, or type `@` to attach a changed file, symbol, review thread, or `path:10-20`. Pills resolve to the code when you send, so the transcript stays readable. Turn an answer into a pending comment or send it to a Roundtable room.

## How it works

The plugin fetches the PR head into a detached worktree on the machine that holds the repository and reads diffs and file contents from git. GitHub data comes from your `gh` login. The chat runs on ordinary bb threads spawned into that worktree, read-only by instruction, rendered with bb's own thread view. The map and the notes come from one hidden helper thread per review that reads the diff in that worktree.

## For agents

The bundled skill tells analyst threads how requests arrive and how to answer.
