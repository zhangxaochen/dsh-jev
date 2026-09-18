/**
 * Metrics tracking and telemetry for TypeSafe AI (dsh-jev).
 * Records tool pruning token savings, loop guard interruptions, safety screenings, and latency.
 * @module dsh-jev/metrics
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface JevMetricsData {
  version: 1
  firstRecordedAt: string
  lastUpdatedAt: string
  toolPruner: {
    evaluations: number
    toolsPruned: number
    toolsRetained: number
    estimatedTokensSaved: number
  }
  loopGuard: {
    checks: number
    interrupted: number
    warned: number
    estimatedTokensSaved: number
  }
  safetyGuard: {
    screened: number
    blocked: number
    approvals: number
  }
  systemOne: {
    totalCalls: number
    totalLatencyMs: number
    avgLatencyMs: number
    errors: number
    /** Billed input bytes sent to System One (cache hits cost nothing). */
    inputBytes: number
    /** Estimated USD cost at $0.042 per million input tokens; output is free. */
    estimatedCostUsd: number
    /** Decisions served from the identical-payload cache. */
    cacheHits: number
    /** Decisions whose answer came back unusable (missing or malformed). */
    decisionErrors: number
  }
}

/** Accounting facts attached to one System One call. */
export interface CallAccounting {
  inputBytes?: number
  estimatedCostUsd?: number
  latencyMs?: number
  cacheHit?: boolean
  decisionError?: boolean
}

/** Estimated tokens per pruned MCP/system tool schema */
export const TOKENS_PER_PRUNED_TOOL = 150
/** Estimated tokens saved per early-stopped runaway loop (averages 3-5 wasted cycles) */
export const TOKENS_PER_INTERRUPTED_LOOP = 15000

function createEmptyMetrics(): JevMetricsData {
  const now = new Date().toISOString()
  return {
    version: 1,
    firstRecordedAt: now,
    lastUpdatedAt: now,
    toolPruner: {
      evaluations: 0,
      toolsPruned: 0,
      toolsRetained: 0,
      estimatedTokensSaved: 0,
    },
    loopGuard: {
      checks: 0,
      interrupted: 0,
      warned: 0,
      estimatedTokensSaved: 0,
    },
    safetyGuard: {
      screened: 0,
      blocked: 0,
      approvals: 0,
    },
    systemOne: {
      totalCalls: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
      errors: 0,
      inputBytes: 0,
      estimatedCostUsd: 0,
      cacheHits: 0,
      decisionErrors: 0,
    },
  }
}

export class MetricsCollector {
  private data: JevMetricsData
  private readonly storagePath: string

  constructor(customPath?: string) {
    this.storagePath = customPath ?? join(homedir(), '.dsh', 'jev-stats.json')
    this.data = this.loadInitial()
  }

  private loadInitial(): JevMetricsData {
    try {
      if (existsSync(this.storagePath)) {
        const raw = readFileSync(this.storagePath, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed && parsed.version === 1) {
          return parsed as JevMetricsData
        }
      }
    } catch {
      // Fallback to empty on corrupt or unreadable file
    }
    return createEmptyMetrics()
  }

  private persist(): void {
    try {
      this.data.lastUpdatedAt = new Date().toISOString()
      mkdirSync(dirname(this.storagePath), { recursive: true })
      writeFileSync(this.storagePath, JSON.stringify(this.data, null, 2), 'utf8')
    } catch {
      // Ignore background file persistence errors in read-only environments
    }
  }

  /**
   * Record a tool pruning evaluation.
   * @param candidatesCount Total candidate tools evaluated
   * @param retainedCount Tools retained after pruning
   * @param exactTokensSaved Optional exact token count based on pruned schema sizes
   */
  recordPrune(candidatesCount: number, retainedCount: number, exactTokensSaved?: number): void {
    const pruned = Math.max(0, candidatesCount - retainedCount)
    this.data.toolPruner.evaluations += 1
    this.data.toolPruner.toolsPruned += pruned
    this.data.toolPruner.toolsRetained += retainedCount
    const tokens = typeof exactTokensSaved === 'number' && exactTokensSaved >= 0
      ? exactTokensSaved
      : pruned * TOKENS_PER_PRUNED_TOOL
    this.data.toolPruner.estimatedTokensSaved += tokens
    this.persist()
  }

  /**
   * Record a loop guard check outcome.
   */
  recordLoopCheck(outcome: 'normal' | 'warn' | 'interrupt'): void {
    this.data.loopGuard.checks += 1
    if (outcome === 'warn') {
      this.data.loopGuard.warned += 1
    } else if (outcome === 'interrupt') {
      this.data.loopGuard.interrupted += 1
      this.data.loopGuard.estimatedTokensSaved += TOKENS_PER_INTERRUPTED_LOOP
    }
    this.persist()
  }

