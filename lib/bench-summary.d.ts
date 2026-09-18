/**
 * Latest A/B bench summary, surfaced next to the live metrics.
 *
 * `bench/run.ts` writes this file; the dashboard and the stats route read it so
 * a number on the dashboard can always be traced to a labelled run instead of
 * being asserted by the dashboard itself.
 * @module dsh-jev/bench-summary
 */
export interface BenchSummary {
    ranAt?: string;
    offline?: boolean;
    total: number;
    correct: number;
    accuracy: number;
    falsePositives: number;
    falseNegatives: number;
    latencyMeanMs?: number;
    estimatedCostUsd?: number;
}
export declare const DEFAULT_BENCH_SUMMARY_PATH: string;
/**
 * Read the last bench summary.
 * @returns the summary, or undefined when the file is missing or unusable.
 */
export declare function readBenchSummary(path?: string): BenchSummary | undefined;
/** One-line rendering for the dashboard card. */
export declare function renderBenchLine(summary: BenchSummary | undefined): string;
//# sourceMappingURL=bench-summary.d.ts.map