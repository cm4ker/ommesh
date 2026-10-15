/**
 * The radio's Bluetooth PIN as typed: the firmware takes six digits that do
 * not start with 0 (100000 to 999999), or 0 for its own.
 */

export const PIN_DIGITS = 6;

/** Why typed digits are not yet a PIN: too few, or a 0 first, which the radio refuses. */
export type PinFault = "short" | "zero";

/** What was typed or pasted, down to its digits and no more than a PIN holds. */
export function pinDigits(text: string): string {
  return text.replace(/\D/g, "").slice(0, PIN_DIGITS);
}

export function pinFault(digits: string): PinFault | null {
  if (digits.startsWith("0")) return "zero";
  return digits.length < PIN_DIGITS ? "short" : null;
}
