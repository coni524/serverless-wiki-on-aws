/**
 * The sl-wiki sync plugin for Obsidian.
 *
 * The plugin signs in, and it keeps the spaces the user chose and the vault
 * saying the same thing. Each cycle sends what changed in the vault and then
 * fetches what changed in the Wiki, in that order. Where both changed, the Wiki
 * wins and the local text is kept beside it as a conflict copy.
 *
 * Deleting a note is the one local change that is not sent by default: deleting
 * a page in the Wiki reaches the reclamation job and the bytes behind it, so
 * that is enabled per space or not at all.
 *
 * A cycle runs when the vault finishes loading, on a timer, and on command.
 */
import { Notice, Plugin, type TAbstractFile } from 'obsidian';

import { SyncApi } from './api';
import { AuthClient, PROTOCOL_ACTION } from './auth';
import { t } from './i18n';
import { describeReport, worthReporting } from './report';
import { DEFAULT_SETTINGS, type SlWikiSettings } from './settings';
import { SlWikiSettingTab } from './settings-tab';
import { SyncStateStore } from './state';
import { SyncEngine } from './sync';

export default class SlWikiPlugin extends Plugin {
  // `Plugin` declares `settings?: unknown` for exactly this; narrowing it here
  // is what lets the settings tab and the auth client read it with a type.
  override settings: SlWikiSettings = { ...DEFAULT_SETTINGS };
  auth!: AuthClient;
  api!: SyncApi;
  sync!: SyncEngine;
  state!: SyncStateStore;
  private settingTab!: SlWikiSettingTab;
  private timer: number | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.settingTab = new SlWikiSettingTab(this.app, this);
    this.auth = new AuthClient(this, () => this.settingTab.refresh());
    this.api = new SyncApi(this, this.auth);
    this.state = new SyncStateStore(
      this.app.vault.adapter,
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
    );
    this.sync = new SyncEngine(this.app, this.api, this.state, () => ({
      spaceIds: this.settings.syncedSpaceIds,
      deleteSpaceIds: this.settings.pushDeleteSpaceIds,
    }));
    this.addSettingTab(this.settingTab);

    // Renaming or dragging a note in Obsidian is the user saying the page has a
    // new title or a new parent, and this is the only place that is announced:
    // the next cycle sees a note where the record did not put it, and sends the
    // difference. Without this the file would simply be missing from where the
    // record says, and the cycle would put a copy of the page back beside it.
    this.registerEvent(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        void this.followRename(oldPath, file.path);
      }),
    );

    // Registered for the life of the plugin, not just while a sign-in is in
    // flight. Obsidian dispatches by action name and a handler cannot be added
    // and removed around the browser round trip without a window where the
    // redirect would arrive at nothing. What makes that safe is the `state`
    // check inside the handler: anything on this machine can ask the OS to open
    // `obsidian://slwiki-auth`, and only a code answering a sign-in this plugin
    // started is acted on (`auth.ts`).
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
      void this.completeSignIn(params);
    });

    this.addCommand({
      id: 'sign-in',
      name: t.commandSignIn,
      callback: () => {
        void this.report(async () => {
          await this.auth.beginSignIn();
          new Notice(t.signInInBrowser);
        });
      },
    });

    this.addCommand({
      id: 'check-connection',
      name: t.commandCheckConnection,
      callback: () => {
        void this.report(async () => {
          const spaces = await this.api.listSpaces();
          new Notice(t.connectedSpaceCount(spaces.length));
        });
      },
    });

    this.addCommand({
      id: 'sync-now',
      name: t.commandSyncNow,
      callback: () => {
        void this.runSync('manual');
      },
    });

    this.restartTimer();
    // Not during `onload`: the vault's file index is still being built, and the
    // engine asks it where every note is.
    this.app.workspace.onLayoutReady(() => {
      void this.runSync('auto');
    });
  }

  override onunload(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Run a cycle, and say as much about it as the occasion calls for.
   *
   * A cycle asked for by hand always answers, including "nothing changed". A
   * cycle nobody asked for speaks only when it did something, so that a mirror
   * of an idle Wiki is silent.
   */
  async runSync(trigger: 'manual' | 'auto'): Promise<void> {
    if (this.sync.busy) {
      if (trigger === 'manual') new Notice(t.syncAlreadyRunning);
      return;
    }
    if (!this.auth.signedIn || this.settings.syncedSpaceIds.length === 0) {
      if (trigger === 'manual') {
        new Notice(this.auth.signedIn ? t.noSpacesSelected : t.notSignedIn);
      }
      return;
    }

    try {
      const report = await this.sync.run();
      if (trigger === 'manual' || worthReporting(report)) {
        new Notice(
          t.syncDone(describeReport(report)),
          report.failures.length > 0 ? 15_000 : 6_000,
        );
      }
    } catch (error: unknown) {
      new Notice(t.syncFailed(describe(error)), 15_000);
    } finally {
      this.settingTab.refresh();
    }
  }

  /** Put the automatic cycle on the interval the settings now say. */
  restartTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    const minutes = this.settings.syncIntervalMinutes;
    if (minutes <= 0) return;
    this.timer = window.setInterval(() => void this.runSync('auto'), minutes * 60_000);
    this.registerInterval(this.timer);
  }

  /**
   * Follow a rename in the record, and write it down straight away.
   *
   * Not during a cycle: the moves a cycle makes are already recorded by the
   * engine as it makes them, and taking them a second time here would fight
   * with the very bookkeeping that is in progress. A rename the user manages to
   * make in that window is caught by the reunion in `push.ts` instead.
   */
  private async followRename(from: string, to: string): Promise<void> {
    if (this.sync.busy) return;
    try {
      await this.state.ensureLoaded();
      if (this.state.trackRename(from, to)) await this.state.save();
    } catch (error: unknown) {
      new Notice(t.recordUpdateFailed(describe(error)), 10_000);
    }
  }

  /** Finish the round trip the browser started. */
  private async completeSignIn(params: Record<string, string | undefined>): Promise<void> {
    await this.report(async () => {
      await this.auth.handleCallback(params);
      new Notice(t.signedInNotice);
    });
  }

  /** Run something whose failure is the user's to read, not the console's. */
  private async report(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error: unknown) {
      new Notice(describe(error), 10_000);
    }
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
