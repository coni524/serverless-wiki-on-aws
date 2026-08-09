/**
 * Stored model — schema, keys, and pure helpers.
 *
 * Every entity lives in one DistributedTable under a shared envelope:
 * `pk` / `sk` for the primary key, `gsi1pk` / `gsi1sk` for the single reverse
 * index. A DistributedTable takes exactly one `schema`, and `TableKeyConfig`
 * constrains key fields to `keyof T`, so a discriminated union cannot be used
 * here — the envelope plus a `superRefine` per `type` is the workable shape.
 *
 * No file in this module touches the network; it is safe to import anywhere.
 */
import { z } from 'zod';

// ─── Permission levels ───────────────────────────────────────────────────────
// A total order. Reaching the same space through several role groups yields the
// strongest of them; there is no deny.
export const PERMISSIONS = ['read', 'write', 'admin'] as const;
export type Permission = (typeof PERMISSIONS)[number];

const RANK: Record<Permission, number> = { read: 1, write: 2, admin: 3 };

export function atLeast(have: Permission, need: Permission): boolean {
  return RANK[have] >= RANK[need];
}

export function strongest(a: Permission | undefined, b: Permission): Permission {
  return a === undefined || RANK[b] > RANK[a] ? b : a;
}

// ─── Entity types ────────────────────────────────────────────────────────────
export const ITEM_TYPES = [
  'USER',
  'SPACE',
  'USER_GROUP',
  'ROLE_GROUP',
  'MEMBERSHIP',
  'ATTACHMENT',
  'GRANT',
  'CONFIG',
  'EPOCH',
  'PAGE',
  'PAGE_REF',
  'CLEANUP',
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/**
 * The stored shape. Type-specific fields are optional at the object level and
 * required per `type` by the refinement below.
 *
 * Note the refinement only runs when the base object parses. The CDK layer
 * probes key attribute types with a partial object (`{ pk: 0 }`), which fails
 * the base parse, so the probe is unaffected.
 */
export const itemSchema = z
  .object({
    pk: z.string().min(1),
    sk: z.string().min(1),
    type: z.enum(ITEM_TYPES),
    gsi1pk: z.string().optional(),
    gsi1sk: z.string().optional(),

    /** Optimistic-lock counter. DistributedTable has no partial update, so every
     *  mutable entity is rewritten whole under `ifFieldEquals: { version }`. */
    version: z.number().int().nonnegative().optional(),

    // USER
    email: z.string().optional(),
    displayName: z.string().optional(),

    // SPACE / USER_GROUP / ROLE_GROUP
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    /** Seeded, not created through the API; cannot be renamed or deleted. */
    system: z.boolean().optional(),
    /** ROLE_GROUP only: admin over every space, plus the management API. */
    global: z.boolean().optional(),

    // GRANT
    permission: z.enum(PERMISSIONS).optional(),

    // CONFIG
    defaultUserGroupId: z.string().optional(),

    /** EPOCH — the generation of the permission graph as a whole.
     *  Opaque: only compared for equality, never ordered or incremented. */
    epoch: z.string().optional(),

    // PAGE
    title: z.string().min(1).max(200).optional(),
    /**
     * Which of the two node kinds this is. Absent means `page`, so
     * every record written before folders existed reads as one.
     *
     * Folders share the page's key namespace on purpose: a space's listing and a
     * parent's children then come back from one query, in `position` order, with
     * both kinds already interleaved.
     */
    kind: z.enum(['page', 'folder']).optional(),
    /** Absent on a top-level node. The only edge the tree is made of. */
    parentPageId: z.string().optional(),
    /** Fixed-width base-36 key ordering siblings. Never compared numerically. */
    position: z.string().optional(),
    /** S3 key of the revision that is currently the body. */
    bodyKey: z.string().optional(),
    revision: z.number().int().positive().optional(),
    updatedAt: z.string().optional(),
    createdBy: z.string().optional(),
    updatedBy: z.string().optional(),

    // PAGE_REF — the one record that maps a bare page id to its space.
    spaceId: z.string().optional(),

    // CLEANUP — the promise that these S3 objects will be reclaimed.
    prefix: z.string().optional(),

    createdAt: z.string().optional(),
    addedAt: z.string().optional(),
    addedBy: z.string().optional(),
  })
  .superRefine((item, ctx) => {
    const require = (field: keyof typeof item) => {
      if (item[field] === undefined) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${item.type} requires ${field}` });
      }
    };
    switch (item.type) {
      case 'USER':
        require('email');
        break;
      case 'SPACE':
      case 'USER_GROUP':
      case 'ROLE_GROUP':
        require('name');
        break;
      case 'GRANT':
        require('permission');
        break;
      case 'EPOCH':
        require('epoch');
        break;
      case 'PAGE':
        require('title');
        require('position');
        // A folder holds a name and a place in the tree, nothing else: no body
        // in S3, so no key to point at and no revision to count.
        if (item.kind !== 'folder') {
          require('bodyKey');
          require('revision');
        }
        break;
      case 'PAGE_REF':
        require('spaceId');
        break;
      case 'CLEANUP':
        require('prefix');
        break;
      default:
        break;
    }
  });

export type Item = z.infer<typeof itemSchema>;

// ─── Keys ────────────────────────────────────────────────────────────────────
export const userPk = (userSub: string) => `USER#${userSub}`;
export const spacePk = (spaceId: string) => `SPACE#${spaceId}`;
export const userGroupPk = (userGroupId: string) => `UG#${userGroupId}`;
export const roleGroupPk = (roleGroupId: string) => `RG#${roleGroupId}`;

export const META = 'META';
export const PROFILE = 'PROFILE';
export const CONFIG_PK = 'CONFIG';
export const CONFIG_DEFAULTS = 'DEFAULTS';
/** Sort key of the permission epoch, alongside the other config records. */
export const CONFIG_EPOCH = 'EPOCH';

/** `gsi1pk` values for the "list everything of this kind" queries. */
export const ALL_USERS = 'USER';
export const ALL_SPACES = 'SPACE';
export const ALL_USER_GROUPS = 'UG';
export const ALL_ROLE_GROUPS = 'RG';

// ─── Pages ───────────────────────────────────────────────────────────────────
// A page lives in its space's partition, so the "every page in this space"
// listing is a primary-key query and never misses a row. `gsi1` carries the
// reverse edge — "the children of this parent" — under its own `PARENT#`
// namespace, because `listSpaceRoleGroups()` already queries `gsi1pk =
// SPACE#<id>` with no sort-key condition and would otherwise pick pages up.

export const pageSk = (pageId: string) => `PAGE#${pageId}`;
export const PAGE_SK_PREFIX = 'PAGE#';

/** The kind of a stored node, reading the pre-folder absence as `page`. */
export const kindOf = (item: { kind?: string }): 'page' | 'folder' =>
  item.kind === 'folder' ? 'folder' : 'page';

/** `gsi1pk` for the children of a page, or of the space root. */
export const childrenOfPage = (parentPageId: string) => `PARENT#PAGE#${parentPageId}`;
export const childrenOfSpace = (spaceId: string) => `PARENT#SPACE#${spaceId}`;
export const parentKey = (spaceId: string, parentPageId?: string) =>
  parentPageId === undefined ? childrenOfSpace(spaceId) : childrenOfPage(parentPageId);

/** `gsi1sk`. The id breaks ties so two pages sharing a position still both list. */
export const siblingSk = (position: string, pageId: string) => `${position}#${pageId}`;

/** Locates a page from its id alone, for callers that never had the space id. */
export const pageRefPk = (pageId: string) => `PAGE#${pageId}`;
export const PAGE_REF_SK = 'SPACE';

export const CLEANUP_PK = 'CLEANUP';
export const cleanupSk = (createdAt: string, cleanupId: string) => `${createdAt}#${cleanupId}`;

/**
 * How deep the tree may go, counting the top level as 1.
 *
 * The cap is what makes the breadcrumb affordable: with no denormalized path,
 * walking to the root costs one `get()` per level, and 10 of those
 * sit well inside the six queries permission resolution already spends.
 */
export const MAX_DEPTH = 10;

// ─── S3 keys ─────────────────────────────────────────────────────────────────
// Every key starts with the space id so that reclaiming a deleted space is a
// single prefix sweep that does not consult DynamoDB at all.

export const spacePrefix = (spaceId: string) => `spaces/${spaceId}/`;
export const pagePrefix = (spaceId: string, pageId: string) =>
  `${spacePrefix(spaceId)}pages/${pageId}/`;

/**
 * Key of one revision of a page body.
 *
 * The revision number is zero-padded so the keys sort in the order they were
 * written — that is what a future "prune old revisions" pass needs, since the
 * lifecycle rules cannot express it.
 *
 * `attempt` is what keeps two concurrent savers apart. Without it they would
 * both compute the same next revision and write over each other, which is the
 * very collision the revision-key scheme exists to avoid.
 */
export const bodyKey = (spaceId: string, pageId: string, revision: number, attempt: string) =>
  `${pagePrefix(spaceId, pageId)}body/${String(revision).padStart(10, '0')}-${attempt}.md`;

/**
 * Keys of a page's attachments, all under the page's own prefix so a page or
 * space delete reclaims them with the same sweep that takes the bodies.
 * No DynamoDB record backs an attachment: the S3 object is the only
 * source of truth.
 *
 * The file name is the last segment, `encodeURIComponent`d — a raw `/` in a
 * name would add a key segment, and the local mock also mis-scans an unescaped
 * `//` (see the block's README). The id sits above the name so one attachment
 * is a prefix of its own, which is what makes locating or deleting it a scoped
 * sweep rather than a listing of the whole page.
 */
export const attachmentsPrefix = (spaceId: string, pageId: string) =>
  `${pagePrefix(spaceId, pageId)}att/`;
export const attachmentPrefix = (spaceId: string, pageId: string, attachmentId: string) =>
  `${attachmentsPrefix(spaceId, pageId)}${attachmentId}/`;
export const attachmentKey = (
  spaceId: string,
  pageId: string,
  attachmentId: string,
  filename: string,
) => `${attachmentPrefix(spaceId, pageId, attachmentId)}${encodeURIComponent(filename)}`;

// ─── Sibling ordering ────────────────────────────────────────────────────────

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A position after every existing sibling.
 *
 * The clock, base 36 and fixed width, so ordinary appends stay 10 characters
 * and sort in creation order. `last` is the largest position currently in use;
 * it can exceed the clock only if someone hand-placed a page there, and then a
 * suffix digit is appended, which is greater than `last` for any digit chosen.
 */
export function after(last: string | undefined, millis: number): string {
  const byClock = millis.toString(36).padStart(10, '0');
  return last === undefined || byClock > last ? byClock : last + DIGITS[18];
}

/**
 * A position strictly between `lower` and `upper` (fractional indexing).
 *
 * `lower` empty means "before every sibling". Reordering therefore rewrites the
 * one page that moved, never its siblings — which matters because
 * DistributedTable has no multi-item transaction, so a rewrite of the whole
 * sibling list could not be atomic.
 *
 * Returns `null` when the arguments are not strictly ordered, which happens
 * only if the caller read a stale sibling list. The caller appends instead.
 */
export function between(lower: string, upper: string): string | null {
  if (lower >= upper) return null;
  let prefix = '';
  // `tight` tracks whether `prefix` still matches `upper` digit for digit. Once
  // a digit below `upper`'s is taken, `upper` stops bounding the rest, and any
  // suffix stays below it. While it does still match, running past the end of
  // `upper` means `prefix` *is* `upper`, and every extension of it is greater —
  // so there is no room, and the caller falls back rather than being handed a
  // position that sorts on the wrong side.
  let tight = true;
  for (let i = 0; ; i++) {
    const low = i < lower.length ? DIGITS.indexOf(lower[i]!) : -1;
    const high = !tight
      ? DIGITS.length
      : i < upper.length
        ? DIGITS.indexOf(upper[i]!)
        : -1;
    if (high < 0) return null;
    if (low + 1 < high) return prefix + DIGITS[Math.floor((low + high) / 2)];
    const digit = i < lower.length ? lower[i]! : '0';
    if (digit !== upper[i]) tight = false;
    prefix += digit;
  }
}

/** Strip the `KIND#` prefix off a key segment. */
export const idOf = (key: string) => key.slice(key.indexOf('#') + 1);

/** Sort keys are compared byte-wise, so listings fold case up front. */
export const sortable = (value: string) => value.toLowerCase();

// ─── Seeded administrator identifiers ────────────────────────────────────────
// Fixed ids so seeding is idempotent: re-running it writes the same keys. Shared
// by `scripts/seed-admin.ts`, which writes these records, and by the guards in
// `index.ts` that refuse to leave the Wiki without an administrator.
export const SYSTEM_ADMIN_USER_GROUP = 'ug_admins';
export const SYSTEM_ADMIN_ROLE_GROUP = 'rg_global_admin';
