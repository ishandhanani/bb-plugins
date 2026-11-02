Give every new thread a 3-4 word title instead of bb's 6-8 word default.

## What you get

- Short sidebar titles such as "Fix flaky login test" or "DP attention KV sharing", set a few seconds after a thread's first turn starts.
- No setup beyond a logged-in `claude` CLI. No settings, no UI.

## How it works

On a new top-level thread's first turn, the plugin reads the first prompt and asks Sonnet through `claude -p` for a 3-4 word title. If the reply is longer than 4 words it asks once to shorten it, then sets the title. bb's own title generator still names the branch.
