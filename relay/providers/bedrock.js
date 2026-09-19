// Real provider: Amazon Bedrock ConverseStream. The SDK ships with the Lambda Node runtime, so it is
// imported lazily and the repo needs no npm install.
export async function bedrockProvider(region) {
  const { BedrockRuntimeClient, ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');
  // maxAttempts 1: a hidden SDK retry would be folded into TTFT and hide throttling from the results.
  const client = new BedrockRuntimeClient({ region, maxAttempts: 1 });
  return {
    name: 'bedrock',
    async *stream({ modelId, system, question, maxTokens, cachePoint, cacheTtl, extra, signal }) {
      const res = await client.send(new ConverseStreamCommand({
        modelId,
        system: [{ text: system }, ...(cachePoint ? [{ cachePoint: { type: 'default', ...(cacheTtl ? { ttl: cacheTtl } : {}) } }] : [])],
        messages: [{ role: 'user', content: [{ text: question }] }],
        inferenceConfig: { maxTokens, temperature: 0 },
        ...(extra ? { additionalModelRequestFields: extra } : {}),
      }), { abortSignal: signal });
      let stopReason;
      for await (const ev of res.stream) {
        const delta = ev.contentBlockDelta?.delta;
        if (delta?.text) yield { type: 'text', text: delta.text };
        else if (delta?.reasoningContent) yield { type: 'reasoning' };
        else if (ev.messageStop) stopReason = ev.messageStop.stopReason;
        else if (ev.metadata) yield { type: 'usage', usage: ev.metadata.usage ?? {}, latencyMs: ev.metadata.metrics?.latencyMs, stopReason };
      }
    },
  };
}
