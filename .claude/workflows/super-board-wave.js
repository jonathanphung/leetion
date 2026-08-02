export const meta = {
  name: 'super-board-wave',
  description: 'Drain one super-board wave: classify, then build → qa → review per card (lifecycles per run.md)',
  whenToUse: 'Launched by the super-board run-workflow backend with args from super-board-wave-plan.sh. Not for direct ad-hoc use.',
  phases: [
    { title: 'Classify', detail: 'haiku router: kind + complexity per Ready card' },
    { title: 'Build', detail: 'Builder lifecycle (run.md): worktree, branch, draft PR' },
    { title: 'QA', detail: 'Tester lifecycle (run.md): test plan, evidence, screenshots' },
    { title: 'Review', detail: 'Reviewer lifecycle (run.md): gates, rerun tests, merge' },
  ],
}

// args = {
//   configPath: '.claude/super-board/configs/<slug>.json',
//   variant: 'full' | 'qa-only',
//   cards: [{ number, status, title }],     // output of super-board-wave-plan.sh
//   humanApprovesMerge: boolean (optional, default false),
//   tier: 'low' | 'medium' | 'high' (optional, default 'medium'),  // run model ladder
//   repoRoot: '/abs/path/to/repo' (optional),  // anchors lane agents when the
//                                              // orchestrator session cwd is not the repo
// }
// The harness can deliver `args` as a JSON-encoded string (the tool param is
// untyped) — normalize before validating.
const input = (() => {
  if (typeof args !== 'string') return args
  try { return JSON.parse(args) } catch { return args }
})()
if (!input || !Array.isArray(input.cards) || !input.configPath || !input.variant) {
  throw new Error('super-board-wave needs args {configPath, variant, cards:[{number,status,title}]}')
}
if (input.tier && !['low', 'medium', 'high'].includes(input.tier)) {
  throw new Error(`super-board-wave: unknown tier "${input.tier}" — use low | medium | high`)
}

const ROOT = input.repoRoot ? String(input.repoRoot).replace(/\/+$/, '') : null
const rootPreamble = ROOT
  ? `Repo root: ${ROOT} — cd there first; every repo-relative path (.claude/..., .worktrees/, docs/...) resolves against it.\n`
  : ''

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['feature', 'bug', 'docs', 'chore'] },
    complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['kind', 'complexity'],
}

const STAGE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['advanced', 'bounced', 'blocked', 'human-gate', 'failed'] },
    column: { type: 'string' },
    detail: { type: 'string' },
    prUrl: { type: 'string' },
    branch: { type: 'string' },
  },
  required: ['status', 'column', 'detail'],
}

const LANE = {
  build:  { skill: 'super-build',  section: 'Builder',  phase: 'Build' },
  qa:     { skill: 'super-qa',     section: 'Tester',   phase: 'QA' },
  review: { skill: 'super-review', section: 'Reviewer', phase: 'Review' },
}

// Merge-race guard, execution side: on auto-merge boards (humanApprovesMerge
// false) Reviewer agents squash-merge into the same base branch, so Review
// lanes must run one at a time even when card chains reach Review in the
// same wave. Promise-chain mutex; the catch keeps one failed review from
// poisoning the chain.
let reviewLock = Promise.resolve()
const withReviewLock = (fn) => {
  const run = reviewLock.then(fn)
  reviewLock = run.then(() => undefined, () => undefined)
  return run
}

// Bounce-loop cap: each card gets at most MAX_PASSES trips through the lane
// chain per wave. A 'bounced' exit re-enters the chain from the column the
// card landed in instead of ending the wave; past the cap the chain stops and
// the card is left where it bounced for the orchestrator/human to triage.
const MAX_PASSES = 3

const lanePrompt = (lane, card, pass) => rootPreamble + [
  // "for super-board run" is the literal trigger substring the lane skills
  // match to switch from standalone mode to the issue-scoped super-board
  // lifecycle (same phrase the legacy dispatcher uses) — do not reword it.
  `Run ${LANE[lane].skill} on issue #${card.number} ("${card.title}") for super-board run (workflow-wave backend).`,
  `Read .claude/skills/super-board/references/run.md → "${LANE[lane].section}" lifecycle and follow it EXACTLY:`,
  `create your own worktree under .worktrees/, work on the issue branch, post the required PR/issue comments,`,
  `move the project card yourself, clean up the worktree on exit. Config: ${input.configPath}.`,
  ``,
  `Iteration guard: this is pass ${pass} of at most ${MAX_PASSES} this card gets through the lane`,
  `chain this wave. Do not keep looping on revisions: if a further round of changes would not`,
  `meaningfully fix a bug or meaningfully improve performance, stop iterating — settle the work`,
  `as it stands (advance if your lifecycle gates pass, otherwise block with the Block template)`,
  `rather than producing low-impact churn.`,
  ``,
  `Report your exit via structured output:`,
  `- status=advanced  → card moved forward (Building→QA, QA→Review, Review→Done/merged)`,
  `- status=bounced   → card moved backward (QA fail → Ready, Reviewer bounce → Ready/QA)`,
  `- status=blocked or human-gate → you wrote the Block template and moved the card to Blocked`,
  `- status=failed    → you could not complete the lifecycle (say why in detail)`,
  `column = the column the card is in when you exit. detail = one line. Include prUrl/branch when they exist.`,
].join('\n')

