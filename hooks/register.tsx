import { atom, read, update } from 'claude-code'
import type { EngineInterface, PaneOpenArgs, Register, UiPressArgument } from 'claude-code'

import type { DraftKind, Thought } from '../types'

const thoughts = atom({ plugin: 'prompt-stash', key: 'thoughts' } as const, [])
const loadedSession = atom({ plugin: 'prompt-stash', key: 'sessionId' } as const, null)
const shelfKey = atom({ plugin: 'prompt-stash', key: 'shelfKey' } as const, null)
const draft = atom({ plugin: 'prompt-stash', key: 'draft' } as const, 'plain')
const picked = atom({ plugin: 'prompt-stash', key: 'picked' } as const, null)
const asking = atom({ plugin: 'prompt-stash', key: 'asking' } as const, null)
const lastDiscarded = atom({ plugin: 'prompt-stash', key: 'lastDiscarded' } as const, null)

// Decided 2026-10-06: a prompt that starts with this marker never reaches
// Claude. With a thought after it, Enter shelves the thought; alone, Enter
// opens the list. `thoughtIn` is the one test behind both the indicator shown
// while typing and the catch at Enter, so what the band promises is what
// Enter does.
const MARKER = ';;'

// The list is a pane that holds the keyboard while open, so its rows answer
// to a bare number and `c`, `d` and `u` stay free for copy, delete and undo.
const LIST = 'shelf-list'
const LIST_PANE: PaneOpenArgs = { id: LIST, title: 'Stash', focus: true, closeOnEscape: true }
const ROW_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
const ROW_PREFIX = 'use-'

// How long "delete?" waits for its second press before it withdraws itself.
const ASK_MS = 4_000

const TAG = '●'
const HINT = `${MARKER} + enter opens`

// The engine prints one transcript row for every prompt a hook drops, as
// "Prompt dropped by a hook: <reason>". These reasons are this mod's own
// words, and the row is rewritten to just them, so it reads as what
// happened and never as an error. The match is on the words at the row's
// end, so a change in the engine's wording before them still finds them.
const NOTICE = {
  stashed: `stashed · ${HINT} the stash`,
  opened: 'stash open · esc closes it',
  unopened: 'the stash could not open here',
}

// Decided 2026-10-06, after the shelf emptied when its conversation moved to
// the agent window: a shelf belongs to a conversation. Claude Code gives a
// conversation a new session id when it is continued elsewhere (the agent
// window, a fork) and keeps reporting the time the conversation first
// started; /clear starts a new time. That time, with the project folder, is
// the shelf's key: thoughts follow the conversation, and a cleared one starts
// with an empty shelf.
const conversationKey = (root: string, startedAt: number) => `conversation:${startedAt}:${root}`


const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const clip = (text: string, width: number) => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length <= width ? line : `${line.slice(0, Math.max(1, width - 1))}…`
}

