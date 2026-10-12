import type { PipelineContext, PipelineStep, TraceEntry } from './types';
const snapshot = (ctx: PipelineContext) => {
  const { signal: _s, onToken: _o, ...rest } = ctx; void _s; void _o;
  return JSON.parse(JSON.stringify(rest));
};
/** Run steps sequentially, recording input/output/duration per step. */
export async function runPipeline(steps: PipelineStep[], initial: PipelineContext, onTrace?: (t: TraceEntry[]) => void) {
  const trace: TraceEntry[] = [];
  let ctx = initial;
  for (const step of steps) {
    if (ctx.dryRun && step.skipOnDryRun) { trace.push({ step: step.name, input: null, output: null, durationMs: 0, skipped: true }); continue; }
    const input = snapshot(ctx); const t0 = performance.now();
    try {
      ctx = await step.run(ctx);
      trace.push({ step: step.name, input, output: snapshot(ctx), durationMs: performance.now() - t0 });
      onTrace?.([...trace]);
    } catch (e) {
      trace.push({ step: step.name, input, output: null, durationMs: performance.now() - t0, error: (e as Error).message });
      onTrace?.([...trace]);
      throw Object.assign(e as Error, { trace, ctx });
    }
  }
  return { ctx, trace };
}
