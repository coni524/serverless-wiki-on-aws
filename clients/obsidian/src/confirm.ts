/**
 * A yes-or-no question in a modal, for the one decision the plugin will not
 * take on the user's behalf from the settings alone.
 */
import { type App, Modal, Setting } from 'obsidian';

import { t } from './i18n';

/** Ask before signing in at a new address under the old client id. */
export function confirmMove(app: App, from: string, to: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new Modal(app);
    const answer = (value: boolean): void => {
      if (answered) return;
      answered = true;
      resolve(value);
      modal.close();
    };
    modal.titleEl.setText(t.confirmMoveTitle);
    modal.contentEl.createEl('p', { text: t.confirmMoveBody(from, to) });
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText(t.confirmMoveNo).onClick(() => answer(false)))
      .addButton((button) =>
        button
          .setButtonText(t.confirmMoveYes)
          .setWarning()
          .onClick(() => answer(true)),
      );
    // Closing the dialog any other way is a no.
    modal.onClose = () => answer(false);
    modal.open();
  });
}
