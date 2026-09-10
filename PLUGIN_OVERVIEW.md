Review a GitHub pull request inside bb the way you would online, with an AI that has the code in front of it.

## What you get

- A **Reviews** page: paste a PR URL and get the diff per file with syntax highlighting, unified or split view, expandable context, viewed marks, and a filterable file rail.
- **GitHub threads inline** on their lines, with reply and resolve. The Review tab shows the description, checks, prior reviews, and the conversation.
- **Comments from the diff**: select lines, write Markdown, keep them pending, then submit one review to GitHub as comment, approve, or request changes.
- **Ask AI on a selection**: Explain, Why changed, Risks, Suggest fix, or your own question. Answers anchor to the lines you selected and can become pending comments or go to a Roundtable room.
- **Passes** over the whole PR: summary, risk, performance, slop, test gaps. Each finding names a file and line and carries a severity.
- **Codemap**: symbols added, removed, and modified per file, references between changed symbols, fan-in from the rest of the repository, a reading order by module, and hotspots.

## How it works

The plugin fetches the PR head into a detached worktree on the machine that holds the repository and reads diffs and file contents from git. GitHub data comes from your `gh` login. AI answers come from hidden bb threads spawned into that worktree, read-only by instruction, one per provider per review. The codemap is built with tree-sitter for Rust, Python, TypeScript, JavaScript, Go, C and C++.

## For agents

The bundled skill tells analyst threads how to answer and how to return findings.