  /**
   * Record a safety guard pre-execution screen.
   */
  recordSafetyCheck(outcome: 'pass' | 'ask' | 'deny'): void {
    this.data.safetyGuard.screened += 1
    if (outcome === 'ask') {
      this.data.safetyGuard.approvals += 1
    } else if (outcome === 'deny') {
      this.data.safetyGuard.blocked += 1
    }
    this.persist()
  }

  /**
   * Record a System One API call latency.
   */
  recordCall(latencyMs: number, success = true, accounting: CallAccounting = {}): void {
    this.data.systemOne.totalCalls += 1
    this.data.systemOne.inputBytes += accounting.inputBytes ?? 0
    this.data.systemOne.estimatedCostUsd += accounting.estimatedCostUsd ?? 0
    if (accounting.cacheHit) this.data.systemOne.cacheHits += 1
    if (accounting.decisionError) this.data.systemOne.decisionErrors += 1
    if (success) {
      this.data.systemOne.totalLatencyMs += latencyMs
      this.data.systemOne.avgLatencyMs = Math.round(
        this.data.systemOne.totalLatencyMs / Math.max(1, this.data.systemOne.totalCalls - this.data.systemOne.errors)
      )
    } else {
      this.data.systemOne.errors += 1
    }
    this.persist()
  }

  /** Record a decision whose answer was unusable (missing or malformed). */
  recordDecisionError(): void {
    this.data.systemOne.decisionErrors += 1
    this.persist()
  }

  /**
   * Return an immutable snapshot of current metrics.
   */
  getSnapshot(): JevMetricsData {
    return JSON.parse(JSON.stringify(this.data))
  }

  /**
   * Total tokens saved across all modules.
   */
  getTotalTokensSaved(): number {
    return (
      this.data.toolPruner.estimatedTokensSaved +
      this.data.loopGuard.estimatedTokensSaved
    )
  }

  /**
   * Render a human-friendly Markdown dashboard card.
   */
  renderMarkdownDashboard(): string {
    const totalTokens = this.getTotalTokensSaved()
    const formattedTokens = totalTokens >= 1_000_000
      ? `${(totalTokens / 1_000_000).toFixed(2)}M`
      : totalTokens >= 1_000
        ? `${(totalTokens / 1_000).toFixed(1)}K`
        : String(totalTokens)

    return [
      `### 🛡️ TypeSafe Jev 守护与收益看板`,
      ``,
      `| 守护维度 | 核心拦截/优化战果 | 预估 Token / 成本收益 |`,
      `| :--- | :--- | :--- |`,
      `| **🛠️ 工具动态剪枝** | 评估 **${this.data.toolPruner.evaluations}** 次，裁剪 **${this.data.toolPruner.toolsPruned}** 个次无关工具 | 净省约 **${(this.data.toolPruner.estimatedTokensSaved / 1000).toFixed(1)}K** Tokens (Prompt Schema 压缩) |`,
      `| **🔄 死循环及早止损** | 检查 **${this.data.loopGuard.checks}** 次，阻断 **${this.data.loopGuard.interrupted}** 次死循环，警示 **${this.data.loopGuard.warned}** 次 | 止损节省约 **${(this.data.loopGuard.estimatedTokensSaved / 1000).toFixed(1)}K** Tokens (避免无效空转) |`,
      `| **🔒 执行安全护栏** | 审查 **${this.data.safetyGuard.screened}** 次敏感指令，阻断 **${this.data.safetyGuard.blocked}** 次高危操作 | 拦截敏感破坏性命令 / 降级审批 **${this.data.safetyGuard.approvals}** 次 |`,
      `| **⚡ System One 响应** | 累计决策 **${this.data.systemOne.totalCalls}** 次，平均延迟 **${this.data.systemOne.avgLatencyMs}ms** | 毫秒级快速裁决，保障会话低延迟零卡顿 |`,
      ``,
      `> 💡 **累计总收益**：累计预估为当前工作区节省 **~${formattedTokens}** 运行 Token 开销（*工具剪枝根据 Schema 体积精确换算，死循环按避免空转经验均值估算*）。`,
      `> ⏱️ 统计起始自：\`${this.data.firstRecordedAt.replace('T', ' ').slice(0, 19)}\`（最新更新：\`${this.data.lastUpdatedAt.replace('T', ' ').slice(0, 19)}\`）`,
    ].join('\n')
  }

  /**
   * Reset all metrics to zero.
   */
  reset(): void {
    this.data = createEmptyMetrics()
    this.persist()
  }
}

/** Global shared instance */
export const defaultMetrics = new MetricsCollector()
