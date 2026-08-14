/**
 * The authenticator-enrolment panel, drawn into the block's own sign-in form.
 *
 * The pool requires MFA and offers one factor, so a user who has enrolled
 * nothing meets a TOTP setup challenge on their first sign-in. Cognito issues a
 * shared secret for that challenge and the auth block carries it down to the
 * form — but as a field of type `hidden`, and the block's renderer puts a
 * `hidden` field into an `<input type="hidden">`. The screen therefore asks for
 * a six-digit code while showing nothing to generate one from, which no reader
 * can answer.
 *
 * `AuthFieldOverride.render` is the seam the block leaves for exactly this: it
 * hands over the field and takes back a node, on the one condition that the node
 * contains an `<input name="sharedSecret">` for the submit to read. So the
 * secret is drawn here — as a QR code to scan and as text to type — and the
 * required input rides along inside the same node.
 *
 * The override is keyed by field name, and the block ignores names an action did
 * not emit. `sharedSecret` exists on the setup step alone, so nothing here
 * reaches the plain "enter your code" challenge that every later sign-in shows.
 */
import qrcode from 'qrcode-generator';
import type { Authenticator } from '@aws-blocks/blocks/ui';

import { readStoredLocale } from '@/lib/i18n';
import { messages } from '@/lib/i18n/dict';

/**
 * The options `Authenticator` takes, read off the function itself.
 *
 * `@aws-blocks/blocks/ui` re-exports the component but not the type, and the
 * package that declares it is a transitive dependency this app does not name.
 */
type AuthenticatorOptions = NonNullable<Parameters<typeof Authenticator>[1]>;
type FieldRenderContext = Parameters<
  NonNullable<NonNullable<NonNullable<AuthenticatorOptions['actions']>[string]['fields']>[string]['render']>
>[0];

/** What an authenticator app files the account under. */
const ISSUER = 'sl-wiki';

/**
 * Error correction level M and an automatic version.
 *
 * `0` lets the encoder pick the smallest version that holds the URI, which is
 * around 110 characters here — a Cognito secret is 52 Base32 characters and the
 * rest is the label. M tolerates a fifth of the code being obscured, which is
 * the usual choice for a code read off a screen rather than off paper.
 */
const QR_TYPE = 0;
const QR_ECC = 'M';

/** Side of one QR module in CSS pixels, and the quiet zone in modules. */
const MODULE_PX = 5;
const QUIET_MODULES = 4;

/**
 * The address last typed into the sign-in form.
 *
 * An authenticator app shows the label from the URI, and a label naming only
 * the Wiki is indistinguishable from every other account on it. The address is
 * not in the challenge — the block's state carries a user only once signed in —
 * so it is taken from the form on the way past. Empty is fine: the URI then
 * carries the issuer alone, which is what a reader who arrived some other way
 * would see anyway.
 */
let typedUsername = '';

/**
 * Record the address as it is typed, for the label above.
 *
 * Listening on the container rather than the input, in the capture phase,
 * because the block replaces the whole form on every state change and a listener
 * bound to one input would not survive the first submit.
 */
export function watchTypedUsername(container: HTMLElement): () => void {
  const onInput = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.name === 'username') {
      typedUsername = target.value.trim();
    }
  };
  container.addEventListener('input', onInput, true);
  return () => container.removeEventListener('input', onInput, true);
}

/** What `Authenticator()` is given, so the setup step draws the panel above. */
export function authenticatorOptions(): AuthenticatorOptions {
  return {
    actions: {
      confirmSignIn: {
        fields: {
          sharedSecret: {
            render: ({ defaultValue }: FieldRenderContext) => enrolmentPanel(defaultValue ?? ''),
          },
          // Both the setup step and every later sign-in ask for the six digits.
          // The hint tells a password manager to offer the code it holds.
          code: { autocomplete: 'one-time-code' },
        },
      },
    },
  };
}

/**
 * The dictionary as it stands right now.
 *
 * Read at draw time rather than closed over: the language switcher sits in the
 * bar above this form, and the panel is built when the challenge arrives, which
 * is well after the form was mounted.
 */
function words() {
  return messages[readStoredLocale()].app;
}