// A thought under a minute old shows no age: "now" after its text reads as
// part of the sentence ("ask about the cache now").
const age = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)

  if (minutes < 1) {
    return null
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** The thoughts waiting on the shelf, newest first. */
const heldOf = (list: Thought[]) => list.filter(one => one.status === 'held').reverse()

/** The thought in a marked draft, `''` for the marker alone, null for an ordinary draft. */
const thoughtIn = (text: string): string | null => {
  const body = text.trimStart()

  return body.startsWith(MARKER) ? body.slice(MARKER.length).trim() : null
}

const kindOf = (text: string, cursor: number): DraftKind => {
  const thought = thoughtIn(text)

  if (thought !== null) {
    return thought === '' ? 'marker' : 'thought'
  }

  // The engine draws its `/` command and `@` file pickers above the band, so
  // the band steps aside while one is open and the picker sits on the prompt.
  // Pattern taken from hoobnn-agent-mods' band kit (MIT).
  const before = text.slice(0, cursor)

  return /^\/\S*$/.test(before) || /(^|\s)@\S*$/.test(before) ? 'picker' : 'plain'
}

const setDraft = async ($: EngineInterface, kind: DraftKind) => {
  if ((await read($, draft)) !== kind) {
    await update($, draft, () => kind)
  }
}

// The conversation's list in $.state is what the band and the list draw from.
// A change is applied to the list saved in $.store: a continued conversation
// can have two processes for a while, and each change then starts from what
// the other one saved. Released and deleted thoughts stay on record there.
const commit = async ($: EngineInterface, key: string, change: (list: Thought[]) => Thought[]) => {
  const saved = await $.store.get(key)
  const list = change(Array.isArray(saved) ? (saved as Thought[]) : [])

  await $.store.set(key, list)
  await update($, thoughts, () => list)
}

// Puts the current conversation's saved shelf into $.state: at process start,
// and when the session id under the process changes (/clear, /resume, a
// continuation elsewhere).
const load = async ($: EngineInterface) => {
  const sessionId = await $.session.id()
  const key = conversationKey(await $.session.root(), (await $.session.usage()).startedAt)
  const saved = await $.store.get(key)
  const list = Array.isArray(saved) ? (saved as Thought[]) : []

  await update($, thoughts, () => list)
  await update($, shelfKey, () => key)
  await update($, loadedSession, () => sessionId)

  return { key, list }
}

/** The current conversation's stash, from the saved record; loaded first when the session id just changed. */
const current = async ($: EngineInterface) => {
  const key = await read($, shelfKey)

  if (key === null || (await read($, loadedSession)) !== (await $.session.id())) {
    return { isSwitched: true, ...(await load($)) }
  }

  // Read afresh: another process of the same conversation may have used or
  // deleted thoughts since this one last drew them.
  const saved = await $.store.get(key)
  const list = Array.isArray(saved) ? (saved as Thought[]) : []

  await update($, thoughts, () => list)

  return { isSwitched: false, key, list }
}

const shelve = async ($: EngineInterface, text: string) => {
  const { key } = await current($)
  const sessionId = await $.session.id()
  const caughtAt = await $.clock.now()
  const cwd = await $.session.cwd()

  await commit($, key, list => [
    ...list,
    {
      id: `${caughtAt}-${list.length}-${sessionId.slice(0, 8)}`,
      text,
      caughtAt,
      sessionId,
      cwd,
      scope: 'session',
      status: 'held',
      releasedAt: null,
      releasedVia: null,
    },
  ])
}

/** Puts a thought in the prompt box and takes it off the shelf; false when the box refused it. */
const releaseIntoBox = async ($: EngineInterface, id: string) => {
  const { key, list: all } = await current($)
  const thought = all.find(one => one.id === id && one.status === 'held')

  if (!thought) {
    $.ui.toast('That thought already left the stash.')

    return false
  }

  // A draft already in the box is kept; the thought lands on a new line after it.
  const box = await $.prompt.read()
  const filled =
    thoughtIn(box.text) === '' || box.text.trim() === ''
      ? await $.prompt.fill({ text: thought.text, mode: 'replace' })
      : await $.prompt.fill({ text: `\n${thought.text}`, mode: 'append' })

  if (!filled.isFilled) {
    $.ui.toast(`Not placed (${filled.refusal ?? 'another mod kept it out'}) · the thought stays in the stash.`)

    return false
  }

  const releasedAt = await $.clock.now()

  await commit($, key, list =>
    list.map((one): Thought =>
      one.id === id ? { ...one, status: 'released', releasedAt, releasedVia: 'fill' } : one,
    ),
  )

  return true
}

// From Claude Code 2.1.295 a dropped prompt's text comes back into the box
// after the hook answered, and a pane asked for while the box holds text is
// placed without the keyboard. Once Enter has been answered this empties the
// box and, when a pane is named, asks for it again so it takes the keyboard.
// A no-op on versions that emptied the box themselves.
const clearBox = ($: EngineInterface, reopen?: PaneOpenArgs) => {
  $.clock.after(0, async () => {
    try {
      await $.prompt.fill({ text: '', mode: 'replace' })

      if (reopen) {
        await $.ui.open(reopen)
      }
    } catch (error) {
      $.ui.log(`the box was not emptied: ${reasonOf(error)}`, { to: 'debug' })
    }
  })
}

/** The text of a transcript row's text blocks, joined. */
const textOf = (content: readonly { type: string; text?: string }[]) =>
  content.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('')

// After `c`, `d` or `u` the highlight goes back to the thought it was on, so
// the arrows continue from there.
const highlight = async ($: EngineInterface, id: string | null) => {
  if (id === null) {
    return
  }

  try {
    await $.ui.focus({ requestId: LIST, key: `${ROW_PREFIX}${id}` })
  } catch (error) {
    $.ui.log(`the highlight was not moved: ${reasonOf(error)}`, { to: 'debug' })
  }
}

const pickedThought = async ($: EngineInterface, all: Thought[]) => {
  const id = await read($, picked)
  const thought = heldOf(all).find(one => one.id === id)

  if (!thought) {
    $.ui.toast('Move to a thought with the arrows first.')
  }

  return thought
}

const useThought = async ($: EngineInterface, id: string) => {
  if (await releaseIntoBox($, id)) {
    await $.ui.close({ id: LIST })
  }
}

const COPY_REFUSALS: Record<string, string> = {
  'no-clipboard': 'this terminal offers no clipboard',
  'no-surface': 'nothing is drawing this session',
}

// Copying leaves the thought on the shelf: it may be wanted here as well as
// wherever it is pasted. Delete is the way off.
const copyPicked = async ($: EngineInterface, press: UiPressArgument) => {
  const thought = await pickedThought($, (await current($)).list)

  if (!thought) {
    return
  }

  const copied = await $.ui.copy({ text: thought.text, surface: press.surface })

  $.ui.toast(
    copied.isCopied
      ? `Copied "${clip(thought.text, 30)}" · it stays in the stash`
      : `Not copied: ${COPY_REFUSALS[copied.reason] ?? copied.reason}.`,
  )
  await highlight($, thought.id)
}

// Delete asks first, on the thought itself: the first press shows "delete?"
// on its row, a second press confirms, and the question withdraws after a few
// seconds or when the highlight moves to another thought.
const deletePicked = async ($: EngineInterface) => {
  const { key, list: before } = await current($)
  const thought = await pickedThought($, before)

  if (!thought) {
    return
  }

  if ((await read($, asking))?.id !== thought.id) {
    const question = { id: thought.id, at: await $.clock.now() }

    await update($, asking, () => question)
    // Only the timer of this very question withdraws it: a question asked
    // again on the same thought has its own.
    $.clock.after(ASK_MS, async () => {
      try {
        const asked = await read($, asking)

        if (asked?.id === question.id && asked.at === question.at) {
          await update($, asking, () => null)
        }
      } catch (error) {
        $.ui.log(`the delete question was not withdrawn: ${reasonOf(error)}`, { to: 'debug' })
      }
    })
    await highlight($, thought.id)

    return
  }

  const list = heldOf(before)
  const index = list.findIndex(one => one.id === thought.id)
  const neighbour = list[index + 1] ?? list[index - 1] ?? null
  const discardedAt = await $.clock.now()

  await commit($, key, all =>
    all.map((one): Thought => (one.id === thought.id ? { ...one, status: 'discarded', discardedAt } : one)),
  )
  await update($, asking, () => null)
  await update($, lastDiscarded, () => thought.id)
  await update($, picked, () => neighbour?.id ?? null)
  $.ui.toast(`Deleted "${clip(thought.text, 30)}" · u brings it back`)
  await highlight($, neighbour?.id ?? null)
}

const undoDelete = async ($: EngineInterface) => {
  const id = await read($, lastDiscarded)
  const { key, list: before } = await current($)
  const thought = before.find(one => one.id === id && one.status === 'discarded')

  if (!thought) {
    return
  }

  await commit($, key, all =>
    all.map((one): Thought => {
      if (one.id !== thought.id) {
        return one
      }

      const { discardedAt: _deletedAt, ...kept } = one

      return { ...kept, status: 'held' }
    }),
  )
  await update($, lastDiscarded, () => null)
  await update($, picked, () => thought.id)
  $.ui.toast(`Brought back "${clip(thought.text, 40)}".`)
  await highlight($, thought.id)
}

// A press that fails says why where the person pressed, and the same line
// goes to the log. The engine leads every toast and log line with the mod's name.
const guard =
  ($: EngineInterface, action: string, run: (press: UiPressArgument) => Promise<unknown>) =>
  async (press: UiPressArgument) => {
    try {
      await run(press)
    } catch (error) {
      const line = `${action} failed: ${reasonOf(error)}`
      $.ui.log(line)
      $.ui.toast(line)
    }
  }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      // $.state outlives a hot reload, which raises session.start again: the
      // shelf is loaded only when it is not this conversation's already.
      await current($)
    } catch (error) {
      $.ui.log(`the saved stash was not loaded: ${reasonOf(error)}`)
    }

    return next(e)
  })

  // Tells the band what the prompt box holds, and paints the marker in the
  // box itself the moment it is recognised.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)

    try {
      const kind = kindOf(box.text, box.cursor)
      await setDraft($, kind)

      if (kind === 'marker' || kind === 'thought') {
        const start = box.text.indexOf(MARKER)

        return {
          ...box,
          decorations: [
            ...(box.decorations ?? []),
            { start, end: start + MARKER.length, color: 'remember', bold: true },
          ],
        }
      }
    } catch (error) {
      $.ui.log(`the draft was not read: ${reasonOf(error)}`)
    }

    return box
  })

  on('prompt.submit', async ($, e, next) => {
    // Only what the person typed is a capture; a prompt from a schedule, a
    // peer session or another mod passes through whatever it starts with.
    const thought = e.origin.kind === 'composer' ? thoughtIn(e.text) : null

    if (thought === null) {
      const entered = await next(e)

      if (entered.drop === undefined && e.origin.kind === 'composer') {
        try {
          // The box is empty once the prompt entered.
          await setDraft($, 'plain')
        } catch (error) {
          $.ui.log(`the draft kind was not reset: ${reasonOf(error)}`)
        }
      }

      return entered
    }

    if (thought === '') {
      // Asked for before any await, while Enter is still being answered: the
      // engine then seats the list at any width and hands it the keyboard.
      const opening = $.ui.open(LIST_PANE)

      try {
        await setDraft($, 'plain')
        // The list opens with its newest thought highlighted and no question
        // or undo left over from the last time it was open.
        const [newest] = heldOf((await current($)).list)
        await update($, picked, () => newest?.id ?? null)
        await update($, asking, () => null)
        await update($, lastDiscarded, () => null)
      } catch (error) {
        $.ui.log(`the list was not prepared: ${reasonOf(error)}`)
      }

      // The notice is worded once the list's fate is known. The box is emptied
      // only then: a timer set earlier fires during this wait, before the
      // engine puts the dropped text back.
      try {
        const opened = await opening

        clearBox($, opened.isPlaced ? LIST_PANE : undefined)

        return {
          drop: opened.isPlaced ? NOTICE.opened : `${NOTICE.unopened} (${opened.reason})`,
        }
      } catch (error) {
        $.ui.log(`the list did not open: ${reasonOf(error)}`)
        clearBox($)

        return { drop: `${NOTICE.unopened} (${reasonOf(error)})` }
      }
    }

    try {
      await setDraft($, 'plain')
      await shelve($, thought)
      clearBox($)

      // The engine shows this after its own "Prompt dropped by a hook:". The
      // thought's text stays out of it, so the notice says nothing of what was shelved.
      return { drop: NOTICE.stashed }
    } catch (error) {
      // Decided 2026-10-06: when the shelf fails, the prompt reaches Claude as
      // it would without the mod, and the person is told why.
      const line = `Stashing failed, so the text went to Claude: ${reasonOf(error)}`
      $.ui.log(line)
      $.ui.toast(line)

      return next(e)
    }
  })

  // Follows the highlight as the arrows move it over the list, so `c` and
  // `d` know which thought they act on.
  on('ui.focus', async ($, e, next) => {
    const moved = await next(e)

    if (e.requestId === LIST && e.element?.startsWith(ROW_PREFIX)) {
      try {
        const id = e.element.slice(ROW_PREFIX.length)

        if ((await read($, picked)) !== id) {
          await update($, picked, () => id)
        }

        // The question belongs to the thought it was asked on.
        const asked = await read($, asking)

        if (asked !== null && asked.id !== id) {
          await update($, asking, () => null)
        }
      } catch (error) {
        $.ui.log(`the highlight was not followed: ${reasonOf(error)}`, { to: 'debug' })
      }
    }

    return moved
  })

  on('session.append', { door: 'notice' }, async ($, e, next) => {
    const text = textOf(e.message.content)
    const start = [NOTICE.stashed, NOTICE.opened, NOTICE.unopened]
      .map(words => text.indexOf(words))
      .find(at => at > 0)

    if (start !== undefined) {
      return next({ ...e, message: { ...e.message, content: [{ type: 'text', text: text.slice(start) }] } })
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: LIST }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const list = heldOf(await read($, thoughts))
    const asked = (await read($, asking))?.id ?? null
    const undoId = await read($, lastDiscarded)
    const now = await $.clock.now()

    // The person asked to look here, so an empty shelf says so in words.
    if (list.length === 0 && undoId === null) {
      return <Text dimColor>{`nothing in the stash · type ${MARKER} and a thought, then enter`}</Text>
    }

    // "1: " 3 · padded label 2 · gap 1 · age or "delete?" 7
    const textRoom = Math.max(12, columns - 13)
    const textWidth = Math.min(textRoom, Math.max(0, ...list.map(one => clip(one.text, textRoom).length)))

    return (
      <Box flexDirection="column">
        {list.map((one, index) => {
          const hotkey = ROW_KEYS[index]

          return (
            <Box>
              <Box width={textWidth + 6} flexShrink={0}>
                <Button
                  key={`${ROW_PREFIX}${one.id}`}
                  {...(hotkey ? { hotkey } : {})}
                  {...(index === 0 ? { autoFocus: true } : {})}
                  plain
                  label={` ${clip(one.text, textWidth)} `}
                  onPress={guard($, 'bringing the thought back', () => useThought($, one.id))}
                />
              </Box>
              {one.id === asked ? (
                <Text color="error" bold>
                  delete?
                </Text>
              ) : (
                <Text dimColor>{age(now - one.caughtAt) ?? ''}</Text>
              )}
            </Box>
          )
        })}
        <Box>
          {list.length > 0 ? (
            <Button
              key="copy"
              hotkey="c"
              plain
              label=" copy "
              onPress={guard($, 'copying the thought', press => copyPicked($, press))}
            />
          ) : null}
          {list.length > 0 ? (
            <Button
              key="delete"
              hotkey="d"
              plain
              label={asked === null ? ' delete ' : ' delete? '}
              onPress={guard($, 'deleting the thought', () => deletePicked($))}
            />
          ) : null}
          {undoId !== null ? (
            <Button
              key="undo"
              hotkey="u"
              plain
              label=" undo delete "
              onPress={guard($, 'bringing the thought back', () => undoDelete($))}
            />
          ) : null}
          <Text dimColor>{list.length > 0 ? ' number or enter: use · esc: close' : ' esc: close'}</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    // /clear and /resume change the session without raising session.start,
    // and a render may not write state: the reload runs right after this draw.
    if ((await read($, shelfKey)) === null || (await read($, loadedSession)) !== (await $.session.id())) {
      $.clock.after(0, async () => {
        try {
          await load($)
        } catch (error) {
          $.ui.log(`the saved stash was not loaded: ${reasonOf(error)}`)
        }
      })

      return next(e)
    }

    const kind = await read($, draft)
    const held = heldOf(await read($, thoughts))
    const [newest] = held

    // Nothing held and nothing being shelved: the band takes no row at all.
    if (kind === 'picker' || (!newest && kind === 'plain')) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    // Two cells in, where the engine starts the lines under the prompt.
    const columns = e.props.bodyColumns - 2
    let row

    if (kind === 'thought') {
      // While a marked draft is in the box, the row is the promise of what
      // Enter will do with it.
      row = (
        <Box gap={1}>
          <Text color="remember" bold>{`${TAG} enter stashes this thought`}</Text>
          <Text dimColor>· kept until you bring it back</Text>
        </Box>
      )
    } else if (kind === 'marker') {
      row = (
        <Box gap={1}>
          <Text color="remember" bold>
            {newest ? `${TAG} enter opens the stash` : `${TAG} type the thought, then enter stashes it`}
          </Text>
          {newest ? <Text dimColor>· or type a thought to stash it</Text> : null}
        </Box>
      )
    } else if (newest) {
      // Decided 2026-10-06: this row only shows; the list opened by the marker
      // and Enter is where a thought is used, copied or deleted.
      const aged = age((await $.clock.now()) - newest.caughtAt)
      const more = held.length > 1 ? `+${held.length - 1} more` : null
      const hint = columns >= 60 ? HINT : null
      // tag "● 99" 4 · gaps 6 · " · 12m" 6 · "+9 more" 7 · hint and its gap
      const room = Math.max(12, columns - 16 - (more ? 9 : 0) - (hint ? hint.length + 2 : 0))

      row = (
        <Box width={columns} justifyContent="space-between">
          <Box gap={2}>
            <Text color="remember" bold>{`${TAG} ${held.length}`}</Text>
            <Box gap={1}>
              <Text>{clip(newest.text, room)}</Text>
              {aged ? <Text dimColor>{`· ${aged}`}</Text> : null}
            </Box>
            {more ? <Text dimColor>{more}</Text> : null}
          </Box>
          {hint ? <Text dimColor>{hint}</Text> : null}
        </Box>
      )
    }

    // Other mods draw in this band too: this row stacks over whatever the
    // rest of the chain drew instead of replacing it.
    return (
      <Box flexDirection="column">
        <Box paddingLeft={2}>{row}</Box>
        {await next(e)}
      </Box>
    )
  })
}
