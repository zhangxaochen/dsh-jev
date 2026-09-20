/**
 * Completion probe: how often does a turn claim it is done and the user disagrees?
 *
 * `loop-guard` covers repetition and the deterministic envelope covers single dangerous
 * calls, but neither covers "the agent said it finished and it had not". The plan guessed
 * this was worth a new guard; the incidence was unmeasured, so this probe measures it
 * before any guard is written.
 *
 * There is no local corpus of full transcripts (the session event logs are projections,
 * not messages), so the closest mechanical signal available is: an assistant turn that
 * claims completion, followed by a user turn that says it is not done. That is
 * *user-dissatisfaction after a completion claim*, not proof the claim was false - a user
 * can disagree with a real result. The probe therefore reports both a strict and a lenient
 * correction pattern, keeps every flagged pair in the artifact for manual review, and
 * prints a sample so the classifier's precision can be judged rather than assumed.
 *
 * Run: node --experimental-strip-types tests/probe-completion.ts
 * Writes docs/calibration/probe-<date>-completion.json
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Terminal completion claims, not every use of the word "complete". */
const CLAIM = /(全部|所有|已经|已)完成|已完成|修复完成|全部通过|全绿|目标(已)?达成|无遗留|0 遗留|\bdone\b|\ball (tests )?pass/i
/** Explicit correction of a closed result. */
const STRICT_CORRECTION =
  /还没|还没好|没有(做|改|修|完成)|不[对行]|不是(这样|这个)|错了|漏了|你确定|确定吗|仍有|还是(没|不|有)|重新(做|来|改)|不算(完成|交付|结束)|不能算|没结束|undo|revert|still (not|broken|failing)|not (done|fixed|working)|that'?s wrong/i
/** Lenient: adds "keep going" phrasing, which is often a new task rather than a correction. */
const LENIENT_CORRECTION = new RegExp(
  STRICT_CORRECTION.source +
    '|继续|接着|再(试|来|看|做)|往下|没看到|看不到|再确认|double[- ]check|again|continue|carry on',
  'i'
)

function sessionsRoot(): string {
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
  return join(dshHome, 'storages', 'session_projcache', 'sessions')
}

interface Turn {
  turn: number
  prompt: string
  response: string
  session: string
}

interface Flag {
  session: string
  turn: number
  claim: string
  correction: string
}

function readTurns(root: string): { turns: Turn[]; sessions: number; truncated: number } {
  const turns: Turn[] = []
  let sessions = 0
  let truncated = 0
  for (const name of readdirSync(root)) {
    // `.bak` files are stale copies of the same session.
    if (!name.endsWith('.json')) continue
    let parsed: any
    try {
      parsed = JSON.parse(readFileSync(join(root, name), 'utf8'))
    } catch {
      continue
    }
    const listed = parsed?.record?.rows?.turnOutline?.val?.turns
    if (!Array.isArray(listed) || listed.length === 0) continue
    sessions += 1
    const session = name.replace(/^session-/, '').replace(/\.json$/, '').slice(0, 12)
    for (const entry of listed) {
      const response = String(entry?.response ?? '')
      const prompt = String(entry?.prompt ?? '')
      if (response.endsWith('…') || response.endsWith('...')) truncated += 1
      turns.push({ turn: Number(entry?.turn ?? 0), prompt, response, session })
    }
  }
  return { turns, sessions, truncated }
}

function main(): void {
  const root = sessionsRoot()
  if (!existsSync(root)) {
    console.log('SKIP: no session projection cache at ' + root)
    process.exit(0)
  }

  const { turns, sessions, truncated } = readTurns(root)
  const bySession = new Map<string, Turn[]>()
  for (const turn of turns) {
    const list = bySession.get(turn.session) ?? []
    list.push(turn)
    bySession.set(turn.session, list)
  }

  const claims: Turn[] = []
  const strict: Flag[] = []
  const lenient: Flag[] = []
  let claimsWithFollowUp = 0
  let turnsWithPrompt = 0
  for (const list of bySession.values()) {
    const ordered = [...list].sort((a, b) => a.turn - b.turn)
    ordered.forEach((turn, index) => {
      if (turn.prompt) turnsWithPrompt += 1
      if (!CLAIM.test(turn.response)) return
      claims.push(turn)
      const next = ordered[index + 1]
      if (!next || !next.prompt) return
      claimsWithFollowUp += 1
      if (STRICT_CORRECTION.test(next.prompt)) {
        strict.push({ session: turn.session, turn: turn.turn, claim: turn.response.slice(0, 160), correction: next.prompt.slice(0, 160) })
      }
      if (LENIENT_CORRECTION.test(next.prompt)) {
        lenient.push({ session: turn.session, turn: turn.turn, claim: turn.response.slice(0, 160), correction: next.prompt.slice(0, 160) })
      }
    })
  }

  const report = {
    ranAt: new Date().toISOString(),
    source: root,
    definition:
      'an assistant turn matching the completion-claim pattern, followed by a user turn matching a correction pattern',
    claimPattern: CLAIM.source,
    strictPattern: STRICT_CORRECTION.source,
    lenientPattern: LENIENT_CORRECTION.source,
    sessions,
    turns: turns.length,
    /** Turns that carry a user prompt at all: the correction test needs one. */
    turnsWithPrompt,
    /** Turns whose stored response text is cut off, so a claim may be missed. */
    truncatedResponses: truncated,
    claims: claims.length,
    /** Claims whose next turn is another user turn, so a correction could be observed. */
    claimsWithFollowUp,
    claimsFollowedByStrictCorrection: strict.length,
    claimsFollowedByLenientCorrection: lenient.length,
    strictFlags: strict,
    lenientFlags: lenient.slice(0, 200),
  }

  const outDir = join(process.cwd(), 'docs', 'calibration')
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const outFile = join(outDir, `probe-${stamp}-completion.json`)
  writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8')

  console.log(
    `sessions ${sessions}; turns ${turns.length} (with a user prompt ${turnsWithPrompt}); truncated responses ${truncated}`
  )
  console.log(`completion claims ${claims.length} (with an observable follow-up ${claimsWithFollowUp})`)
  console.log(`  followed by a strict correction ${strict.length}`)
  console.log(`  followed by a lenient correction ${lenient.length}`)
  console.log('\nsample of strict flags (review these by hand):')
  for (const flag of strict.slice(0, 10)) {
    console.log(`- [${flag.session} t${flag.turn}] claim: ${flag.claim.replace(/\s+/g, ' ').slice(0, 100)}`)
    console.log(`  then user: ${flag.correction.replace(/\s+/g, ' ').slice(0, 100)}`)
  }
  console.log('\nwrote ' + outFile)
}

main()
process.exit(0)
