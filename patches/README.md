# Patches

pnpm applies these to `node_modules` on install; `pnpm-workspace.yaml` lists them under `patchedDependencies`.

## `@aws-blocks__bb-agent.patch`

Adds an `additionalRequestFields` option to the Agent block's model config and forwards it to Bedrock as `additionalModelRequestFields`. The block itself passes only temperature, topP, maxTokens, and stopSequences.

The wiki needs the option to switch extended thinking off for Claude 5-generation models: those models think by default, omit the thinking text from the response, and the Strands SDK bundled with the block then refuses to replay that block on the next model call, which breaks every tool call. The full reasoning is in the comment above `MODEL_EXTRA_FIELDS` in `aws-blocks/assistant.ts`.

Drop this patch, and that branch in `assistant.ts`, once the Agent block forwards the field on its own.
