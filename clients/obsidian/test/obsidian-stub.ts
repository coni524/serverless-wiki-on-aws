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

/** What a test sees of one request, and what it answers with. */
export type StubRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
};
export type StubResponse = { status: number; text?: string; arrayBuffer?: ArrayBuffer };

/**
 * The network. Every request is recorded, and answered by `http.handler` when a
 * test sets one; with none set, a request is a test failure, which is what
 * the sync cases want — they replace `api.ts` outright.
 */
export const http: {
  handler: ((request: StubRequest) => StubResponse | Promise<StubResponse>) | null;
  requests: StubRequest[];
} = { handler: null, requests: [] };

export const requestUrl = async (request: StubRequest) => {
  http.requests.push(request);
  if (http.handler === null) throw new Error('requestUrl is not available in the tests');
  const response = await http.handler(request);
  return {
    status: response.status,
    text: response.text ?? '',
    arrayBuffer: response.arrayBuffer ?? new ArrayBuffer(0),
  };
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
