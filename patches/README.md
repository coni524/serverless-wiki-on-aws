# Patches

pnpm applies these to `node_modules` on install; `pnpm-workspace.yaml` lists them under `patchedDependencies`.

A patch is made with `pnpm patch <package>@<version>` and `pnpm patch-commit <dir>`. Delete the `index <hash>..<hash>` line that `patch-commit` writes before committing (the pre-commit hook refuses it), then run `pnpm install` so the lockfile records the edited file's hash. When the package's version changes, the patch is made again for the new version.

## `@aws-cdk-blocks__bb-lambda-compute@1.0.0.patch`

Sets `bundleAwsSDK: true` on the shared Lambda function, so the `@aws-sdk/*` clients in `package.json` are bundled into the function instead of being taken from the Lambda runtime.

The runtime ships a fixed, older minor version of the SDK. Search calls S3 Vectors with `queryTexts` and `returnScores` (hybrid search), which an SDK older than the feature drops from the request without an error, so the bundled client is required. `queryTexts` first appears in `@aws-sdk/client-s3vectors` 3.1170.0. The AgentCore Runtime bundle already includes the SDK and needs no change.

Drop this patch once the Lambda block bundles the SDK on its own, or offers an option to.
