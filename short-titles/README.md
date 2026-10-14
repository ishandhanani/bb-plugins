# bb-plugin-short-titles

A bb plugin that gives each new top-level thread a 3-4 word title.

- bb's built-in title prompt asks for "under about 40 characters" and cuts at 48 characters on a word boundary, so titles run 6-8 words and sometimes end mid-phrase. Neither is configurable.
- On a thread's first turn, the plugin reads the first prompt, asks `claude -p --model sonnet` for a 3-4 word title, retries once to shorten if the reply is longer, and sets it with `bb.sdk.threads.update`.
- bb's own generator still runs and names the branch. The short title replaces bb's title a few seconds after the first turn starts.
- Skipped: child threads, plugin- or automation-spawned threads, prompts under 5 words, and threads whose first turn starts more than 10 minutes after creation.
- Requires `claude` on the bb server's PATH, logged in.

## Why not an AI service

`bb.experimental_aiServices` would set the title before the thread appears, but bb aborts a title service after 5 seconds and then falls back to the raw prompt clipped to 80 characters. `claude -p` takes 2-4 seconds, so a slow call would make titles worse. Renaming from a `thread.active` handler has no deadline.

## Layout

- `server.ts`: the `thread.active` handler, first-prompt lookup, and the `claude -p` call with one shorten retry.

## Develop

```
npm install
bb plugin install .      # register this directory in place
npx tsc -p .             # type-check
bb plugin logs short-titles
```

Turn it off with `bb plugin disable short-titles`.
