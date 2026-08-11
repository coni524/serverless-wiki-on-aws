/**
 * The two dictionaries, assembled from one module per area of the screen.
 *
 * Areas are split so that the wording of a screen and the code that draws it
 * can be changed together, without every such change touching one file. The
 * split is by area rather than by language on purpose: a translation is easiest
 * to check when both languages sit side by side, and each module's `en` is
 * annotated with the type derived from its `ja`, so the two cannot drift.
 */

import * as admin from './admin';
import * as app from './app';
import * as assistant from './assistant';
import * as common from './common';
import * as page from './page';
import * as space from './space';

const ja = {
  admin: admin.ja,
  app: app.ja,
  assistant: assistant.ja,
  common: common.ja,
  page: page.ja,
  space: space.ja,
};

/** What `useT()` hands a component. Derived from `ja`, satisfied by `en`. */
export type Messages = typeof ja;

const en: Messages = {
  admin: admin.en,
  app: app.en,
  assistant: assistant.en,
  common: common.en,
  page: page.en,
  space: space.en,
};

export const messages = { ja, en };
