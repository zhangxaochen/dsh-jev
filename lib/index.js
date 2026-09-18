/**
 * Entry point for TypeSafe AI integration suite for DeepSeek Harness (dsh).
 * @module dsh-jev
 */
import * as ClientPlugin from './typesafe-client.js';
import * as LoopGuardPlugin from './loop-guard.js';
import * as SafetyGuardPlugin from './safety-guard.js';
import * as ToolPrunerPlugin from './tool-pruner.js';
import * as SkillRouterPlugin from './skill-router.js';
import { registerJevTools } from './ask-tools.js';
import { resolveClientFrom } from './typesafe-client.js';
import { defaultMetrics } from './metrics.js';
export * from './types.js';
export * from './typesafe-client.js';
export * from './metrics.js';
export { apply as applyLoopGuard, name as loopGuardName } from './loop-guard.js';
export { apply as applySafetyGuard, name as safetyGuardName } from './safety-guard.js';
export { apply as applyToolPruner, name as toolPrunerName, ToolPrunerService } from './tool-pruner.js';
export { apply as applySkillRouter, name as skillRouterName, SkillRouterService } from './skill-router.js';
export { registerJevTools } from './ask-tools.js';
export const name = 'dsh-jev';
export const inject = [];
/**
 * Mount the full TypeSafe plugin suite onto a Cordis context.
 */
