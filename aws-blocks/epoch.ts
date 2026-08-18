/**
 * The generation of the permission graph as a whole.
 *
 * One record carries it. Every authorized request reads it, and a resolved
 * answer held in an execution environment is reused only while the generation
 * it was resolved under still matches (see `access.ts`). So anything that
 * changes who may reach what has to move it afterwards.
 *
 * This lives on its own rather than inside `access.ts` because two callers need
 * it and they must not import each other: `access.ts` reads it on every
 * request, and `federation.ts` moves it when an external IdP's claims change a
 * user's role groups. A second copy of either function would be an
 * authorization mechanism maintained in two places.
 */
import { table } from './resources.js';
import { CONFIG_EPOCH, CONFIG_PK } from './model.js';

/**
 * The current generation, or `null` when it could not be read.
 *
 * This one read sits in front of every authorized request, so a failure here
 * must not be a failure of the request. `null` means "no generation to compare
 * against": the caller skips the stored answer and resolves all three hops,
 * which is what every request did before the cache existed. The check is never
 * loosened — an answer is still only reused when a generation was read and it
 * matched — so a degraded read costs queries and never permissions.
 *
 * If the table is unreachable rather than this key, the hops fail on their own
 * and the request fails there, which is the fail-closed outcome.
 */
export async function readEpoch(): Promise<string | null> {
  try {
    const item = await table.get({ pk: CONFIG_PK, sk: CONFIG_EPOCH });
    // No record yet is a generation of its own, so a fresh deployment does not
    // have to write one before anybody can be authorized.
    return item?.epoch ?? '';
  } catch (reason) {
    console.warn('[sl-wiki] Could not read the permission epoch; resolving in full.', reason);
    return null;
  }
}

/**
 * Move the permission graph to a new generation.
 *
 * Called at the end of every method that writes or removes a permission edge or
 * a role group. The value is opaque — compared only for equality — so
 * a last-writer-wins `put` is enough, and no counter has to be read,
 * incremented, and written back under an optimistic lock.
 */
export async function bumpEpoch(): Promise<void> {
  await table.put({
    pk: CONFIG_PK,
    sk: CONFIG_EPOCH,
    type: 'EPOCH',
    epoch: `${new Date().toISOString()}#${crypto.randomUUID()}`,
  });
}
