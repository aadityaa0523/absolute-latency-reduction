// Allowlist of models the public endpoint may call. Clients send the handle, never a raw model id,
// so a stranger with the URL cannot point the relay at an expensive model.
// cache: 'explicit' = accepts a cachePoint (minCacheTokens is the model card's minimum prefix); 'none' = no explicit cache.
// extra: passed to Converse as additionalModelRequestFields. reasoning: the model may emit reasoning tokens before its answer.
// Source: the Bedrock model cards, checked 2026-09-19. Ids and Regions were also read back with list-inference-profiles.
// Granted access is not verified yet (the account is blocked); a refused model shows up as an error, never a silent fallback.
export const MODELS = {
  // In-Region in us-east-1, eu-north-1 and ap-south-1, so it isolates the effect of the region itself.
  // A reasoning model: its first answer token comes after thinking, which the report flags.
  'gpt-oss-20b-inregion': { id: 'openai.gpt-oss-20b-1:0', cache: 'none', reasoning: true },
  // Same model and Region, in-Region versus a geographic profile: isolates cross-Region routing (us-east-1, eu-north-1).
  'nova-lite-inregion': { id: 'amazon.nova-lite-v1:0', cache: 'explicit', minCacheTokens: 1024 },
  'nova-lite-us': { id: 'us.amazon.nova-lite-v1:0', cache: 'explicit', minCacheTokens: 1024 },
  'nova-lite-eu': { id: 'eu.amazon.nova-lite-v1:0', cache: 'explicit', minCacheTokens: 1024 },
  // Mumbai has only the APAC geographic profile for the original Nova models.
  'nova-lite-apac': { id: 'apac.amazon.nova-lite-v1:0', cache: 'explicit', minCacheTokens: 1024 },
  'nova-micro-apac': { id: 'apac.amazon.nova-micro-v1:0', cache: 'explicit', minCacheTokens: 1024 },
  // Mumbai reaches these only through the global profile. Priority tier is supported for Nova 2 Lite.
  'nova-2-lite-global': { id: 'global.amazon.nova-2-lite-v1:0', cache: 'explicit', minCacheTokens: 1024 },
  // Needs at least 4,096 prefix tokens for a cache point; the workload's prefix is shorter, which is itself a finding.
  // cacheTtl 1h (the card lists 5 minutes and 1 hour for Claude) keeps the cached prefix warm between sparse requests.
  'haiku-4-5-global': { id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', cache: 'explicit', minCacheTokens: 4096, cacheTtl: '1h' },
  // Adaptive thinking is on by default for this model, which would put reasoning time inside TTFT. Turn it off.
  'sonnet-5-global': { id: 'global.anthropic.claude-sonnet-5', cache: 'explicit', minCacheTokens: 1024, cacheTtl: '1h', extra: { thinking: { type: 'disabled' } } },
};
