The goal is every required check green on the PR's latest head, with no merge conflict.

- **Conflicts.** When `merge_base` is among your outcomes, a conflict with the base branch is always `merge_base`; never hand it to a person. It is merged without a ping.
- **Use the repository's `pr-monitor` skill** to read check status, to tell why full CI has or has not triggered, and to compare a failure against main.
- **Flakes and infrastructure.** Re-run the failed jobs. A check that only gates an opt-in workflow, or a summary job that fails because of one, goes in `expected`.
- **A failure that main has too.** The PR is not at fault. Find the PR that fixes it (`gh pr list --repo ai-dynamo/dynamo --state all --search "<test or error>"`): merged since the merge base is `merge_base`; open is `blocked` with it in `fixedBy`; none is `blocked` with an empty `fixedBy`.
- **A failure the PR's own code causes.** When `fix` is among your outcomes: the author's agent fixes it on the branch, and its commit is checked before it is pushed.
