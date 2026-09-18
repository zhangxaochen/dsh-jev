/**
 * Append-only decision log for calibration.
 *
 * Every semantic decision is recorded with the facts needed to re-derive its
 * threshold later: the question, the answer, its confidence, the action taken,
 * the measured latency and the billed input size. This is the dataset the
 * calibration table in docs/calibration.md is supposed to be built from.
 * @module dsh-jev/decisions
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
export const DEFAULT_DECISION_LOG = join(homedir(), '.dsh', 'jev-decisions.jsonl');
export class DecisionLog {
    path;
    constructor(path = DEFAULT_DECISION_LOG) {
        this.path = path;
    }
    /** Append one decision. Never throws: logging must not break an agent turn. */
    append(record) {
        try {
            const full = { ...record, ts: record.ts ?? new Date().toISOString() };
            mkdirSync(dirname(this.path), { recursive: true });
            appendFileSync(this.path, JSON.stringify(full) + '\n', 'utf8');
        }
        catch {
            /* read-only or unwritable home: decisions simply stay unlogged */
        }
    }
    /** Read every recorded decision, skipping unparsable lines. */
    read() {
        if (!existsSync(this.path))
            return [];
        const out = [];
        for (const line of readFileSync(this.path, 'utf8').split('\n')) {
            if (line.trim().length === 0)
                continue;
            try {
                out.push(JSON.parse(line));
            }
            catch {
                /* a truncated tail line is expected after a crash */
            }
        }
        return out;
    }
    /**
     * Per-action counts plus the confidence distribution per module, which is what
     * a threshold review actually needs.
     */
    summarize() {
        const byModule = {};
        const buckets = {};
        const records = this.read();
        for (const record of records) {
            const module = record.module || 'unknown';
            byModule[module] = byModule[module] ?? {};
            byModule[module][record.action] = (byModule[module][record.action] ?? 0) + 1;
            if (typeof record.confidence === 'number') {
                const key = module + ':' + record.action;
                buckets[key] = buckets[key] ?? [];
                buckets[key].push(record.confidence);
            }
        }
        const confidence = {};
        for (const [key, values] of Object.entries(buckets)) {
            const sum = values.reduce((acc, value) => acc + value, 0);
            confidence[key] = {
                count: values.length,
                min: Math.min(...values),
                max: Math.max(...values),
                mean: Number((sum / values.length).toFixed(3)),
            };
        }
        return { total: records.length, byModule, confidence };
    }
}
/** Shared instance used by the guard plugins. */
export const defaultDecisionLog = new DecisionLog();
//# sourceMappingURL=decisions.js.map