// Run-tier model ladders. Card complexity indexes into the active ladder;
// undefined = inherit the session model (the strongest available — e.g.
// Fable/Opus). Cards entering past Ready (cls null, never classified)
// always inherit the session model.
//   low    (run --low):  haiku / sonnet / opus
//   medium (default):    sonnet / opus / session
//   high   (run --high): opus / session / session
const LADDERS = {
  low: { low: 'haiku', medium: 'sonnet', high: 'opus' },
  medium: { low: 'sonnet', medium: 'opus', high: undefined },
  high: { low: 'opus', medium: undefined, high: undefined },
}
const ladder = LADDERS[input.tier || 'medium']
const tierFor = (cls) => (cls ? ladder[cls.complexity] : undefined)
// The classify router writes no code — haiku is fine except on --high runs.
const classifyModel = (input.tier || 'medium') === 'high' ? 'sonnet' : 'haiku'

const runLane = async (lane, card, model, history, pass) => {
  const r = await agent(lanePrompt(lane, card, pass), {
    label: `${lane}:#${card.number}` + (pass > 1 ? `:pass${pass}` : ''),
    phase: LANE[lane].phase,
    schema: STAGE_SCHEMA,
    ...(model ? { model } : {}),
  })
  const result = r || { status: 'failed', column: 'unknown', detail: `${lane} agent returned no result` }
  history.push({ lane, ...result })
  return result
}

const results = await pipeline(
  input.cards,
  // Stage 1: classify cards entering at Ready (router for model tiering)
  async (card) => {
    if (card.status !== 'Ready') return { card, cls: null }
    const cls = await agent(
      rootPreamble +
      `Read GitHub issue #${card.number} ("${card.title}") — body and all comments — using gh issue view. ` +
      `Classify it: kind (feature|bug|docs|chore) and complexity (low|medium|high) judged by the scope of code change required.`,
      { label: `classify:#${card.number}`, phase: 'Classify', model: classifyModel, schema: CLASSIFY_SCHEMA }
    )
    return { card, cls }
  },
  // Stage 2: lane chain — entry point depends on the card's current column.
  // A 'bounced' exit re-enters the chain from where the card landed (Ready or
  // QA), capped at MAX_PASSES passes per card per wave. Any other
  // non-'advanced' exit ends the chain; the next wave re-selects the card
  // from wherever it landed (the board is the loop state, not this script).
  async (prev, card) => {
    const history = []
    const model = tierFor(prev && prev.cls)
    let at = card.status
    const reentry = (column) => (column === 'QA' ? 'QA' : 'Ready')

    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      if (at === 'Ready' && input.variant === 'full') {
        const b = await runLane('build', card, model, history, pass)
        if (b.status === 'bounced') { at = reentry(b.column); continue }
        if (b.status !== 'advanced') return { number: card.number, history }
        at = 'QA'
      }
      // By design: qa-only boards have no Builder lane — Ready cards go
      // straight to the Tester (run.md "Lane mapping by variant").
      if (at === 'Ready' && input.variant === 'qa-only') at = 'QA'
      if (at === 'QA') {
        const q = await runLane('qa', card, model, history, pass)
        if (q.status === 'bounced') { at = reentry(q.column); continue }
        if (q.status !== 'advanced') return { number: card.number, history }
        at = 'Review'
      }
      if (at === 'Review') {
        // Reviewer always on session model; serialized unless a human merges.
        const review = () => runLane('review', card, undefined, history, pass)
        const rv = input.humanApprovesMerge ? await review() : await withReviewLock(review)
        if (rv.status === 'bounced') { at = reentry(rv.column); continue }
        return { number: card.number, history }
      }
      return { number: card.number, history }
    }
    log(`#${card.number}: bounce-loop cap hit (${MAX_PASSES} passes) — leaving card for triage, not relaunching`)
    return { number: card.number, history, loopCapped: true }
  }
)

const summary = results.filter(Boolean).map((r) => {
  const last = r.history[r.history.length - 1] ||
    { lane: 'none', status: 'failed', column: 'unknown', detail: 'no lane ran' }
  return {
    number: r.number,
    finalStatus: last.status,
    lastLane: last.lane,
    column: last.column,
    detail: last.detail,
    prUrl: last.prUrl || null,
    loopCapped: r.loopCapped || false,
    lanesRun: r.history.map((h) => `${h.lane}:${h.status}`).join(' → ') || 'none',
  }
})
log(`wave complete: ${summary.length} cards — ` +
    summary.map((s) => `#${s.number}=${s.finalStatus}@${s.column}${s.loopCapped ? ' (loop-capped)' : ''}`).join(', '))
return { cards: summary }
