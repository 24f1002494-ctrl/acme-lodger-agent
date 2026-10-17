# Acme Appliances Ledger Agent

A Vercel serverless API for the Acme Appliances order-ledger challenge.

## Endpoint

POST `/api`

Request:

```json
{"question":"What is the revenue for ...?"}
```

Response:

```json
{"answer":"12345"}
```

## Environment variables

Set these in Vercel:

- `QUIZ_EMAIL` — the email used in the challenge URL.
- `QUIZ_SIGN` — the quiz signature from the challenge URL.

Do not put the real signature in GitHub or source files.

## Deploy

Import this folder/repository into Vercel, then add the two variables under:

Project → Settings → Environment Variables

Enable them for Production (and Preview if you want to test preview deployments), then redeploy.

## Data handling

The function reads `/export` first and falls back to paginated `/orders`.

It follows the challenge rules:

- Asia/Kolkata business dates
- latest `updated_at` row is current when an order ID appears more than once
- only `paid` orders count as revenue

The upstream data is cached in the warm Vercel function instance for five minutes.