function enrolmentPanel(secret: string): Node {
  const t = words();
  const panel = document.createElement('div');
  panel.style.cssText = 'display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px;';

  // The value the block submits. Present whether or not anything below drew,
  // so a secret this function could not render still completes the challenge.
  const echo = document.createElement('input');
  echo.type = 'hidden';
  echo.name = 'sharedSecret';
  echo.value = secret;
  panel.appendChild(echo);

  if (secret === '') {
    // Nothing to enrol from. Cognito always sends one, so this is the shape of
    // a block or pool change rather than of anything a reader did; saying so
    // beats an empty box above an input they cannot fill.
    panel.appendChild(paragraph(t.totpSecretMissing));
    return panel;
  }

  panel.appendChild(paragraph(t.totpScanIntro));
  panel.appendChild(qrImage(otpauthUri(secret), t.totpQrLabel));
  panel.appendChild(paragraph(t.totpTypeIntro));
  panel.appendChild(secretRow(secret, t.totpCopyKey, t.totpCopied));
  return panel;
}

/**
 * The `otpauth:` URI every authenticator app reads.
 *
 * The label is `issuer:account` per the de-facto scheme, and `issuer` repeats as
 * a parameter because apps disagree about which of the two they read.
 */
function otpauthUri(secret: string): string {
  const label = typedUsername === '' ? ISSUER : `${ISSUER}:${typedUsername}`;
  const query = new URLSearchParams({ secret, issuer: ISSUER });
  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}

/**
 * The URI as a QR code.
 *
 * Built as SVG elements rather than from the encoder's own markup string, so no
 * HTML is parsed out of a library and the colours are ours to set. They are
 * fixed black on white in both themes on purpose: a camera needs the contrast
 * the code was specified with, and a QR inverted for a dark background is one a
 * good many scanners refuse.
 */
function qrImage(uri: string, label: string): Node {
  const code = qrcode(QR_TYPE, QR_ECC);
  code.addData(uri);
  code.make();

  const count = code.getModuleCount();
  const side = (count + QUIET_MODULES * 2) * MODULE_PX;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${side} ${side}`);
  svg.setAttribute('width', String(side));
  svg.setAttribute('height', String(side));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);

  const quiet = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  quiet.setAttribute('width', String(side));
  quiet.setAttribute('height', String(side));
  quiet.setAttribute('fill', '#ffffff');
  svg.appendChild(quiet);

  // One path of many subpaths rather than one rect per module: a version-6 code
  // is over 1,700 modules, and that many elements is a slow thing to lay out.
  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!code.isDark(row, col)) continue;
      const x = (col + QUIET_MODULES) * MODULE_PX;
      const y = (row + QUIET_MODULES) * MODULE_PX;
      parts.push(`M${x} ${y}h${MODULE_PX}v${MODULE_PX}h-${MODULE_PX}z`);
    }
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', parts.join(''));
  path.setAttribute('fill', '#000000');
  svg.appendChild(path);

  const frame = document.createElement('div');
  frame.style.cssText = 'background: #ffffff; padding: 8px; width: max-content; border-radius: 4px;';
  frame.appendChild(svg);
  return frame;
}

/** The secret as text, in fours, beside a button that copies it whole. */
function secretRow(secret: string, copyLabel: string, copiedLabel: string): Node {
  const row = document.createElement('div');
  row.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;';

  const text = document.createElement('code');
  // Grouped for reading and for typing; the groups are display only, and the
  // button copies the secret as Cognito issued it.
  text.textContent = (secret.match(/.{1,4}/g) ?? [secret]).join(' ');
  text.style.cssText =
    'font-family: monospace; font-size: 14px; letter-spacing: 0.05em; user-select: all; word-break: break-all;';
  row.appendChild(text);

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = copyLabel;
  button.style.cssText = 'padding: 4px 10px; cursor: pointer;';
  button.addEventListener('click', () => {
    void navigator.clipboard.writeText(secret).then(
      () => {
        button.textContent = copiedLabel;
        window.setTimeout(() => {
          button.textContent = copyLabel;
        }, 2000);
      },
      () => {
        // Clipboard access can be refused, and the secret is on screen to
        // select by hand. Leaving the label alone says the copy did not happen.
      },
    );
  });
  row.appendChild(button);
  return row;
}

function paragraph(text: string): Node {
  const p = document.createElement('p');
  p.textContent = text;
  p.style.cssText = 'margin: 0; font-size: 14px;';
  return p;
}
