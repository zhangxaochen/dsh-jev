/** Overrides the toggle file, so tests and scripts never touch the operator's state. */
export declare const GATE_PATH_ENV = "DSH_JEV_GATE_PATH";
export interface JevGateState {
    enabled: boolean;
    /** When and why it was last changed, for the panel to show. */
    changedAt?: string;
    changedBy?: string;
}
export declare function resolveGatePath(explicit?: string): string;
/**
 * Whether the plugin should act.
 *
 * Any problem reading the file yields `true`: the guard layer must not be disabled by a
 * filesystem hiccup.
 */
export declare function isJevEnabled(explicitPath?: string): boolean;
/** Full state, for the payload the panel renders. */
export declare function readJevGate(explicitPath?: string): JevGateState;
/** Flip the switch and persist it. */
export declare function setJevEnabled(enabled: boolean, changedBy?: string, explicitPath?: string): JevGateState;
//# sourceMappingURL=gate.d.ts.map