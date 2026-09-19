// SYNTHETIC provider for tests and local development only. Every response it produces is labelled
// provider "mock", and the report refuses to present a run containing it as a measurement.
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
});

// ttftMs may be a number or a function of the model id, so a test can make one model slow and another fast.
export function mockProvider({ ttftMs = 120, tokensPerSec = 60, outTokens = 24, cachedTtftFactor = 0.3, reasoning = false, failModels = [] } = {}) {
  const seen = new Set();
  const started = [], aborted = [];
  return {
    name: 'mock', started, aborted,
    async *stream({ modelId, system, maxTokens, cachePoint, signal }) {
      started.push(modelId);
      try {
        if (failModels.includes(modelId)) throw Object.assign(new Error('mock failure'), { name: 'MockFailure' });
        const inputTokens = Math.ceil(system.length / 4);
        // Any repeated prefix is a hit, cache point or not, like the implicit caching Bedrock does on some models.
        // That is what lets the tests prove the benchmark's cold-prefix salt really defeats a hidden cache.
        const hit = seen.has(system);
        seen.add(system);
        if (reasoning) yield { type: 'reasoning' };
        const base = typeof ttftMs === 'function' ? ttftMs(modelId) : ttftMs;
        await sleep(hit ? base * cachedTtftFactor : base, signal);
        const n = Math.min(outTokens, maxTokens);
        for (let i = 0; i < n; i++) {
          if (i) await sleep(1000 / tokensPerSec, signal);
          yield { type: 'text', text: `tok${i} ` };
        }
        yield {
          type: 'usage', stopReason: 'end_turn', latencyMs: 0,
          usage: {
            inputTokens: hit || cachePoint ? 8 : inputTokens, outputTokens: n,
            cacheReadInputTokens: hit ? inputTokens : 0,
            cacheWriteInputTokens: cachePoint && !hit ? inputTokens : 0,
          },
        };
      } catch (e) {
        if (e.name === 'AbortError') aborted.push(modelId);
        throw e;
      }
    },
  };
}
