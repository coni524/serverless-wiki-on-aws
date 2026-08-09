import { createLambdaHandler } from '@aws-blocks/blocks/lambda-handler';

// Passed as a lazy factory. A Building Block reads its settings from process.env
// at import time, so a static import would load the backend before the settings
// have been fetched from S3.
export const handler = createLambdaHandler(() => import('./index.js'));
