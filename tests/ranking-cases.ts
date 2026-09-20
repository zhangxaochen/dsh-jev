/**
 * The labelled ranking cases, shared by the live gates and the baseline probe.
 *
 * `live-pruner.ts` and `live-router.ts` own the assertions; `probe-baseline.ts` runs the
 * same cases against a lexical baseline so "Jev is better than nothing" can be replaced by
 * "Jev is better than X". The cases live here rather than being copied per script: a copy
 * is how a gate quietly stops testing the released code (docs/calibration.md §13).
 *
 * @module dsh-jev/tests/ranking-cases
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolDefinitionMinimal } from '../lib/types.js'

/** The candidate surface both arms rank over. */
export const PRUNER_CANDIDATES: ToolDefinitionMinimal[] = [
  { name: 'search_web', description: 'Search the public web and return result titles, URLs and snippets' },
  { name: 'fetch_url', description: 'Download a web page and return its text content' },
  { name: 'git_commit', description: 'Create a git commit from the staged changes' },
  { name: 'git_push', description: 'Push local commits to the remote branch' },
  { name: 'run_tests', description: 'Run the project test suite and return the output' },
  { name: 'read_file', description: 'Read a file from the workspace' },
  { name: 'edit_file', description: 'Replace text inside a workspace file' },
  { name: 'sql_query', description: 'Run a read-only SQL query against the analytics database' },
  { name: 'pdf_extract', description: 'Extract text and tables from a PDF document' },
  { name: 'send_slack_message', description: 'Post a message to a Slack channel' },
  { name: 'send_email', description: 'Send an email through the configured SMTP server' },
  { name: 'image_generate', description: 'Generate an image from a text prompt' },
  { name: 'deploy_service', description: 'Deploy the current build to the production cluster' },
  { name: 'calendar_create', description: 'Create a calendar event' },
]

export interface PrunerCase {
  id: string
  intent: string
  mustKeep: string[]
  mustDrop: string[]
}

export const PRUNER_CASES: PrunerCase[] = [
  {
    id: 'research-release-notes',
    intent: 'Search the web for the latest TypeSafe release notes and summarize what changed',
    mustKeep: ['search_web'],
    mustDrop: ['send_slack_message', 'image_generate', 'calendar_create'],
  },
  {
    id: 'ship-the-commit',
    intent: 'Commit the staged changes and push them to the remote branch',
    mustKeep: ['git_commit', 'git_push'],
    mustDrop: ['image_generate', 'calendar_create', 'pdf_extract'],
  },
  {
    id: 'fix-failing-test',
    intent: 'Run the test suite, read the failing assertion and fix the code',
    mustKeep: ['run_tests', 'edit_file'],
    mustDrop: ['send_email', 'image_generate', 'deploy_service'],
  },
  {
    id: 'analytics-question',
    intent: "Query the analytics database for yesterday's signup count",
    mustKeep: ['sql_query'],
    mustDrop: ['deploy_service', 'calendar_create', 'image_generate'],
  },
  {
    id: 'invoice-extraction',
    intent: 'Extract the line items and totals from this PDF invoice',
    mustKeep: ['pdf_extract'],
    mustDrop: ['deploy_service', 'git_push', 'image_generate'],
  },
  {
    id: 'notify-the-team',
    intent: 'Tell the team in Slack that the release is done',
    mustKeep: ['send_slack_message'],
    mustDrop: ['image_generate', 'pdf_extract', 'sql_query'],
  },
]

/** The top-K the pruner gate runs with. */
export const PRUNER_MAX_TOOLS = 4

export interface RouterCase {
  id: string
  intent: string
  /** The picked skill's name must match this. */
  expect: RegExp
  /** A measured miss that is documented rather than expected to pass. */
  knownMiss?: boolean
}

export const ROUTER_CASES: RouterCase[] = [
  { id: 'write-a-prd', intent: '把这份用户调研整理成一份 PRD 文档', expect: /prd/i },
  { id: 'split-into-stories', intent: '把这个功能拆成用户故事并写出验收标准', expect: /user-story/i },
  { id: 'competitor-teardown', intent: '给这三个竞品做一份对比分析', expect: /competitive|battle-card|company-intel|market/i },
  { id: 'pricing-change', intent: '评估这次定价调整该不该上线', expect: /pricing/i },
  { id: 'design-a-workflow', intent: '帮我设计一个多 agent 协作的工作流', expect: /agent-orchestration|orchestration/i },
  { id: 'swot', intent: '对这个新产品做一次 SWOT 分析', expect: /swot/i },
  // The request names the artifact in Chinese while the skill is English. It used to be a
  // documented miss (`writing-shape` won); the cause was not the language but that the
  // winner was a user-only skill the model cannot load, so the candidate set now excludes
  // non-model-invocable entries and the case is expected to pass (docs/calibration.md §11.5).
  { id: 'press-release', intent: '为这次发布写一份新闻稿', expect: /press-release/i },
]

function dshNodeModules(): string | undefined {
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
  for (const profile of ['desktop', 'web', 'headless', 'tui', 'acp']) {
    const root = join(dshHome, 'profiles', profile, 'node_modules')
    if (existsSync(join(root, '@deepseek-ai', 'dsh-skill', 'lib', 'index.js'))) return root
  }
  return undefined
}

/**
 * Read the installed skill catalogue, or `undefined` when no DSH runtime is present.
 *
 * Both the router gate and the baseline probe rank over the same real catalogue, so the
 * comparison is between ranking methods rather than between two different candidate sets.
 */
export async function loadSkillCatalog(): Promise<any[] | undefined> {
  const nodeModules = dshNodeModules()
  if (!nodeModules) return undefined
  const { Context } = await import(
    pathToFileURL(join(nodeModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
  )
  const load = (pkg: string) =>
    import(pathToFileURL(join(nodeModules, '@deepseek-ai', pkg, 'lib', 'index.js')).href)
  const SystemPrompt = await load('dsh-system-prompt')
  const Skills = await load('dsh-skill')
  const SkillFs = await load('dsh-skill-filesystem')

  const ctx = new Context()
  ctx.plugin(SystemPrompt.default ?? SystemPrompt)
  ctx.plugin(Skills.default ?? Skills)
  ctx.plugin(SkillFs.default ?? SkillFs)
  await new Promise((resolve) => setTimeout(resolve, 50))
  return ctx.get('skills').list({})
}
