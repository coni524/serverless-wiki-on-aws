/**
 * Whether this process is a deployed compute rather than the local dev server.
 *
 * The backend module is imported by two deployed computes: the Lambda handler,
 * where the runtime always sets `AWS_LAMBDA_FUNCTION_NAME`, and the AgentCore
 * Runtime the Agent block runs the assistant on, which is not a Lambda and does
 * not set it. The framework gives both `BLOCKS_CONFIG_BUCKET` so they can load
 * the stack's config; the dev server sets neither. Either marker counts, so a
 * guard that must stay shut in every deployed process does not open in the one
 * that is not a Lambda.
 */
export const DEPLOYED =
  process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined ||
  process.env.BLOCKS_CONFIG_BUCKET !== undefined;
