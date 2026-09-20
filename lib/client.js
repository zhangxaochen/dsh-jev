/**
 * Client-side Settings UI contribution for TypeSafe Jev.
 * Loaded by DeepSeek Harness client-modules into Web and Desktop shells.
 * @module dsh-jev/client
 */
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
    window.__ModuleLoader__.load({
        id: 'dsh-jev',
        factory: (require) => {
            const module = { exports: {} };
            const exports = module.exports;
            const React = require('react');
            const h = React.createElement;
            const useState = React.useState;
            const useEffect = React.useEffect;
            const CSS_STYLES = `
.jev-switch-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #b9b9c6);
  user-select: none;
}
/* Compact switch for a dense composer strip: Material's 52x32dp size is for a settings
   row, not a status bar. A 32x18 track with a 14px thumb stays legible here. */
.jev-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 32px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 999px;
  /* Off: a neutral surface token, the way Material uses surfaceContainerHighest. */
  background: var(--dsw-alias-fill-l2, rgba(148, 163, 184, 0.4));
  cursor: pointer;
  transition: background 140ms ease;
}
/* On: the host's own success colour (state-success-primary resolves to
   --dsw-static-green-500), not a hand-picked green - a semantic token follows the
   product palette in both themes, which is what shadcn's theming guide recommends. */
.jev-switch[data-state='checked'] {
  background: var(--dsw-alias-state-success-primary, var(--dsw-static-green-500, #22c55e));
}
.jev-switch[data-state='checked']:hover:not(:disabled) {
  background: var(--dsw-alias-state-success-secondary, var(--dsw-static-green-400, #4ade80));
}
.jev-switch:hover:not(:disabled) {
  filter: brightness(1.06);
}
.jev-switch:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4f8cff);
  outline-offset: 2px;
}
.jev-switch:disabled {
  opacity: 0.55;
  cursor: progress;
}
/* The thumb is white in both themes, as in iOS and Material's on-colour. Using a label
   token here is what rendered it near-black in a light context. */
.jev-switch-knob {
  position: absolute;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  transition: transform 140ms ease;
}
.jev-switch[data-state='checked'] .jev-switch-knob {
  transform: translateX(14px);
}
/* State not read yet: dashed and inert rather than guessing. */
.jev-switch[data-state='unknown'] {
  background: transparent;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.24));
}
.jev-switch[data-state='unknown'] .jev-switch-knob {
  background: var(--dsw-alias-label-secondary, #b9b9c6);
  box-shadow: none;
}
@media (prefers-reduced-motion: reduce) {
  .jev-switch,
  .jev-switch-knob {
    transition: none;
  }
}
.jev-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 4px 32px;
  font-family: inherit;
  color: var(--dsw-alias-label-primary, #ffffff);
}
.jev-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
}
.jev-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.jev-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.jev-subtitle {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  margin: 0;
}
.jev-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  background: var(--dsw-alias-bg-module-platform, rgba(34, 197, 94, 0.15));
  color: #22c55e;
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.jev-banner {
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.03));
  border-radius: 12px;
  padding: 16px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.jev-banner-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.jev-banner-title {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
}
.jev-banner-val {
  font-size: 28px;
  font-weight: 700;
  color: var(--dsw-alias-brand-primary, #38bdf8);
  font-variant-numeric: tabular-nums;
}
.jev-banner-note {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #64748b);
  margin-top: 2px;
}
.jev-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}
.jev-card {
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
  background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.02));
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.jev-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #fff);
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.05));
  padding-bottom: 8px;
}
.jev-card-metric {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 12px;
}
.jev-metric-label {
  color: var(--dsw-alias-label-secondary, #94a3b8);
}
.jev-metric-val {
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #fff);
  font-variant-numeric: tabular-nums;
}
.jev-metric-highlight {
  color: var(--dsw-alias-brand-primary, #38bdf8);
  font-weight: 600;
}
.jev-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #64748b);
}
.jev-btn-group {
  display: flex;
  gap: 8px;
}
.jev-btn {
  font: inherit;
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.15));
  background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.05));
  color: var(--dsw-alias-label-primary, #fff);
  cursor: pointer;
  transition: all 0.15s ease;
}
.jev-btn:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.1));
  border-color: var(--dsw-alias-brand-primary, #38bdf8);
}
.jev-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.jev-btn-danger {
  color: #ef4444;
}
.jev-btn-danger:hover:not(:disabled) {
  border-color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}
`;
            function injectPanelCss() {
                if (typeof document === 'undefined')
                    return () => { };
                const existing = document.querySelector('style[data-plugin="dsh-jev"]');
                if (existing)
                    return () => { };
                const style = document.createElement('style');
                style.setAttribute('data-plugin', 'dsh-jev');
                style.textContent = CSS_STYLES;
                document.head.appendChild(style);
                return () => {
                    style.remove();
                };
            }
            /**
             * The composer status-bar switch.
             *
             * Rendered into `conversation.input.right`, the slot the host puts in the composer
             * card next to the input, so the plugin can be switched off without uninstalling it
             * and without restarting the host: the plugins read the gate on every decision.
             */
            function JevToggleButton() {
                const [enabled, setEnabled] = useState(null);
                const [pending, setPending] = useState(false);
                function load() {
                    fetch('/api/dsh-jev/stats', { headers: { Accept: 'application/json' }, cache: 'no-store' })
                        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
                        .then((json) => setEnabled(json?.gate?.enabled !== false))
                        .catch(() => setEnabled(null));
                }
                useEffect(() => {
                    load();
                    const timer = setInterval(load, 10000);
                    return () => clearInterval(timer);
                }, []);
                function toggle() {
                    if (enabled === null || pending)
                        return;
                    setPending(true);
                    fetch('/api/dsh-jev/stats', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ enabled: !enabled }),
                    })
                        .then(() => load())
                        .catch(() => { })
                        .finally(() => setPending(false));
                }
                const known = enabled !== null;
                const on = known && enabled === true;
                // Radix exposes the state as `data-state`, so the styles above key off the state
                // rather than off bespoke class names.
                const state = !known ? 'unknown' : on ? 'checked' : 'unchecked';
                const title = !known
                    ? 'TypeSafe Jev：未能读到开关状态（宿主路由未就绪）'
                    : on
                        ? 'TypeSafe Jev 已启用：语义剪枝、技能路由、结果整形、死循环与安全拦截均生效。点击停用'
                        : 'TypeSafe Jev 已停用：不剪枝、不路由、不整形、不拦截（含确定性硬拒层）。点击启用';
                return h('span', { className: 'jev-switch-wrap', title }, 
                // The label sits outside the graphic, as Material asks: never "on/off" inside it.
                h('span', null, 'jev'), h('button', {
                    type: 'button',
                    role: 'switch',
                    'data-state': state,
                    'aria-checked': known ? on : 'mixed',
                    'aria-label': 'TypeSafe Jev 开关',
                    className: 'jev-switch',
                    title,
                    onClick: toggle,
                    disabled: pending || !known,
                }, h('span', { className: 'jev-switch-knob' })));
            }
            function JevSettingsPage() {
                const [data, setData] = useState(null);
                const [loading, setLoading] = useState(true);
                const [error, setError] = useState(null);
                const [actionPending, setActionPending] = useState(false);
                function getEndpoint() {
                    return '/api/dsh-jev/stats';
                }
                function loadStats() {
                    setError(null);
                    fetch(getEndpoint(), {
                        headers: { Accept: 'application/json' },
                        cache: 'no-store',
                    })
                        .then((res) => {
                        if (!res.ok)
                            throw new Error(`HTTP ${res.status}`);
                        const contentType = res.headers.get('content-type') || '';
                        if (!contentType.includes('application/json')) {
                            throw new Error('API 服务尚未就绪，未返回有效 JSON');
                        }
                        return res.json();
                    })
                        .then((json) => {
                        setData(json);
                        setLoading(false);
                    })
                        .catch((err) => {
                        setError(err.message || '获取指标数据失败');
                        setLoading(false);
                    });
                }
                useEffect(() => {
                    loadStats();
                    const timer = setInterval(loadStats, 4000);
                    return () => clearInterval(timer);
                }, []);
                function handleReset() {
                    if (!confirm('确定要将 TypeSafe Jev 守护指标归零吗？'))
                        return;
                    setActionPending(true);
                    fetch(getEndpoint(), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reset: true }),
                    })
                        .then(() => loadStats())
                        .catch((err) => setError(err.message))
                        .finally(() => setActionPending(false));
                }
                // Only the tool surface is measurable; loop notices report counts instead
                // of an invented token total.
                const totalTokens = data ? (data.toolPruner?.estimatedTokensSaved ?? 0) : 0;
                const tokenSourceLabel = data?.toolPruner?.tokenSource === 'tokenMeter'
                    ? 'tokenMeter 口径'
                    : data?.toolPruner?.tokenSource === 'mixed'
                        ? 'tokenMeter + 本地启发混合'
                        : '本地启发式口径';
                const formattedTokens = totalTokens >= 1_000_000
                    ? `${(totalTokens / 1_000_000).toFixed(2)}M`
                    : totalTokens >= 1_000
                        ? `${(totalTokens / 1_000).toFixed(1)}K`
                        : String(totalTokens);
                return h('div', { className: 'jev-container' }, 
                // Header
                h('div', { className: 'jev-header' }, h('div', { className: 'jev-title-wrap' }, h('h2', { className: 'jev-title' }, '🛡️ TypeSafe Jev 守护与收益看板'), h('p', { className: 'jev-subtitle' }, 'System One 毫秒级语义决策 · 工具剪枝 · 死循环止损 · 执行安全门禁')), h('span', { className: 'jev-badge' }, '● 守护中')), 
                // Banner
                h('div', { className: 'jev-banner' }, h('div', { className: 'jev-banner-left' }, h('span', { className: 'jev-banner-title' }, '累计预估节省 Token 运行开销'), h('span', { className: 'jev-banner-val' }, `~${formattedTokens}`), h('span', { className: 'jev-banner-note' }, '💡 工具剪枝按被裁工具 Schema 实际字符精准换算；死循环熔断按避免 3~5 轮空转经验均值折算')), h('div', { className: 'jev-btn-group' }, h('button', {
                    className: 'jev-btn',
                    onClick: loadStats,
                    disabled: loading || actionPending,
                }, loading ? '刷新中…' : '刷新数据'), h('button', {
                    className: 'jev-btn jev-btn-danger',
                    onClick: handleReset,
                    disabled: loading || actionPending,
                }, '指标归零'))), 
                // Error alert
                error
                    ? h('div', { style: { color: '#ef4444', fontSize: '12px', padding: '4px 0' } }, `⚠️ 提示: ${error}`)
                    : null, 
                // 4 Metric Cards Grid
                h('div', { className: 'jev-grid' }, 
                // Card 1: Tool Pruner
                h('div', { className: 'jev-card' }, h('div', { className: 'jev-card-head' }, h('span', null, '🛠️ 动态工具剪枝'), h('span', { className: 'jev-metric-highlight' }, `~${((data?.toolPruner?.estimatedTokensSaved ?? 0) / 1000).toFixed(1)}K Tokens`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '剪枝决策评估'), h('span', { className: 'jev-metric-val' }, `${data?.toolPruner?.evaluations ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '累计裁剪次无关工具'), h('span', { className: 'jev-metric-val' }, `${data?.toolPruner?.toolsPruned ?? 0} 个`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '保留命中核心工具'), h('span', { className: 'jev-metric-val' }, `${data?.toolPruner?.toolsRetained ?? 0} 个`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '精确移除 Schema 字符'), h('span', { className: 'jev-metric-val' }, `${data?.toolPruner?.removedSchemaChars ?? 0}`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, 'Token 折算口径'), h('span', { className: 'jev-metric-val' }, tokenSourceLabel))), 
                // Card 2: Loop Guard
                h('div', { className: 'jev-card' }, h('div', { className: 'jev-card-head' }, h('span', null, '🔄 死循环及早熔断'), h('span', { className: 'jev-metric-highlight' }, `${data?.loopGuard?.notices ?? 0} 条提示`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '循环停滞检测'), h('span', { className: 'jev-metric-val' }, `${data?.loopGuard?.checks ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '阻断死循环空转'), h('span', { className: 'jev-metric-val' }, `${data?.loopGuard?.interrupted ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '注入自愈警示'), h('span', { className: 'jev-metric-val' }, `${data?.loopGuard?.warned ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '判定不可用（跳过）'), h('span', { className: 'jev-metric-val' }, `${data?.loopGuard?.uncertain ?? 0} 次`))), 
                // Card 3: Safety Guard
                h('div', { className: 'jev-card' }, h('div', { className: 'jev-card-head' }, h('span', null, '🔒 执行安全护栏'), h('span', { className: 'jev-metric-highlight' }, '实时门禁')), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '敏感指令审查'), h('span', { className: 'jev-metric-val' }, `${data?.safetyGuard?.screened ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '阻断高危破坏操作'), h('span', { className: 'jev-metric-val' }, `${data?.safetyGuard?.blocked ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '降级人工审批提醒'), h('span', { className: 'jev-metric-val' }, `${data?.safetyGuard?.approvals ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '确定性拒止（0 次模型调用）'), h('span', { className: 'jev-metric-val' }, `${data?.safetyGuard?.hardDenied ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '判定不可用 fail-closed'), h('span', { className: 'jev-metric-val' }, `${data?.safetyGuard?.uncertainDenied ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '判定失败（降级，最近一次）'), h('span', { className: 'jev-metric-val' }, `${data?.safetyGuard?.inspectionFailures ?? 0} 次 · ${(data?.safetyGuard?.lastInspectionFailureAt ?? '').replace('T', ' ').slice(0, 19) || '从未'}`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '用户规则命中'), h('span', { className: 'jev-metric-val' }, (data?.safetyGuard?.ruleIds ?? []).length > 0
                    ? (data?.safetyGuard?.ruleIds ?? [])
                        .map((id) => `${id}×${data?.safetyGuard?.ruleHits?.[id]?.count ?? 0}`)
                        .join('·')
                    : '未配置'))), 
                // Card 4: System One Latency
                h('div', { className: 'jev-card' }, h('div', { className: 'jev-card-head' }, h('span', null, '⚡ System One 响应'), h('span', { className: 'jev-metric-highlight' }, `${data?.systemOne?.avgLatencyMs ?? 0} ms`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '累计决策判定'), h('span', { className: 'jev-metric-val' }, `${data?.systemOne?.totalCalls ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '平均毫秒延迟'), h('span', { className: 'jev-metric-val' }, `${data?.systemOne?.avgLatencyMs ?? 0} ms`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '异常错误数'), h('span', { className: 'jev-metric-val' }, `${data?.systemOne?.errors ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '相同载荷缓存命中'), h('span', { className: 'jev-metric-val' }, `${data?.systemOne?.cacheHits ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '输入 token 与预估费用'), h('span', { className: 'jev-metric-val' }, `${(((data?.systemOne?.inputBytes ?? 0) / 1024)).toFixed(1)}KB / $${(data?.systemOne?.estimatedCostUsd ?? 0).toFixed(4)}`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '每次判定成本（缓存命中后）'), h('span', { className: 'jev-metric-val' }, `$${(data?.systemOne?.costPerDecisionUsd ?? 0).toFixed(6)} / $${(data?.systemOne?.costPerBilledCallUsd ?? 0).toFixed(6)} · ${((data?.systemOne?.cacheHitRate ?? 0) * 100).toFixed(0)}%`)))), 
                // Card 5: Result shaper (opt-in; shown so an enabled module is visible)
                h('div', { className: 'jev-card' }, h('div', { className: 'jev-card-head' }, h('span', null, '🧩 语义结果整形'), h('span', { className: 'jev-metric-highlight' }, `${(((data?.resultShaper?.charsRemoved ?? 0) / 1000)).toFixed(1)}K 字符`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '整形次数'), h('span', { className: 'jev-metric-val' }, `${data?.resultShaper?.shaped ?? 0} 次`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '精确移除字符'), h('span', { className: 'jev-metric-val' }, `${data?.resultShaper?.charsRemoved ?? 0}`)), h('div', { className: 'jev-card-metric' }, h('span', { className: 'jev-metric-label' }, '启用状态'), h('span', { className: 'jev-metric-val' }, (data?.resultShaper?.shaped ?? 0) > 0 ? '已启用' : '默认关闭'))), 
                // Bench summary line
                data?.bench
                    ? h('div', { className: 'jev-footer-note', style: { marginTop: '4px' } }, `A/B 基准（${data.bench.offline ? '离线回放' : '真实 API'}）：${data.bench.correct}/${data.bench.total} 正确、误报 ${data.bench.falsePositives}、漏报 ${data.bench.falseNegatives}`)
                    : null, 
                // Footer
                h('div', { className: 'jev-footer' }, h('span', null, `持久化文件：~/.dsh/jev-stats.json | 起始时间：${(data?.firstRecordedAt || '').replace('T', ' ').slice(0, 19)}`), h('span', null, `更新时间：${(data?.lastUpdatedAt || '').replace('T', ' ').slice(0, 19)}`)));
            }
            function apply(ctx) {
                if (typeof ctx?.effect === 'function') {
                    ctx.effect(() => injectPanelCss(), 'dsh-jev: settings styles');
                }
                if (ctx?.slots && typeof ctx.slots.inject === 'function') {
                    ctx.slots.inject('settings.section', () => ctx.slots.register({
                        name: 'settings.section',
                        id: 'jev',
                        order: 25,
                        label: () => 'TypeSafe Jev',
                    }, JevSettingsPage));
                    // Status-bar switch in the composer card (`conversation.input.right`, the same
                    // slot the commandcode usage badge uses).
                    ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
                        name: 'conversation.input.right',
                        id: 'jev-toggle',
                        order: 8,
                        label: () => 'TypeSafe Jev 开关',
                    }, JevToggleButton));
                }
            }
            exports.apply = apply;
            exports.inject = ['slots'];
            return module.exports;
        },
    });
}

//# sourceMappingURL=client.js.map