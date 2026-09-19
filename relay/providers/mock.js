// SYNTHETIC provider for tests and local development only. Every response it produces is labelled
// provider "mock", and the report refuses to present a run containing it as a measurement.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function mockProvider({ ttftMs = 120, tokensPerSec = 60, outTokens = 24, cachedTtftFactor = 0.3 } = {}) {
  const seen = new Set();
  return {
    name: 'mock',
    async *stream({ system, maxTokens, cachePoint }) {
      const inputTokens = Math.ceil(system.length / 4);
      // Any repeated prefix is a hit, cache point or not, like the implicit caching Bedrock does on some models.
      // That is what lets the tests prove the benchmark's cold-prefix salt really defeats a hidden cache.
      const hit = seen.has(system);
      seen.add(system);
      await sleep(hit ? ttftMs * cachedTtftFactor : ttftMs);
      const n = Math.min(outTokens, maxTokens);
      for (let i = 0; i < n; i++) {
        if (i) await sleep(1000 / tokensPerSec);
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
    },
  };
}
