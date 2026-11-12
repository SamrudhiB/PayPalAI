// Payment ledger: the only place that decides whether a milestone counts as paid.
// Pure and dependency-free so every rule is unit-tested without a network.
//
// States only move forward: pending -> approved -> paid. A failed capture is its own state.
// A late or repeated event can never move a payment backwards.

const RANK = { pending: 0, approved: 1, paid: 2 };
const EVENT_STATE = {
  'CHECKOUT.ORDER.APPROVED': 'approved',
  'PAYMENT.CAPTURE.COMPLETED': 'paid',
  'PAYMENT.CAPTURE.DENIED': 'failed',
  'PAYMENT.CAPTURE.DECLINED': 'failed',
};

// expected: optional { paymentId: amountInUsd }. A capture whose amount or currency differs never counts as paid.
export function createLedger(paymentIds, { now = () => new Date().toISOString(), expected = {} } = {}) {
  const known = new Set(paymentIds);
  const state = Object.fromEntries(paymentIds.map((id) => [id, 'pending']));
  const seen = new Set();
  const audit = [];
  const log = (kind, detail, extra = {}) => audit.unshift({ at: now(), kind, detail, ...extra });

  function requested(paymentId, orderId) {
    log('payment_requested', `PayPal payment link created for ${paymentId}`, { paymentId, orderId });
  }

  // verification: 'SUCCESS' | anything else (rejected). Returns what the server should answer and whether the schedule may change.
  function receive(event, verification) {
    const type = event?.event_type ?? 'unknown';
    const customId = event?.resource?.custom_id ?? null;
    const base = { eventId: event?.id ?? null, type, paymentId: customId };

    if (event?.id && seen.has(event.id)) return { status: 200, outcome: 'duplicate', changed: false };
    if (event?.id) seen.add(event.id);

    if (verification !== 'SUCCESS') {
      log('event_rejected', `${type} rejected: signature check returned ${verification}`, base);
      return { status: 400, outcome: 'rejected', changed: false };
    }
    log('signature_verified', `${type} signature verified`, base);

    if (!customId || !known.has(customId)) {
      log('event_ignored', `${type} is not linked to any milestone`, base);
      return { status: 200, outcome: 'ignored', changed: false };
    }
    const next = EVENT_STATE[type];
    if (next === 'paid' && customId in expected) {
      const amt = event.resource?.amount;
      if (!amt || Number(amt.value) !== expected[customId] || (amt.currency_code && amt.currency_code !== 'USD')) {
        log('event_rejected', `${type} for ${customId} has the wrong amount (${amt?.value ?? 'none'} ${amt?.currency_code ?? ''}, expected ${expected[customId]} USD)`, base);
        return { status: 200, outcome: 'amount_mismatch', changed: false };
      }
    }
    if (!next) {
      log('event_ignored', `${type} does not change a payment`, base);
      return { status: 200, outcome: 'ignored', changed: false };
    }
    const current = state[customId];
    if (current === 'paid') {
      log('event_ignored', `${type} arrived after ${customId} was already paid`, base);
      return { status: 200, outcome: 'stale', changed: false };
    }
    if (next !== 'failed' && current !== 'failed' && RANK[next] <= RANK[current]) {
      log('event_ignored', `${type} is older than the current state (${current})`, base);
      return { status: 200, outcome: 'stale', changed: false };
    }
    state[customId] = next;
    log('payment_state', `${customId}: ${current} to ${next}`, { ...base, from: current, to: next });
    if (next === 'paid') log('schedule_recalculated', `${customId} is paid, dependent work is unblocked`, base);
    return { status: 200, outcome: 'applied', changed: true, paymentId: customId, state: next };
  }

  function decision(kind, detail) { log(kind, detail); }

  return { requested, receive, decision, state: () => ({ ...state }), audit: () => audit.slice(0, 200) };
}
