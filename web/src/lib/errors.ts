import { BaseError } from "viem";

/**
 * Turns any thrown value into a concise, user-facing message. viem/wagmi
 * errors carry a `shortMessage` (e.g. the revert reason) that is far more
 * useful than the multi-paragraph `message`; plain Errors fall back to their
 * message, and anything else is stringified. Never surfaces a raw stack.
 */
export function toUserMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}
