/**
 * Whether a key press is the user pressing that key, rather than a step of an
 * IME (input method editor) conversion.
 *
 * Japanese input confirms a conversion candidate with Enter, and the browser
 * reports that press as an ordinary `keydown` on the way. A handler that submits
 * on Enter would therefore submit a title the user is still composing. Presses
 * inside a conversion carry `isComposing`; the Enter that closes the conversion
 * is not reported consistently across browsers, but it still carries the legacy
 * `keyCode` 229 that means "the IME handled this", so both are checked.
 */
export function isTypedKey(detail: { isComposing: boolean; keyCode: number }): boolean {
  return !detail.isComposing && detail.keyCode !== 229;
}
