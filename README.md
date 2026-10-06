# prompt-stash

A stash for the thoughts that cross your mind while Claude Code works: things you want to send in a later turn, at a moment you choose. Stash one with `;;`, see what is waiting above the prompt, and bring it back when the time is right. Claude never reads a stashed thought.

## Install

```
/plugin marketplace add samaphp/prompt-stash
/plugin install prompt-stash@prompt-stash
```

## Use

| You do | What happens |
| --- | --- |
| Type `;;` and a thought, press Enter | The thought is stashed. The `;;` turns blue as you type, and the line above the prompt says that Enter will stash it, so you know before you press. Works while Claude is answering. |
| Type `;;` alone, press Enter | The list opens and takes the keyboard. |
| In the list: a number, or arrows and Enter | That thought goes into the prompt box, and the list closes. A draft already in the box is kept; the thought lands after it. |
| In the list: `c` | Copies the highlighted thought to the clipboard. It stays in the stash. |
| In the list: `d`, then `d` again | Deletes the highlighted thought. The first press asks on the thought itself; the question goes away after four seconds or when you move. `u` brings the last deleted one back while the list is open. |
| Esc | Closes the list. |

The line above the prompt shows the count and the newest thought, and takes no room while the stash is empty:

```
  ● 3  ask whether the cache TTL should be configurable · 4m  +2 more     ;; + enter opens
```

## What to know

- **One stash per conversation.** It comes back when the conversation is resumed, and stays when Claude Code continues the conversation under a new session id (the agent window, a fork). `/clear` starts a new conversation with an empty stash.
- **Stashed text never reaches Claude.** The prompt is dropped before it enters the conversation; Claude Code prints one line saying so. If stashing itself fails, the text goes to Claude as an ordinary prompt and a toast tells you why.
- **Deleted and used thoughts stay on record**, hidden, in the plugin's own store.
- A pasted snippet that starts with `;;` (a Lisp comment, say) is stashed instead of sent; the line above the prompt warns first, and the list brings it back.

## Development

```
claude plugin validate .
claude plugin test .
npx -y -p typescript tsc -p .      # once a session has loaded the mod and laid .claude-plugin/types/
```

Run it in a session without installing: `claude --plugin-dir /path/to/prompt-stash`.

## License

MIT
