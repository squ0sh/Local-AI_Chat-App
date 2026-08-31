# Web gateway deployment

This Worker keeps your RunPod API key private and lets friends use an opaque
invite code rather than a provider API key. It enforces one active generation
and a small per-invite request budget before forwarding traffic to RunPod.

1. Create a Cloudflare Workers KV namespace and put its ID in `wrangler.toml`.
2. Create a RunPod Serverless vLLM endpoint and set its endpoint ID and chosen
   model alias in `wrangler.toml`.
3. Set the provider credential as a secret:

   ```bash
   npx wrangler secret put RUNPOD_API_KEY
   ```

4. Deploy the Worker:

   ```bash
   npx wrangler deploy
   ```

5. Create an invite (replace the example with a long random value):

   ```bash
   npx wrangler kv key put --binding=INVITES "invite-example-change-me" '{"label":"friend","expiresAt":null}'
   ```

Point the web app at the Worker URL and send each friend an invite code. The
browser sends that code as `X-App-Invite`; it never receives the RunPod key.

For a 98%+ successful-request target, start with at least one warm worker,
limit public responses to 2,048 tokens, and keep the Worker limits in place.
