/**
 * The `obsidian` module, as far as the sync engine is concerned.
 *
 * The published `obsidian` package is types and nothing else (`"main": ""`), so
 * the plugin's own code cannot be loaded outside Obsidian without something
 * standing in its place at runtime. `pnpm run test` bundles the tests with
 * esbuild and aliases `obsidian` to this file, which is why the classes here
 * have to be the same objects the engine's `instanceof` checks see.
 *
 * Only what the engine touches is here. The vault itself is `vault.ts`.
 */
export class TAbstractFile {
  path = '';
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  get name(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }

  get extension(): string {
    return this.name.slice(this.name.lastIndexOf('.') + 1);
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

/** Reached only by `api.ts`, which these tests replace outright. */
export const requestUrl = async (): Promise<never> => {
  throw new Error('requestUrl is not available in the tests');
};

/**
 * What `i18n.ts` asks for the language on screen. There is no screen here, and
 * the tests read the English half, so this reports what Obsidian would report
 * with no locale loaded.
 */
export const moment = { locale: (): string => 'en' };

export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export class Plugin {}
