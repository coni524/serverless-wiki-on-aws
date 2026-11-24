# Patches

pnpm applies these to `node_modules` on install; `pnpm-workspace.yaml` lists them under `patchedDependencies`.

## `@aws-blocks__bb-lambda-compute@0.7.0.patch`

Sets `bundleAwsSDK: true` on the shared Lambda function, so the `@aws-sdk/*` clients in `package.json` are bundled into the function instead of being taken from the Lambda runtime.

The runtime ships a fixed, older minor version of the SDK. Search calls S3 Vectors with `queryTexts` and `returnScores` (hybrid search), which an SDK older than the feature drops from the request without an error, so the bundled client is required. `queryTexts` first appears in `@aws-sdk/client-s3vectors` 3.1170.0. The AgentCore Runtime bundle already includes the SDK and needs no change.

Drop this patch once the Lambda block bundles the SDK on its own, or offers an option to.
