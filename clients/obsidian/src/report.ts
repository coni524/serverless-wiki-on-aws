/**
 * What one sync cycle did, and how it says so.
 *
 * Kept apart from the two halves that fill it in (`sync.ts` pulls, `push.ts`
 * sends) so that neither has to import the other to count something.
 *
 * The counters are split the same way the cycle is: one group for what the Wiki
 * did to the vault, one for what the vault did to the Wiki.
 */
import { t } from './i18n';

export type SyncReport = {
  /** Spaces actually visited. */
  spaces: number;

  // ─── The Wiki wrote the vault ──────────────────────────────────────────────
  /** Bodies written to the vault. */
  fetched: number;
  /** Notes and directories renamed or moved. */
  moved: number;
  /** Notes, and the directories left empty by them, sent to the vault's `.trash`. */
  removed: number;
  /** Local versions set aside because both sides had changed. */
  conflicts: number;
  /** Pages whose body the Wiki did not have to send. */
  unchanged: number;
  /** Nodes the snapshot contained but the mapping could not place. */
  skipped: number;
  /** Attachments downloaded into the vault. */
  downloaded: number;

  // ─── The vault wrote the Wiki ──────────────────────────────────────────────
  /** Nodes created from notes and directories the Wiki did not have. */
  created: number;
  /** Nodes whose title, name, or body was sent. */
  updated: number;
  /** Nodes reparented to follow a note or directory that moved. */
  relocated: number;
  /** Nodes deleted because the note or directory was gone and the space asks for it. */
  deleted: number;
  /** Pictures uploaded from the vault, so the Wiki's readers can see them too. */
  uploaded: number;

  failures: string[];
};

export const emptyReport = (): SyncReport => ({
  spaces: 0,
  fetched: 0,
  moved: 0,
  removed: 0,
  conflicts: 0,
  unchanged: 0,
  skipped: 0,
  downloaded: 0,
  created: 0,
  updated: 0,
  relocated: 0,
  deleted: 0,
  uploaded: 0,
  failures: [],
});

/** Whether a cycle did anything the user would want to hear about. */
export const worthReporting = (report: SyncReport): boolean =>
  report.fetched +
    report.moved +
    report.removed +
    report.conflicts +
    report.skipped +
    report.downloaded +
    report.created +
    report.updated +
    report.relocated +
    report.deleted +
    report.uploaded >
    0 || report.failures.length > 0;

/**
 * The counters as a sentence.
 *
 * The sentence itself lives in the dictionary rather than here: the punctuation
 * that joins the clauses differs between the two languages, and so does the
 * wording of the counts that change with number.
 */
export const describeReport = (report: SyncReport): string => t.syncReport(report);

export const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
