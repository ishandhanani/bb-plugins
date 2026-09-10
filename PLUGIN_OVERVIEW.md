Review a GitHub pull request inside bb the way you would online, with a chat partner that has the code in front of it.

## What you get

- A **PR page**: state, title, author and branches, then Description, Discussion, and Commits, then the changes as file cards with syntax-highlighted diffs, expandable context, viewed marks, and a lines-left counter.
- **GitHub threads inline** on their lines, with reply and resolve. Checks, reviewers, assignees, and labels live in the Info tab.
- **Comments from the diff**: select lines, write Markdown, keep them pending, then submit one review to GitHub as comment, approve, or request changes.
- **Chat with the PR**: an analyst per provider runs in a worktree at the PR head. Ask anything, or select lines and press Ask to bring code into the conversation. Turn an answer into a pending comment or send it to a Roundtable room.
- **Codemap**: symbols added, removed, and modified per file, references between changed symbols, fan-in from the rest of the repository, a reading order by module, and hotspots.

## How it works

The plugin fetches the PR head into a detached worktree on the machine that holds the repository and reads diffs and file contents from git. GitHub data comes from your `gh` login. The chat runs on ordinary bb threads spawned into that worktree, read-only by instruction, rendered with bb's own thread view. The codemap is built with tree-sitter.

## For agents

The bundled skill tells analyst threads how requests arrive and how to answer.
