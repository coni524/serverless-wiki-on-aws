/**
 * The settings screen: where the deployment is named, and where sign-in happens.
 *
 * Two values have to be typed in — the Wiki's address and the app client id —
 * because neither can be discovered. Everything else about the authorization
 * server the plugin reads from the Wiki itself (`auth.ts`).
 */
import { App, Notice, PluginSettingTab, Setting } from 'obsidian';

import type { SpaceSummary } from './api';
import { AuthError } from './auth';
import { t } from './i18n';
import type SlWikiPlugin from './main';
import { describeReport } from './report';

export class SlWikiSettingTab extends PluginSettingTab {
  /** The spaces last fetched for the picker; null until they are asked for. */
  private spaces: SpaceSummary[] | null = null;

  /** Whether the fetch below has been tried, so it happens once and not per redraw. */
  private asked = false;

  constructor(
    app: App,
    private readonly plugin: SlWikiPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName(t.connectionHeading).setHeading();

    new Setting(containerEl)
      .setName(t.wikiUrlName)
      .setDesc(t.wikiUrlDesc)
      .addText((text) =>
        text
          .setPlaceholder('https://example.cloudfront.net')
          .setValue(this.plugin.settings.wikiUrl)
          .onChange(async (value) => {
            this.plugin.settings.wikiUrl = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t.clientIdName)
      .setDesc(t.clientIdDesc)
      .addText((text) =>
        text
          .setPlaceholder(t.clientIdPlaceholder)
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName(t.signInHeading).setHeading();

    new Setting(containerEl)
      .setName(t.signInStatusName)
      .setDesc(this.describeSignIn())
      .addButton((button) => {
        if (this.plugin.auth.signedIn) {
          button
            .setButtonText(t.signOutButton)
            .setWarning()
            .onClick(async () => {
              await this.run(button.buttonEl, async () => {
                await this.plugin.auth.signOut();
                // What the previous account could read says nothing about the
                // next one, and the fetch above runs again once it signs in.
                this.spaces = null;
                this.asked = false;
                new Notice(t.signedOutNotice);
              });
            });
          return;
        }
        button
          .setButtonText(t.signInButton)
          .setCta()
          .onClick(async () => {
            await this.run(button.buttonEl, async () => {
              await this.plugin.auth.beginSignIn();
              new Notice(t.signInInBrowser);
            });
          });
      });

    new Setting(containerEl)
      .setName(t.checkConnectionName)
      .setDesc(t.checkConnectionDesc)
      .addButton((button) =>
        button.setButtonText(t.checkConnectionButton).onClick(async () => {
          await this.run(button.buttonEl, async () => {
            const spaces = await this.plugin.api.listSpaces();
            new Notice(
              spaces.length === 0
                ? t.connectedNoSpaces
                : t.connectedSpaces(
                    spaces.map((space) =>
                      t.spaceWithPermission(space.name, space.permission ?? t.unknownPermission),
                    ),
                  ),
              10_000,
            );
          });
        }),
      );

    this.displaySync(containerEl);

    const warning = containerEl.createDiv({ cls: 'slwiki-warning' });
    warning.createEl('strong', { text: t.tokenWarningTitle });
    warning.createSpan({ text: t.tokenWarningBody });
  }

  /**
   * The sync section: which spaces are mirrored, how often, and how it went.
   *
   * The picker is filled on request rather than on open. Drawing it would
   * otherwise put a network call behind opening the settings, which is also
   * where a user goes to fix the address that call would fail on.
   */
  private displaySync(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t.syncHeading).setHeading();

    const selected = new Set(this.plugin.settings.syncedSpaceIds);
    new Setting(containerEl)
      .setName(t.syncedSpacesName)
      .setDesc(t.syncedSpacesDesc(selected.size))
      .addButton((button) =>
        button.setButtonText(t.fetchSpacesButton).onClick(async () => {
          await this.run(button.buttonEl, async () => {
            this.spaces = await this.plugin.api.listSpaces();
            if (this.spaces.length === 0) new Notice(t.noReadableSpaces);
          });
        }),
      );

    // A chosen space is known by its id alone until the list arrives, and an id
    // is not a name. Reloading Obsidian empties the list, so this screen asks
    // for it when it opens rather than waiting for the button. A failure is
    // left to the button: retrying on every redraw would put a signed-out or
    // unreachable Wiki through the same refusal again and again.
    if (this.spaces === null && !this.asked && this.plugin.auth.signedIn) {
      this.asked = true;
      void this.plugin.api
        .listSpaces()
        .then((spaces) => {
          this.spaces = spaces;
          this.refresh();
        })
        .catch(() => undefined);
    }

    // Ids chosen in an earlier session are shown even before the list is
    // fetched, so a space that has since become unreadable can still be
    // unchecked here instead of failing quietly in every cycle.
    const shown: { spaceId: string; name: string; permission?: string }[] = [
      ...(this.spaces ?? []),
      ...[...selected]
        .filter((spaceId) => !(this.spaces ?? []).some((space) => space.spaceId === spaceId))
        .map((spaceId) => ({ spaceId, name: t.spaceNotListed(spaceId) })),
    ];
    const deleting = new Set(this.plugin.settings.pushDeleteSpaceIds);
    for (const space of shown) {
      const twoWay = space.permission === 'write' || space.permission === 'admin';
      new Setting(containerEl)
        .setName(space.name)
        .setDesc(
          space.permission === undefined
            ? t.spaceUnknownDesc
            : t.spaceDesc(space.permission, twoWay),
        )
        .addToggle((toggle) =>
          toggle.setValue(selected.has(space.spaceId)).onChange(async (value) => {
            const kept = this.plugin.settings.syncedSpaceIds.filter((id) => id !== space.spaceId);
            this.plugin.settings.syncedSpaceIds = value ? [...kept, space.spaceId] : kept;
            await this.plugin.saveSettings();
            // Redrawn so that the deletion switch below appears with the space
            // it belongs to, instead of at the next visit to this screen.
            this.display();
          }),
        );

      // Offered per space, and only for one that is actually mirrored both
      // ways. Deleting a page in the Wiki is not the same size of decision as
      // unchecking a space: it reaches the reclamation job and the bodies in
      // S3, and no cycle can undo it.
      if (!selected.has(space.spaceId) || !twoWay) continue;
      new Setting(containerEl)
        // The switch belongs to the space above it, and the indent is the only
        // thing that says so. It is a class rather than a character in the
        // name, because a box-drawing character and a full-width space line up
        // in Japanese and not in English.
        .setClass('slwiki-sub-setting')
        .setName(t.pushDeleteName)
        .setDesc(t.pushDeleteDesc)
        .addToggle((toggle) =>
          toggle.setValue(deleting.has(space.spaceId)).onChange(async (value) => {
            const kept = this.plugin.settings.pushDeleteSpaceIds.filter(
              (id) => id !== space.spaceId,
            );
            this.plugin.settings.pushDeleteSpaceIds = value ? [...kept, space.spaceId] : kept;
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName(t.intervalName)
      .setDesc(t.intervalDesc)
      .addText((text) =>
        text
          .setPlaceholder('5')
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const minutes = Number.parseInt(value, 10);
            if (Number.isNaN(minutes) || minutes < 0) return;
            this.plugin.settings.syncIntervalMinutes = minutes;
            await this.plugin.saveSettings();
            this.plugin.restartTimer();
          }),
      );

    new Setting(containerEl)
      .setName(t.syncNowName)
      .setDesc(this.describeLastSync())
      .addButton((button) =>
        button.setButtonText(t.syncNowButton).onClick(async () => {
          await this.run(button.buttonEl, async () => {
            await this.plugin.runSync('manual');
          });
        }),
      );

    new Setting(containerEl)
      .setName(t.forgetName)
      .setDesc(t.forgetDesc)
      .addButton((button) =>
        button
          .setButtonText(t.forgetButton)
          .setWarning()
          .onClick(async () => {
            await this.run(button.buttonEl, async () => {
              await this.plugin.state.ensureLoaded();
              this.plugin.state.forget();
              await this.plugin.state.save();
              new Notice(t.forgotNotice);
            });
          }),
      );
  }

  private describeLastSync(): string {
    const last = this.plugin.sync.last;
    if (last === null) return t.noSyncYet;
    return t.lastSync(new Date(last.at).toLocaleString(), describeReport(last.report));
  }

  /** Redraw, so a sign-in finishing in the browser is visible when it returns. */
  refresh(): void {
    if (this.containerEl.childElementCount > 0) this.display();
  }

  private describeSignIn(): string {
    const { tokens, identity } = this.plugin.settings;
    if (tokens === null) return t.signedOutStatus;
    const who = identity === null || identity.username === '' ? t.unknownUser : identity.username;
    const scopes =
      identity === null || identity.scopes.length === 0 ? t.noScopes : identity.scopes.join(' ');
    return t.signedInStatus(who, scopes, new Date(tokens.expiresAt).toLocaleString());
  }

  /** Run a button's work with the button disabled, and report any failure. */
  private async run(button: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
    button.disabled = true;
    try {
      await work();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(error instanceof AuthError ? message : t.actionFailed(message), 10_000);
    } finally {
      button.disabled = false;
      this.refresh();
    }
  }
}
