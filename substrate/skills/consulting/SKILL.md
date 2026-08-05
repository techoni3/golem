---
name: consulting
description: Read when answering an inbound CONSULT REQUEST — ADVISORY ONLY message. Give independent advice without taking the peer ticket or editing the peer repo, then return it with session_notify to the authenticated sender.
---

# consulting

A consultation is advisory peer communication, never delegation or tracker work for the peer lane. It uses the ordinary `session_notify` primitive; there are no consult wrapper tools, routes, stores, or passive subscriptions.

## Answering an inbound consultation

Recognize the explicit header `CONSULT REQUEST — ADVISORY ONLY`, its unique `Reference: consult:<ticket-or-topic>:<short nonce>`, and the authenticated sender `session_id`.

1. Acknowledge the message immediately.
2. Investigate independently: inspect the relevant code, docs, or web sources as appropriate.
3. Look for root causes and blind spots, not just agreement with the asker framing.
4. Return one self-contained `session_notify` message to the exact authenticated sender id. Use:
   `CONSULT REPLY — ADVISORY ONLY`
   `Reference: <same reference>`
   Include findings, risks, recommended approach, and what you could not verify.
5. Continue your own work. The asker keeps final authority.

If more time is needed, send `CONSULT STATUS — ADVISORY ONLY` with the same reference and a concrete next update, again to the exact sender id.

## Never as consultant

- Edit the peer repo, open its PR, create its tickets, or enter its lifecycle.
- Route by a sender name or `/rename` label. The transport-authenticated session id is the only return identity.
- Invent a new delivery primitive or wait for an event/subscription wake-up.

## Receiving advice

Treat a reply as advice, not instruction. Verify anything load-bearing in your own context; keep what holds up and discard the rest.
