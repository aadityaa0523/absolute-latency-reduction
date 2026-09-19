# Absolute Latency Reduction

A latency lab for Amazon Bedrock. It answers one question with numbers: **for a user in India, which levers actually make a remote foundation model feel faster, and by how much?**

It has two parts:

- **`relay/`** is a small streaming gateway (AWS Lambda function URL, Node.js 22) in front of Bedrock `ConverseStream`. Each request can turn one lever on or off: streaming, prompt caching (a Bedrock cache point), an exact response cache in DynamoDB, the model, and the region it runs in.
- **`bench/`** is the harness. It runs every lever as its own arm, in random order, from your machine, and reports TTFT, completion time and output tokens per second as p50/p95/p99 with paired bootstrap confidence intervals.

It does not change how Bedrock serves a model, and it does not claim to. True speculative decoding and Engram-style memory need a self-hosted model and are out of scope.

## Run it

Needs Node 22 or newer. No `npm install`: the AWS SDK ships with the Lambda runtime and the harness uses only Node built-ins.

```bash
npm test                 # 26 tests: relay logic, statistics, harness end to end
npm run local            # relay on http://127.0.0.1:8787 with a SYNTHETIC mock model
node relay/local.js --bedrock   # same, but real Bedrock with your local AWS credentials
```

Deploy one relay per region you want to compare (the region is the experiment), then benchmark:

```powershell
./scripts/deploy.ps1 -Region ap-south-1 -Profile hackathon     # repeat for eu-north-1 and us-east-1
cp bench/arms.example.json bench/arms.json                       # paste each stack's RelayUrl output
node bench/run.js --arms bench/arms.json --vantage "Bengaluru, <your network>" --rounds 10
node bench/report.js results/<run id>                            # writes report.md and summary.json
```

## How the comparison stays honest

- **One lever per comparison.** Every row in the report compares two arms that differ in exactly one setting, on the same prompt in the same round.
- **Cold prefix by default.** Every request gets a unique salt at the start of the system prompt, so no arm can profit from a cache by accident. Only the prompt-cache arm shares a prefix. The report flags any control arm that read a cache anyway.
- **No hidden retries.** The Bedrock client makes one attempt, so throttling appears as a failed request instead of inflating latency. Failures are counted and listed, never dropped.
- **TTFT means the first model token**, measured at the client, not the first byte or a placeholder message.
- **Small samples are not dressed up.** p95 needs 20 samples and p99 needs 100; otherwise they are left blank.
- **Synthetic data cannot pass as real.** Anything produced by the mock model carries a banner saying so.
- **Output length is checked.** If two arms produce different amounts of text, the report warns that completion time is not comparable and points to tokens per second.

## The public endpoint

The function URL is public so a browser page and the harness can call it. It can only serve the fixed prompts in `workload/prompts.jsonl` against the models allowlisted in `relay/models.js`, with output capped at 300 tokens and a 2 KB request limit. It is not a general model proxy. On accounts where it is possible, set `ReservedConcurrency` in the template as a cost brake.

## Status

Verified with the mock model only: the request path, caching semantics, statistics and the harness. **No real Bedrock latency has been measured yet**, because the AWS account is still under new-account verification (Bedrock calls and CloudFront creation are refused). Nothing in `results/` should be quoted until it comes from a run without the SYNTHETIC banner.

## Rules and disclosure

Built for the WeMakeDevs x AWS First Commit hackathon (Ship It track) during the event window, from a fresh repository.

AI tools used: Claude Code (Anthropic) for code, tests and documentation, reviewed and directed by the author.
