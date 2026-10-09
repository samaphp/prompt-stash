import type { On, PromptEditInput, PromptEditResult, SessionUsage, UiFocusInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Thought } from '../types'

const SURFACES = ['terminal', 'desktop'] as const
const SESSION = 'session-one'
// A shelf is saved under its conversation: when it first started, and where.
const STARTED = 500_000
const keyOf = (startedAt: number, root = '/work') => `conversation:${startedAt}:${root}`
const KEY = keyOf(STARTED)
const COMPOSER = { kind: 'composer' } as const
const LIST = 'shelf-list'

const BAND = {
  plugin: 'prompt-stash',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 82,
    scroll: { offset: 0, bodyRows: 11 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'prompt-stash',
  component: 'Pane',
  requestId: LIST,
  props: {
    title: 'Shelf',
    isFocused: true,
    bodyColumns: 83,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const held = (id: string, text: string, more: Partial<Thought> = {}): Thought => ({
  id,
  text,
  caughtAt: 0,
  sessionId: SESSION,
  cwd: '/work',
  scope: 'session',
  status: 'held',
  releasedAt: null,
  releasedVia: null,
  ...more,
})

// The test engine raises `prompt.edit`, `ui.focus` and `session.append` at
// run time, and `mock.session` records rows from the kit shipped with Claude
// Code 2.1.295; the typings a session lays may predate them, so each is
// reached through one cast.
type RecordedRows = { appended: () => readonly { message: { content: readonly { text?: string }[] } }[] }
const recordRows = (on: On) => (mock as unknown as { session: (on: On) => RecordedRows }).session(on)
const edit = ($: Engine, e: Omit<PromptEditInput, 'origin'>) =>
  ($.prompt as unknown as { edit: (e: PromptEditInput) => Promise<PromptEditResult> }).edit({ ...e, origin: COMPOSER })

/** The person moving the highlight onto a thought's row with the arrows. */
const moveTo = ($: Engine, id: string) =>
  ($.ui as unknown as { focus: (e: UiFocusInput) => Promise<unknown> }).focus({
    component: 'Pane',
    requestId: LIST,
    plugin: 'prompt-stash',
    element: `use-${id}`,
    origin: { kind: 'person' },
  })

// Stands for the engine beneath the mod: one session, a clock, the mod's own
// store kept in a Map the test can read, a prompt box that takes edits and
// fills, a clipboard, the panes asked for, and the conversation, which
// records every prompt that entered it.
const world = (on: On, saved: Record<string, unknown> = {}) => {
  // A copy, so one test's writes never reach the fixture another test starts from.
  const store = new Map<string, unknown>(Object.entries(JSON.parse(JSON.stringify(saved)) as Record<string, unknown>))
  const box = { text: '' }
  const session = { id: SESSION, startedAt: STARTED }
  const entered: string[] = []
  const copied: string[] = []
  const panes = { opened: [] as { id: string; focus?: boolean }[], closed: [] as string[] }
  const toasts: string[] = []
  // What the engine refuses, when a test asks it to: saving, placing the list, filling the box, copying.
  const faults = { store: null as string | null, open: null as string | null, fill: null as 'dialog' | null, copy: null as 'no-clipboard' | null }

  const clock = mock.clock(on, { now: 600_000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', (hook$, e) => hook$.ui.resolve(e).Box({}))
  on('ui.focus', () => ({}))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    panes.opened.push({ id: e.id, focus: e.focus })

    return { value: faults.open ? { isPlaced: false, reason: faults.open } : { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    panes.closed.push(e.id)

    return { value: undefined }
  })
  on('ui.copy', (_$, e) => {
    if (faults.copy) {
      return { value: { isCopied: false, reason: faults.copy } }
    }

    copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('session.id', () => ({ value: session.id }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.usage', () => ({ value: { startedAt: session.startedAt, rateLimits: [] } as unknown as SessionUsage }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_$, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    if (faults.store) {
      return { deny: faults.store }
    }

    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', (_$, e) => {
    if (faults.fill) {
      return { isFilled: false, refusal: faults.fill }
    }

    box.text = e.mode === 'append' ? box.text + e.text : e.text

    return { isFilled: true }
  })
  on('prompt.edit', (_$, e) => {
    box.text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)

    return { text: box.text, cursor: e.start + e.inputText.length }
  })
  on('prompt.submit', (_$, e) => {
    entered.push(e.text)

    return { text: e.text }
  })

  return {
    box,
    clock,
    copied,
    entered,
    panes,
    session,
    faults,
    toasts,
    keys: () => [...store.keys()],
    /** A write made by another process of the same conversation. */
    put: (key: string, list: Thought[]) => store.set(key, list),
    saved: (key = KEY) => (store.get(key) ?? []) as Thought[],
  }
}

const THREE = {
  [KEY]: [held('0-0', 'oldest thought'), held('0-1', 'middle thought'), held('0-2', 'newest thought')],
}

for (const surface of SURFACES) {
  const start = async ($: Engine) => {
    await $.session.start({ cwd: '/work', surface, isInteractive: true })

    return $.ui.mount({ ...BAND, surface })
  }
  const submit = ($: Engine, text: string) => $.prompt.submit({ text, origin: COMPOSER, wait: false })

  /** Types the marker alone and Enter, then hands back the list the mod drew. */
  const openList = async ($: Engine) => {
    await submit($, ';;')

    return $.ui.mount({ ...PANE, surface })
  }

  test(`${surface}: the engine's dropped-prompt row is reworded to the mod's own words`, async ($, on) => {
    world(on)
    const session = recordRows(on)
    await start($)
    const rows = [
      'Prompt dropped by a hook: stashed · ;; + enter opens the stash',
      'Prompt dropped by a hook: stash open · esc closes it',
      'Prompt dropped by a hook: the stash could not open here (no room)',
      'Dropped (some other wording): stash open · esc closes it',
      "Prompt dropped by a hook: some other hook's reason",
    ]

    for (const [index, text] of rows.entries()) {
      await ($.session as unknown as { append: (e: unknown) => Promise<unknown> }).append({
        message: { type: 'system', content: [{ type: 'text', text }] },
        door: 'notice',
        origin: { kind: 'composer' },
        uuid: `row-${index}`,
      })
    }

    expect(session.appended().map(row => row.message.content[0]?.text)).toEqual([
      'stashed · ;; + enter opens the stash',
      'stash open · esc closes it',
      'the stash could not open here (no room)',
      'stash open · esc closes it',
      "Prompt dropped by a hook: some other hook's reason",
    ])
  })

  test(`${surface}: an empty shelf draws nothing`, async ($, on) => {
    world(on)
    const band = await start($)

    expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
    expect(await band.findAll({ type: 'Text' })).toHaveLength(0)
  })

  test(`${surface}: a prompt that starts with the marker is shelved and never enters the conversation`, async ($, on) => {
    const { box, clock, entered, panes, saved } = world(on)
    const band = await start($)
    box.text = ';;  ask about the cache TTL '

    const answer = await submit($, ';;  ask about the cache TTL ')
    await clock.settle()
    await band.redraw()

    expect(answer.drop).toBe('stashed · ;; + enter opens the stash')
    expect(box.text).toBe('')
    expect(entered).toHaveLength(0)
    expect(panes.opened).toHaveLength(0)
    expect(saved()).toMatchObject([
      { text: 'ask about the cache TTL', caughtAt: 600_000, sessionId: SESSION, scope: 'session', status: 'held' },
    ])
    expect(await band.find({ type: 'Text', text: /^● 1$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^ask about the cache TTL$/ })).toBeDefined()
  })

  test(`${surface}: the band only shows: it draws no control`, async ($, on) => {
    world(on, THREE)
    const band = await start($)

    expect(await band.find({ type: 'Text', text: /^● 3$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^newest thought$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^\+2 more$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /;; \+ enter opens/ })).toBeDefined()
    expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  })

  test(`${surface}: an ordinary prompt enters untouched`, async ($, on) => {
    const { entered, saved } = world(on)
    await start($)

    const answer = await submit($, 'fix the login bug')

    expect(answer).toMatchObject({ text: 'fix the login bug' })
    expect(entered).toEqual(['fix the login bug'])
    expect(saved()).toHaveLength(0)
  })

  test(`${surface}: a marked prompt the person did not type passes through`, async ($, on) => {
    const { entered, panes, saved } = world(on)
    await start($)

    await $.prompt.submit({ text: ';; from a schedule', origin: { kind: 'scheduled-trigger' }, wait: false })
    await $.prompt.submit({ text: ';;', origin: { kind: 'scheduled-trigger' }, wait: false })

    expect(entered).toEqual([';; from a schedule', ';;'])
    expect(saved()).toHaveLength(0)
    expect(panes.opened).toHaveLength(0)
  })

  test(`${surface}: when saving fails the text reaches Claude and nothing appears on the shelf`, async ($, on) => {
    const { entered, faults, saved, toasts } = world(on)
    const band = await start($)
    faults.store = 'disk full'

    const answer = await submit($, ';; a thought on a full disk')
    await band.redraw()

    expect(answer).toMatchObject({ text: ';; a thought on a full disk' })
    expect(entered).toEqual([';; a thought on a full disk'])
    expect(saved()).toHaveLength(0)
    expect(await band.findAll({ type: 'Text' })).toHaveLength(0)
    expect(toasts.at(-1)).toContain('Stashing failed')
  })

  test(`${surface}: when the list cannot be placed the notice says so and nothing enters`, async ($, on) => {
    const { entered, faults, saved } = world(on, THREE)
    await start($)
    faults.open = 'no room'

    const answer = await submit($, ';;')

    expect(answer.drop).toContain('could not open here (no room)')
    expect(entered).toHaveLength(0)
    expect(saved()).toHaveLength(3)
  })

  test(`${surface}: when the prompt box refuses a thought it stays on the shelf and the list stays open`, async ($, on) => {
    const { box, faults, panes, saved, toasts } = world(on, THREE)
    await start($)
    const list = await openList($)
    faults.fill = 'dialog'

    await list.press({ key: 'use-0-2' })

    expect(box.text).toBe('')
    expect(panes.closed).toHaveLength(0)
    expect(saved().find(one => one.id === '0-2')?.status).toBe('held')
    expect(toasts.at(-1)).toContain('the thought stays in the stash')
  })

  test(`${surface}: when there is no clipboard, copy says so in words and changes nothing`, async ($, on) => {
    const { copied, faults, saved, toasts } = world(on, THREE)
    await start($)
    const list = await openList($)
    faults.copy = 'no-clipboard'

    await list.press({ key: 'copy' })

    expect(copied).toHaveLength(0)
    expect(toasts.at(-1)).toContain('this terminal offers no clipboard')
    expect(saved().every(one => one.status === 'held')).toBe(true)
  })

  test(`${surface}: typing the marker paints it and the band promises what Enter does`, async ($, on) => {
    world(on)
    const band = await start($)
    const type = (text: string, inputText: string) =>
      edit($, { text, cursor: text.length, start: text.length, end: text.length, inputText })

    const marked = await type('', ';;')
    await band.redraw()

    expect(marked.decorations).toMatchObject([{ start: 0, end: 2, color: 'remember' }])
    expect(await band.find({ type: 'Text', text: /type the thought, then enter stashes it/ })).toBeDefined()

    const ready = await type(';;', ' ask later')
    await band.redraw()

    expect(ready.decorations).toMatchObject([{ start: 0, end: 2 }])
    expect(await band.find({ type: 'Text', text: /enter stashes this thought$/ })).toBeDefined()

    const plain = await edit($, { text: ';; ask later', cursor: 2, start: 0, end: 2, inputText: '' })
    await band.redraw()

    expect(plain.decorations).toBeUndefined()
    expect(await band.findAll({ type: 'Text' })).toHaveLength(0)
  })

  test(`${surface}: with thoughts waiting, the marker alone promises to open the shelf`, async ($, on) => {
    world(on, THREE)
    const band = await start($)

    await edit($, { text: '', cursor: 0, start: 0, end: 0, inputText: ';;' })
    await band.redraw()

    expect(await band.find({ type: 'Text', text: /enter opens the stash$/ })).toBeDefined()
  })

  test(`${surface}: the band steps aside while a command or file picker is open`, async ($, on) => {
    world(on, THREE)
    const band = await start($)

    await edit($, { text: '', cursor: 0, start: 0, end: 0, inputText: '/mo' })
    await band.redraw()

    expect(await band.findAll({ type: 'Text' })).toHaveLength(0)

    await edit($, { text: '/mo', cursor: 3, start: 0, end: 3, inputText: '' })
    await band.redraw()

    expect(await band.find({ type: 'Text', text: /^● 3$/ })).toBeDefined()
  })

  test(`${surface}: the marker alone opens the list with the keyboard and enters nothing`, async ($, on) => {
    const { box, clock, entered, panes, saved } = world(on, THREE)
    await start($)
    box.text = ' ;; '

    const answer = await submit($, ' ;; ')
    await clock.settle()
    const list = await $.ui.mount({ ...PANE, surface })

    expect(answer.drop).toBe('stash open · esc closes it')
    expect(box.text).toBe('')
    expect(entered).toHaveLength(0)
    // Asked for at Enter, then again once the box is empty, so it takes the keyboard.
    expect(panes.opened).toEqual([{ id: LIST, focus: true }, { id: LIST, focus: true }])
    expect(saved()).toHaveLength(3)
    expect((await list.find({ key: 'use-0-2' }))?.text).toBe(' newest thought ')
    expect((await list.find({ key: 'use-0-1' }))?.text).toBe(' middle thought ')
    expect((await list.find({ key: 'use-0-0' }))?.text).toBe(' oldest thought ')
    expect((await list.find({ key: 'copy' }))?.text).toBe(' copy ')
    expect((await list.find({ key: 'delete' }))?.text).toBe(' delete ')
    expect(await list.find({ key: 'undo' })).toBeUndefined()
  })

  test(`${surface}: the list on an empty shelf says so`, async ($, on) => {
    world(on)
    await start($)
    const list = await openList($)

    expect(await list.find({ type: 'Text', text: /nothing in the stash/ })).toBeDefined()
    expect(await list.findAll({ type: 'Button' })).toHaveLength(0)
  })

  test(`${surface}: picking a thought puts it in the prompt box, closes the list and keeps it on record`, async ($, on) => {
    const { box, panes, saved } = world(on, THREE)
    await start($)
    const list = await openList($)

    await list.press({ key: 'use-0-1' })

    expect(box.text).toBe('middle thought')
    expect(panes.closed).toEqual([LIST])
    expect(saved().find(one => one.id === '0-1')).toMatchObject({
      status: 'released',
      releasedVia: 'fill',
      releasedAt: 600_000,
    })
  })

  test(`${surface}: a box still holding the bare marker takes the picked thought whole`, async ($, on) => {
    const { box } = world(on, THREE)
    await start($)
    const list = await openList($)
    box.text = ';;'

    await list.press({ key: 'use-0-2' })

    expect(box.text).toBe('newest thought')
  })

  test(`${surface}: a picked thought lands after a draft already in the box`, async ($, on) => {
    const { box } = world(on, THREE)
    await start($)
    const list = await openList($)
    box.text = 'a prompt half typed'

    await list.press({ key: 'use-0-2' })

    expect(box.text).toBe('a prompt half typed\nnewest thought')
  })

  test(`${surface}: copy takes the highlighted thought and leaves it on the shelf`, async ($, on) => {
    const { copied, panes, saved } = world(on, THREE)
    await start($)
    const list = await openList($)

    await list.press({ key: 'copy' })
    await moveTo($, '0-0')
    await list.press({ key: 'copy' })

    expect(copied).toEqual(['newest thought', 'oldest thought'])
    expect(saved().every(one => one.status === 'held')).toBe(true)
    expect(panes.closed).toHaveLength(0)
  })

  test(`${surface}: delete asks on the thought first, and a second press removes it`, async ($, on) => {
    const { saved } = world(on, THREE)
    await start($)
    const list = await openList($)
    await moveTo($, '0-1')

    await list.press({ key: 'delete' })
    await list.redraw()

    expect(await list.find({ type: 'Text', text: /^delete\?$/ })).toBeDefined()
    expect((await list.find({ key: 'delete' }))?.text).toBe(' delete? ')
    expect(saved().every(one => one.status === 'held')).toBe(true)

    await list.press({ key: 'delete' })
    await list.redraw()

    expect(saved().find(one => one.id === '0-1')).toMatchObject({ status: 'discarded', discardedAt: 600_000 })
    expect(await list.find({ key: 'use-0-1' })).toBeUndefined()
    expect(await list.find({ type: 'Text', text: /^delete\?$/ })).toBeUndefined()
    expect((await list.find({ key: 'undo' }))?.text).toBe(' undo delete ')
  })

  test(`${surface}: undo brings a deleted thought back`, async ($, on) => {
    const { saved } = world(on, THREE)
    await start($)
    const list = await openList($)
    await list.press({ key: 'delete' })
    await list.press({ key: 'delete' })
    await list.redraw()

    await list.press({ key: 'undo' })
    await list.redraw()

    const restored = saved().find(one => one.id === '0-2')
    expect(restored).toMatchObject({ status: 'held' })
    expect(restored).not.toHaveProperty('discardedAt')
    expect(await list.find({ key: 'use-0-2' })).toBeDefined()
    expect(await list.find({ key: 'undo' })).toBeUndefined()
  })

  test(`${surface}: the delete question withdraws after a few seconds`, async ($, on) => {
    const { clock, saved } = world(on, THREE)
    await start($)
    const list = await openList($)

    await list.press({ key: 'delete' })
    await clock.advance(4_000)
    await list.redraw()

    expect(await list.find({ type: 'Text', text: /^delete\?$/ })).toBeUndefined()

    await list.press({ key: 'delete' })

    expect(saved().every(one => one.status === 'held')).toBe(true)
  })

  test(`${surface}: a question asked again on the same thought is not withdrawn by the earlier timer`, async ($, on) => {
    const { clock, saved } = world(on, THREE)
    await start($)
    const list = await openList($)

    await list.press({ key: 'delete' })
    await clock.advance(2_000)
    await moveTo($, '0-1')
    await moveTo($, '0-2')
    await list.press({ key: 'delete' })
    await clock.advance(2_500)
    await list.redraw()

    expect(await list.find({ type: 'Text', text: /^delete\?$/ })).toBeDefined()

    await clock.advance(2_000)
    await list.redraw()

    expect(await list.find({ type: 'Text', text: /^delete\?$/ })).toBeUndefined()
    expect(saved().every(one => one.status === 'held')).toBe(true)
  })

  test(`${surface}: moving the highlight withdraws the delete question`, async ($, on) => {
    const { saved } = world(on, THREE)
    await start($)
    const list = await openList($)

    await list.press({ key: 'delete' })
    await moveTo($, '0-0')
    await list.redraw()

    expect(await list.find({ type: 'Text', text: /^delete\?$/ })).toBeUndefined()

    await list.press({ key: 'delete' })

    expect(saved().every(one => one.status === 'held')).toBe(true)
  })

  test(`${surface}: a restarted session shows its held thoughts and hides released and deleted ones`, async ($, on) => {
    world(on, {
      [KEY]: [
        held('0-0', 'sent earlier', { status: 'released' }),
        held('0-1', 'deleted earlier', { status: 'discarded', discardedAt: 1 }),
        held('0-2', 'still waiting'),
      ],
    })
    const band = await start($)
    const list = await openList($)

    expect(await band.find({ type: 'Text', text: /^● 1$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^10m$|· 10m/ })).toBeDefined()
    expect(await list.find({ key: 'use-0-2' })).toBeDefined()
    expect(await list.find({ key: 'use-0-0' })).toBeUndefined()
    expect(await list.find({ key: 'use-0-1' })).toBeUndefined()
  })

  test(`${surface}: a thought used by another process is not offered again`, async ($, on) => {
    const { put, saved } = world(on, THREE)
    const band = await start($)
    put(KEY, saved().map(one => (one.id === '0-2' ? { ...one, status: 'released' as const } : one)))

    const list = await openList($)
    await band.redraw()

    expect(await list.find({ key: 'use-0-2' })).toBeUndefined()
    expect(await list.find({ key: 'use-0-1' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^● 2$/ })).toBeDefined()
  })

  test(`${surface}: a conversation continued under a new session id keeps its shelf`, async ($, on) => {
    const { clock, session, saved } = world(on)
    const band = await start($)
    await submit($, ';; shelved before moving to the agent window')
    await band.redraw()

    session.id = 'session-continued'
    await band.redraw()
    await clock.settle()
    await band.redraw()

    expect(await band.find({ type: 'Text', text: /^shelved before moving to the agent window$/ })).toBeDefined()

    await submit($, ';; shelved after the move')

    expect(saved()).toMatchObject([
      { text: 'shelved before moving to the agent window', sessionId: SESSION },
      { text: 'shelved after the move', sessionId: 'session-continued' },
    ])
  })

  test(`${surface}: after /clear the band shows the new conversation's own shelf`, async ($, on) => {
    const other = held('0-0', 'from the other conversation', { sessionId: 'session-two' })
    const { clock, session, saved } = world(on, { [keyOf(700_000)]: [other] })
    const band = await start($)
    await submit($, ';; from conversation one')
    await band.redraw()

    session.id = 'session-two'
    session.startedAt = 700_000
    await band.redraw()
    await clock.settle()
    await band.redraw()

    expect(await band.find({ type: 'Text', text: /^from the other conversation$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /from conversation one/ })).toBeUndefined()
    expect(saved()).toMatchObject([{ text: 'from conversation one', status: 'held' }])
    expect(saved(keyOf(700_000))).toEqual([other])
  })

  test(`${surface}: a thought typed right after /clear joins the new conversation's shelf`, async ($, on) => {
    const other = held('0-0', 'from the other conversation', { sessionId: 'session-two' })
    const { session, saved } = world(on, { [keyOf(700_000)]: [other] })
    await start($)
    await submit($, 'asked in conversation one')

    session.id = 'session-two'
    session.startedAt = 700_000
    await submit($, ';; typed before the band redrew')

    expect(saved(keyOf(700_000))).toMatchObject([
      { text: 'from the other conversation' },
      { text: 'typed before the band redrew', sessionId: 'session-two' },
    ])
    expect(saved()).toHaveLength(0)
  })

  test(`${surface}: a change starts from what another process of the conversation saved`, async ($, on) => {
    const { put, saved } = world(on, THREE)
    await start($)
    // The other process shelves a thought after this one loaded its list.
    put(KEY, [...saved(), held('9-9', 'shelved by the other process')])

    await submit($, ';; shelved here')

    expect(saved().map(one => one.text)).toEqual([
      'oldest thought',
      'middle thought',
      'newest thought',
      'shelved by the other process',
      'shelved here',
    ])
  })

  test(`${surface}: a narrow band drops the hint and keeps the thought and the count`, async ($, on) => {
    world(on, THREE)
    await $.session.start({ cwd: '/work', surface, isInteractive: true })
    const band = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns: 50 } })

    expect(await band.find({ type: 'Text', text: /enter opens/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /^newest thought$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^\+2 more$/ })).toBeDefined()
  })
}
