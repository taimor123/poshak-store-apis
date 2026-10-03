import { env } from '../config/env.js';
import { logger, maskEmail } from '../logger.js';

/**
 * Transactional email (ORDER_LIFECYCLE.md §Notifications matrix). Sends via
 * Resend when RESEND_API_KEY is set, otherwise logs the message (dev/test).
 * Fire-and-forget with retry — an email failure never fails an order.
 */

export type Email = { to: string; subject: string; text: string };

const formatPKR = (paisa: number) => `PKR ${Math.round(paisa / 100).toLocaleString('en-US')}`;
const outbox: Email[] = [];

/** Tests: inspect what would have been sent. */
export const sentEmails = () => [...outbox];
export const clearSentEmails = () => void outbox.splice(0);

async function deliver(mail: Email) {
  const key = env().RESEND_API_KEY;
  if (!key) {
    outbox.push(mail);
    if (outbox.length > 200) outbox.shift();
    logger.info({ to: maskEmail(mail.to), subject: mail.subject }, 'email (not sent: RESEND_API_KEY unset)');
    if (env().NODE_ENV === 'development') logger.debug({ body: mail.text }, 'email body');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env().EMAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}`);
}

/** Queue an email: 3 attempts with exponential backoff, then log and give up. */
export function send(mail: Email) {
  void (async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await deliver(mail);
        return;
      } catch (err) {
        if (attempt === 3) logger.error({ err, to: maskEmail(mail.to), subject: mail.subject }, 'email failed after 3 attempts');
        else await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      }
    }
  })();
}

// ─── Templates ──────────────────────────────────────────────────────────────

type OrderMail = { orderNo: string; email: string; name: string; totalPaisa: number; trackUrl: string; courier?: string | null; trackingNo?: string | null; reason?: string | null };

const sign = '\n\nShukriya,\nPoshak';

export const orderEmails = {
  placed: (o: OrderMail) =>
    send({
      to: o.email,
      subject: `Order ${o.orderNo} placed`,
      text: `Assalam o alaikum ${o.name},\n\nYour order ${o.orderNo} is placed. We’ll confirm it on WhatsApp within 12 hours.\nPlease keep ${formatPKR(o.totalPaisa)} ready in cash for the rider.\n\nTrack your order: ${o.trackUrl}${sign}`,
    }),
  confirmed: (o: OrderMail) =>
    send({ to: o.email, subject: `Order ${o.orderNo} confirmed`, text: `${o.name}, your order ${o.orderNo} is confirmed and being prepared.\n\nTrack: ${o.trackUrl}${sign}` }),
  shipped: (o: OrderMail) =>
    send({
      to: o.email,
      subject: `Order ${o.orderNo} is on its way`,
      text: `${o.name}, your order ${o.orderNo} has been handed to ${o.courier}. Tracking number: ${o.trackingNo}.\nKeep ${formatPKR(o.totalPaisa)} ready for the rider.\n\nTrack: ${o.trackUrl}${sign}`,
    }),
  delivered: (o: OrderMail & { returnWindowDays: number }) =>
    send({
      to: o.email,
      subject: `Order ${o.orderNo} delivered`,
      text: `${o.name}, your order ${o.orderNo} was delivered. If anything isn’t right, you can return it within ${o.returnWindowDays} days.${sign}`,
    }),
  cancelled: (o: OrderMail) =>
    send({ to: o.email, subject: `Order ${o.orderNo} cancelled`, text: `${o.name}, your order ${o.orderNo} has been cancelled.${o.reason ? ` Reason: ${o.reason}.` : ''}${sign}` }),
  returnDecision: (o: OrderMail & { approved: boolean; note: string }) =>
    send({
      to: o.email,
      subject: `Your return for ${o.orderNo}`,
      text: o.approved
        ? `${o.name}, your return for ${o.orderNo} is approved. We’ll message you on WhatsApp to arrange the pickup.${sign}`
        : `${o.name}, we couldn’t accept the return for ${o.orderNo}: ${o.note}${sign}`,
    }),
  refunded: (o: OrderMail & { amountPaisa: number }) =>
    send({ to: o.email, subject: `Refund for ${o.orderNo}`, text: `${o.name}, we’ve issued a refund of ${formatPKR(o.amountPaisa)} for order ${o.orderNo}.${sign}` }),
};

export const accountEmails = {
  passwordReset: (to: string, url: string) =>
    send({ to, subject: 'Reset your Poshak password', text: `Use this link to set a new password. It expires in 30 minutes and works once.\n\n${url}\n\nIf you didn’t ask for this, you can ignore this email.${sign}` }),
  passwordChanged: (to: string, resetUrl: string) =>
    send({ to, subject: 'Your Poshak password was changed', text: `Your password was just changed. If this wasn’t you, reset it now: ${resetUrl}${sign}` }),
};

export const adminEmails = {
  newOrder: (to: string, orderNo: string, totalPaisa: number) => send({ to, subject: `New order ${orderNo}`, text: `New COD order ${orderNo} for ${formatPKR(totalPaisa)}.` }),
};
