// INR <-> paise conversion without floating-point arithmetic. The DB stores rupees as NUMERIC(10,2)
// (pg hands it back as a decimal string, e.g. "999.00"); PhonePe speaks integer paise. Every
// conversion parses the decimal text directly — never Number(x) * 100, which turns 1.15 into
// 114.99999999999999.

const INR_DECIMAL = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

/** Parses a rupee amount ("999", "999.5", "999.50", or a number that prints as such) into integer
 *  paise. Throws on anything ambiguous — more than 2 decimals, negatives, exponents, or a float
 *  with representation noise such as 0.1 + 0.2 — rather than silently rounding money. */
export function inrToPaise(value: string | number): number {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = INR_DECIMAL.exec(text);
  if (!match) {
    throw new Error('Invalid INR amount');
  }
  const rupees = Number.parseInt(match[1], 10);
  const fraction = Number.parseInt((match[2] ?? '').padEnd(2, '0'), 10);
  return rupees * 100 + fraction;
}

/** Integer paise -> canonical two-decimal rupee string ("99900" -> "999.00"). */
export function paiseToInr(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) {
    throw new Error('Invalid paise amount');
  }
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}