export function apply(ctx, config = {}) {
    const disposers = [];
    // 1. Mount Client service
    const clientDisposer = ClientPlugin.apply(ctx, config.client ?? {});
    disposers.push(clientDisposer);
    // 2. Mount Loop Guard if enabled (default: true)
    if (config.loopGuard !== false) {
        const loopConfig = typeof config.loopGuard === 'object' ? config.loopGuard : {};
        const loopDisposer = LoopGuardPlugin.apply(ctx, loopConfig);
        disposers.push(loopDisposer);
    }
    // 3. Mount Safety Guard if enabled (default: true)
    if (config.safetyGuard !== false) {
        const safetyConfig = typeof config.safetyGuard === 'object' ? config.safetyGuard : {};
        const safetyDisposer = SafetyGuardPlugin.apply(ctx, safetyConfig);
        disposers.push(safetyDisposer);
    }
    // 4. Mount Tool Pruner if enabled (default: true)
    if (config.toolPruner !== false) {
        const prunerConfig = typeof config.toolPruner === 'object' ? config.toolPruner : {};
        const prunerDisposer = ToolPrunerPlugin.apply(ctx, prunerConfig);
        disposers.push(prunerDisposer);
    }
    // 5. Mount the agent-facing decision primitives
    if (config.askTools !== false) {
        try {
            for (const dispose of registerJevTools(ctx, () => resolveClientFrom(ctx))) {
                disposers.push(dispose);
            }
        }
        catch {
            /* primitives are optional */
        }
    }
    // 6. Mount the semantic skill router (advisory)
    if (config.skillRouter !== false) {
        const routerConfig = typeof config.skillRouter === 'object' ? config.skillRouter : {};
        disposers.push(SkillRouterPlugin.apply(ctx, routerConfig));
    }
    // 7. Mount Jev Metrics tool if tools service is available
    let toolsRegistered = false;
    const registerTools = (targetCtx) => {
        if (toolsRegistered)
            return;
        const toolsService = typeof targetCtx.get === 'function' ? targetCtx.get('tools') : targetCtx.tools;
        if (toolsService && typeof toolsService.register === 'function') {
            try {
                const toolDisposer = toolsService.register({
                    name: 'jev_stats',
                    description: 'Display TypeSafe Jev metrics and statistics (pruned tools, saved tokens, dead loop interruptions, safety screens, System One latency).',
                    parameters: {
                        type: 'object',
                        properties: {
                            reset: {
                                type: 'boolean',
                                description: 'Reset all metrics to zero if true',
                            },
                        },
                        additionalProperties: false,
                    },
                    output: {
                        schema: {
                            type: 'object',
                            properties: {
                                markdown: { type: 'string' },
                                tokensSaved: { type: 'number' },
                            },
                            required: ['markdown', 'tokensSaved'],
                            additionalProperties: false,
                        },
                        render: (_args, value) => [
                            {
                                type: 'text',
                                text: String(value?.markdown ?? ''),
                            },
                        ],
                    },
                    async execute(args) {
                        if (args && args.reset) {
                            defaultMetrics.reset();
                        }
                        return {
                            markdown: defaultMetrics.renderMarkdownDashboard(),
                            tokensSaved: defaultMetrics.getTotalTokensSaved(),
                        };
                    },
                    presentCall: () => ({
                        card: 'generic',
                        title: 'Jev Stats Dashboard',
                        kind: 'other',
                    }),
                });
                if (typeof toolDisposer === 'function') {
                    toolsRegistered = true;
                    disposers.push(toolDisposer);
                }
            }
            catch {
                // Ignore tool registration failure
            }
        }
    };
    // 6. Mount Fetch route on connection service (/api/dsh-jev/stats)
    // This is the canonical DSH route supported by both Desktop (dsh-app://) and Web HTTP servers.
    let connectionRegistered = false;
    const registerConnection = (targetCtx) => {
        if (connectionRegistered)
            return;
        const connection = typeof targetCtx.get === 'function' ? targetCtx.get('connection') : targetCtx.connection;
        if (connection?.fetch && typeof connection.fetch.register === 'function') {
            try {
                const apiDisposer = connection.fetch.register({
                    path: '/api/dsh-jev/stats',
                    methods: ['GET', 'POST'],
                    requestBody: 'buffered',
                    fetch: async (request) => {
                        if (request.method === 'POST') {
                            try {
                                const body = (await request.json());
                                if (body && body.reset) {
                                    defaultMetrics.reset();
                                }
                            }
                            catch { }
                        }
                        return Response.json(defaultMetrics.getSnapshot(), {
                            headers: {
                                'content-type': 'application/json; charset=utf-8',
                                'cache-control': 'no-store',
                            },
                        });
                    },
                });
                if (typeof apiDisposer === 'function') {
                    connectionRegistered = true;
                    disposers.push(apiDisposer);
                }
            }
            catch {
                // Ignore route registration collisions
            }
        }
    };
    // 7. Mount web route for HTTP / RPC inspection if webServer is available
    let webServerRegistered = false;
    const registerWebServer = (targetCtx) => {
        if (webServerRegistered)
            return;
        const webServer = typeof targetCtx.get === 'function' ? targetCtx.get('webServer') : targetCtx.webServer;
        if (webServer && typeof webServer.register === 'function') {
            try {
                const routeDisposer = webServer.register({
                    kind: 'exact',
                    path: '/api/dsh-jev/stats',
                    handler: (req, res) => {
                        if (typeof res?.setHeader === 'function') {
                            res.setHeader('Access-Control-Allow-Origin', '*');
                            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
                        }
                        if (req.method === 'OPTIONS') {
                            res.writeHead(204);
                            res.end();
                            return;
                        }
                        const url = new URL(req.url || '/api/dsh-jev/stats', 'http://localhost');
                        if (req.method === 'POST' || url.searchParams.get('reset') === '1' || url.searchParams.get('reset') === 'true') {
                            defaultMetrics.reset();
                            if (req.method === 'POST') {
                                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                                res.end(JSON.stringify({ ok: true, data: defaultMetrics.getSnapshot() }, null, 2));
                                return;
                            }
                        }
                        const accept = (req.headers && req.headers.accept) || '';
                        if (accept.includes('text/html')) {
                            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                            res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>TypeSafe Jev Stats</title><style>body{font-family:system-ui,sans-serif;padding:2rem;background:#1e1e2e;color:#cdd6f4;}pre{background:#181825;padding:1.5rem;border-radius:8px;line-height:1.6;font-size:14px;}</style></head><body><pre>${defaultMetrics.renderMarkdownDashboard()}</pre></body></html>`);
                        }
                        else {
                            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify(defaultMetrics.getSnapshot(), null, 2));
                        }
                    },
                });
                if (typeof routeDisposer === 'function') {
                    webServerRegistered = true;
                    disposers.push(routeDisposer);
                }
            }
            catch {
                // Ignore route registration collisions or unsupported contexts
            }
        }
    };
    // Attempt immediate registration for already available services
    registerTools(ctx);
    registerConnection(ctx);
    registerWebServer(ctx);
    // Also hook into ctx.inject for dynamically loaded services
    if (typeof ctx.inject === 'function') {
        try {
            const toolFiber = ctx.inject(['tools'], (child) => registerTools(child));
            if (toolFiber && typeof toolFiber.dispose === 'function')
                disposers.push(() => toolFiber.dispose());
        }
        catch { }
        try {
            const connFiber = ctx.inject(['connection'], (child) => registerConnection(child));
            if (connFiber && typeof connFiber.dispose === 'function')
                disposers.push(() => connFiber.dispose());
        }
        catch { }
        try {
            const webFiber = ctx.inject(['webServer'], (child) => registerWebServer(child));
            if (webFiber && typeof webFiber.dispose === 'function')
                disposers.push(() => webFiber.dispose());
        }
        catch { }
    }
    return () => {
        for (const dispose of disposers.reverse()) {
            dispose();
        }
    };
}
export default {
    name,
    apply,
};
//# sourceMappingURL=index.js.map