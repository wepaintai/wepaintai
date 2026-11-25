# Security, Performance, and Quality Improvement Backlog

Last reviewed: 2026-11-22

This document tracks the repository audit findings so work can continue across separate Codex sessions. Update the status, notes, and verification fields as each item progresses.

## Status and priority conventions

- Status: `TODO`, `IN PROGRESS`, `BLOCKED`, `DONE`, or `ACCEPTED RISK`.
- P0: exploitable security or billing issue; address before production exposure.
- P1: high-impact security, data integrity, reliability, or scalability issue.
- P2: important performance, maintainability, privacy, accessibility, or operational improvement.
- P3: documentation and general cleanup.

## Recommended execution order

1. Fix P0 token and payment exploits.
2. Centralize authorization and secure every public Convex function.
3. Make AI billing atomic and harden provider workflows.
4. Secure uploads and add storage lifecycle cleanup.
5. Remove duplicate subscriptions and make stroke loading scalable.
6. Add regression tests and CI gates.
7. Address deployment, privacy, accessibility, and maintainability debt.

---

## P0 — Critical

### AUD-001: Prevent arbitrary token minting

- Status: DONE
- Area: Billing / Convex security
- Files:
  - `convex/tokens.ts` (`consumeTokensForOperation`)
  - `convex/tokenPolicy.ts`
  - `convex/tokens.test.ts`
  - `convex/schema.ts`
- Problem: Public mutations accept a caller-supplied `tokenCost`. A negative value turns subtraction into an arbitrary balance credit.
- Required changes:
  - Make debit mutations internal-only.
  - Determine operation costs on the server; never accept cost or description from the client.
  - Validate all monetary/token values as finite positive integers.
  - Add an idempotency key per billed operation.
- Acceptance criteria:
  - Negative, zero, fractional, `NaN`, and excessive costs are rejected.
  - Clients cannot call a generic balance-changing mutation.
  - Duplicate operation IDs cannot be charged or credited twice.
  - Tests cover concurrent and malicious requests.
- Verification: `corepack pnpm test:run` PASS (6 tests); `corepack pnpm typecheck` PASS; `corepack pnpm build` PASS with the pre-existing large-chunk warning; targeted ESLint PASS with 0 errors and 9 pre-existing warnings in legacy AI provider files.
- Notes: Completed 2026-07-09. Removed all three public debit mutations and the public caller-supplied balance check. Added a fixed server price policy, an internal authenticated debit mutation, per-user operation idempotency keys/index, safe-integer balance validation, and guarded purchase credits. Updated Replicate, Gemini, background-removal, and image-merge callers. Added Vitest and `convex-test` coverage for the removed public endpoint, malicious cost fields, duplicate concurrent debits, authentication, insufficient balance, invalid/overflow credits, and duplicate purchase delivery. The optional `operationKey` schema field/index must be deployed with the Convex changes. Atomic pre-provider reservation remains tracked separately in AUD-006.

### AUD-002: Derive Polar package value server-side

- Status: DONE
- Area: Payments
- Files:
  - `convex/polar.ts`
  - `convex/polarPackages.ts`
  - `convex/polarWebhook.ts`
  - `convex/polar.test.ts`
  - `convex/schema.ts`
  - `src/components/TokenDisplay.tsx`
  - `.env.example`
  - `docs/POLAR_SETUP.md`
- Problem: Checkout accepts arbitrary `productId` and `tokens`, then credits the caller-supplied token quantity after payment.
- Required changes:
  - Accept a server-defined package key such as `small` or `large`.
  - Map package key to product ID, price, currency, and token amount on the server.
  - Validate webhook product, amount, currency, customer/user binding, and checkout status.
  - Store the validated server package rather than client metadata.
- Acceptance criteria:
  - A client cannot alter the product/token mapping.
  - A valid payment for one product can only grant that product's configured tokens.
  - Webhook replay and duplicate delivery are idempotent.
  - Tests cover mismatched product, amount, currency, and token metadata.
- Verification: `corepack pnpm test:run` PASS (2 files, 14 tests); `corepack pnpm typecheck` PASS; targeted ESLint PASS with 0 errors or warnings; targeted Prettier check PASS; `corepack pnpm build` PASS with the pre-existing large-chunk warning; `corepack pnpm audit --prod` PASS with no known vulnerabilities.
  - Notes: Completed 2026-07-09. `createCheckout` now accepts only the validated `50_tokens` or `125_tokens` package key. The server maps each key to a server-only Polar product ID plus a fixed token grant, expected amount, and currency; the public package query omits product IDs and environment variable names. Checkout creation no longer sends token or user metadata, disables discount codes, binds `external_customer_id` to the authenticated Convex user, and validates Polar's creation response before storing an authoritative package snapshot. Webhook completion validates the status, checkout ID, product, amount, currency, package snapshot, and external customer/user binding before an atomic token credit and purchase completion. Duplicate and concurrent deliveries return idempotently after one transaction. Tests cover both packages, unknown packages, forged client and stored token quantities, invalid products/amounts/currencies, unknown and incomplete checkouts, duplicate delivery, and cross-user attempts. `APP_URL` may override `SITE_URL` for isolated preview checkout return URLs; neither value is client-controlled.

  Deployment/configuration: deploy the Convex schema and functions, then set `POLAR_PRODUCT_ID_50`, `POLAR_PRODUCT_ID_125`, `POLAR_API_KEY`, `POLAR_WEBHOOK_SECRET`, `POLAR_API_BASE_URL`, and `SITE_URL` in every applicable Convex deployment. The Polar products must be one-time `usd` products priced at 499 and 999 cents respectively. No client `VITE_POLAR_*` or `VITE_APP_URL` values are used. The optional `packageKey` schema field preserves deploy compatibility with existing records; legacy pending purchases without a package key intentionally fail closed and require a new checkout or manual reconciliation. No deployment was performed as part of this change.

  Follow-up (2026-11-22): Tightened `convex/polarWebhook.ts` so tokens are credited only on settled `status === 'succeeded'` (unsettled `confirmed` events no longer grant tokens), pending purchases transition to `failed` on `failed`/`expired` webhooks, purchase deduplication writes/reads `operationKey` via `by_user_operation` (with legacy fallback), and `convex/polar.ts` validates HTTPS checkout URLs and string currency. Verified with 18/18 tests in `convex/polar.test.ts`.

### AUD-003: Fail closed and sanitize Polar webhook handling

- Status: DONE
- Area: Payments / Secrets
- Files:
  - `convex/polarWebhook.ts`
  - `convex/polar.test.ts`
  - `docs/POLAR_SETUP.md`
- Problem: Missing `POLAR_WEBHOOK_SECRET` falls back to an empty HMAC key. Logs also expose headers, computed signatures, event bodies, and a secret prefix.
- Required changes:
  - Reject requests or deployment initialization when the webhook secret is missing.
  - Use the provider-supported verification library or one canonical secret format.
  - Remove secret, signature, header, and full event logging.
  - Credit tokens and mark the purchase complete in one idempotent internal mutation.
- Acceptance criteria:
  - An unset secret cannot produce a valid webhook.
  - No sensitive signature or secret material appears in logs.
  - A transient credit failure does not permanently mark a purchase completed.
  - Timestamp and replay protections are tested.
- Verification: `corepack pnpm test:run` PASS (2 files, 21 tests); targeted Polar webhook suite PASS (17 tests); `corepack pnpm typecheck` PASS; targeted ESLint PASS with 0 errors or warnings; targeted Prettier check PASS; `corepack pnpm build` PASS with the pre-existing large-chunk warning; `corepack pnpm audit --prod` PASS with no known vulnerabilities.
- Notes: Completed 2026-07-09. Replaced the custom multi-format HMAC implementation with Polar SDK's supported `validateEvent` verifier, which applies the Standard Webhooks five-minute timestamp tolerance, constant-time signature verification, JSON parsing, and Polar event schema validation before business logic. Missing or whitespace-only `POLAR_WEBHOOK_SECRET` values fail closed, verification failures return a generic 401, signed malformed events return a generic 400, and processing failures return a generic 500 so Polar can retry. Webhook logs now contain fixed operational messages only; secrets, prefixes, signatures, authorization/request headers, signed content, and event payloads are never logged. The AUD-002 `validateAndCompletePurchase` internal mutation remains the single atomic transaction for package validation, balance credit, transaction insertion, and purchase completion. Tests cover missing configuration, invalid signatures, expired timestamps, malformed events, successful completion, duplicate delivery, sensitive-log redaction, and a transient mutation failure followed by successful retry, in addition to the AUD-002 product/amount/currency/customer/package validation cases.

  Deployment/configuration: set `POLAR_WEBHOOK_SECRET` in every Convex deployment to the exact secret issued for that deployment's Polar webhook endpoint; sandbox and production endpoints require their own secrets. Do not add prefixes, decode the value, or expose it through a `VITE_` variable. Keep the AUD-002 `POLAR_PRODUCT_ID_50`, `POLAR_PRODUCT_ID_125`, `POLAR_API_KEY`, `POLAR_API_BASE_URL`, and `SITE_URL` values configured as documented in `docs/POLAR_SETUP.md`, and deploy the Convex functions after configuration. A missing secret intentionally causes every delivery to return 401. No deployment was performed as part of this change.

### AUD-004: Enforce authorization on every Convex function

- Status: DONE
- Area: Authorization / Data integrity
- Primary files:
  - `convex/sessionAuth.ts`
  - `convex/images.ts`
  - `convex/paintLayers.ts`
  - `convex/paintLayer.ts`
  - `convex/layers.ts`
  - `convex/paintingSessions.ts`
  - `convex/strokes.ts`
  - `convex/liveStrokes.ts`
  - `convex/aiGeneration.ts`
  - `convex/geminiGeneration.ts`
  - `convex/backgroundRemoval.ts`
  - `convex/imageMerger.ts`
  - `convex/presence.ts`
  - `convex/viewerAcks.ts`
  - `convex/webrtc.ts`
  - `src/hooks/usePaintingSession.ts`
  - `src/lib/convex.tsx`
- Problem: Many public queries and mutations can read, create, modify, reorder, or delete records without checking session access. Client-supplied `userId` values also allow impersonation.
- Required changes:
  - Add a shared authorization module for session read, collaborate, owner, and admin policies.
  - Apply it to every public query, mutation, and action.
  - Derive authenticated user IDs from `ctx.auth`; do not trust client `userId` fields.
  - Verify every child resource belongs to the authorized session.
  - Require guest edit capabilities where anonymous collaboration is allowed.
  - Add rate limits and bounded input validation to public write endpoints.
- Acceptance criteria:
  - Cross-session reads and writes fail.
  - Private-session resources cannot be accessed using only a record ID.
  - A caller cannot attribute activity to another user.
  - Every public Convex export has an explicit documented access policy and test.
- Verification: `pnpm run typecheck` PASS; `pnpm run test:run` PASS (9 files, 64 tests including `convex/sessionAuth.test.ts`, `convex/images.test.ts`, `convex/layersAuth.test.ts`, `convex/paintingSessions.test.ts`); `pnpm exec eslint . --quiet` PASS (0 errors); `pnpm run build` PASS.
- Notes: Completed 2026-11-22 (building on PRs #64/#66/#67/#71/#80). Centralized `resolveAuthenticatedUser`, `canReadSession`, `assertCanModifySession` (returning `{ user }` with constant-time `guestOwnerKey` matching and soft-delete rejection), and `internal.sessionAuth.verifySessionAccess` in `convex/sessionAuth.ts`. Converted `imageMerger.getLayerImageUrl` to `internalQuery` with session read auth, gated `aiGeneration.generateImage`, `geminiGeneration.generateImage`, `backgroundRemoval.removeBackground`, `imageMerger.mergeImages`, `imageMerger.getSessionMerges`, `presence.{updatePresence,leaveSession,getSessionPresence}`, and `viewerAcks.{getViewerState,getAllViewerStatesForSession}`. Removed client-trusted `userId` spoofing in `strokes`, `liveStrokes`, and `presence`, added cross-session `layerId` validation in `strokes.addStroke`, blocked private orphan hijacking in `claimSessionOwnership`, and removed the unauthenticated `convexLow` WebSocket client from the frontend. Public-read vs edit capability separation and bounded input validation/rate limits remain tracked in `AUD-005` and `AUD-011`.

---

## P1 — High priority

### AUD-005: Separate public discovery, viewing, and editing

- Status: DONE
- Area: Sharing model
- Files:
  - `convex/strokes.ts` (`assertCanModifySession`)
  - `convex/paintingSessions.ts`
  - `src/components/ShareModal.tsx`
- Problem: `isPublic` grants write access, and public sessions are enumerable. Anyone can potentially vandalize a public painting.
- Required changes:
  - Replace the single flag with explicit visibility and collaboration policy.
  - Use editor memberships, signed invite tokens, or a separate secret edit link.
  - Keep public gallery/read access read-only by default.
- Acceptance criteria:
  - Public viewers cannot mutate without an edit capability.
  - Owners can revoke edit access.
  - Existing sessions receive a safe migration default.
- Verification: `convex/publicSharing.test.ts` (viewer denial over every write, edit-link lifecycle, rotation/revocation and eviction, owner-only destructive operations, empty keys, restore, admin path, collaborator billing), plus `src/lib/syncStatus.test.ts`, `src/lib/analyticsPrivacy.test.ts`, `src/utils/guestKey.test.ts`, `src/utils/sessionCapabilities.test.ts`.
- Notes: Completed 2026-11-24 (PR #105). `isPublic` is now read-only. Edits need the owner (signed in, or holding the constant-time-checked `guestOwnerKey`) or a secret, owner-managed `editKey` sent as `#edit=<token>`. The key is taken from the URL fragment only, kept in per-tab sessionStorage, scrubbed from the URL before PostHog starts, and stripped from analytics. Owners can enable, rotate or revoke the link; rotate and revoke evict collaborator presence, live strokes and signals at once. Hard-destructive operations (layer/image deletion, layer merge, clear) are owner-only. New sessions are private by default. Existing public sessions are view-only until the owner creates an edit link. Ownerless legacy sessions can be assigned or soft-deleted with `internal.paintingSessions.resolveOwnerlessSession`.

### AUD-006: Reserve AI tokens atomically before provider spending

- Status: DONE
- Area: AI billing / Concurrency
- Files:
  - `convex/aiGeneration.ts`
  - `convex/geminiGeneration.ts`
  - `convex/backgroundRemoval.ts`
  - `convex/imageMerger.ts`
  - `convex/tokens.ts`
  - `convex/tokens.test.ts`
- Problem: Actions check balance, incur provider cost, and deduct afterward. Concurrent requests can all pass the initial balance check.
- Required changes:
  - Atomically reserve/debit tokens before starting external work.
  - Associate the reservation with an immutable operation ID.
  - Refund exactly once when an operation fails before producing a usable result.
  - Enforce per-user concurrency and rate limits.
- Acceptance criteria:
  - A one-token balance cannot launch multiple paid operations concurrently.
  - Retries do not create duplicate provider work or charges.
  - Success, failure, timeout, and cancellation paths reconcile correctly.
- Verification: `pnpm run test:run` PASS (7/7 tests in `convex/tokens.test.ts` covering concurrent 1-token launches, duplicate charges, duplicate refunds, uncharged refund rejection, and provider failure/cancellation refunds across Replicate, Gemini, background removal, and image merge); `pnpm run typecheck` PASS; `pnpm exec eslint . --quiet` PASS.
- Notes: Completed 2026-11-22. Added idempotent `internal.tokens.refundTokensForOperation` keyed on `refund:${operationKey}` (verifying an existing `usage` debit before crediting back). Updated all four AI actions to atomically reserve 1 token via `consumeTokensForOperation` before any external provider calls, using immutable operation IDs (`generationId`, `mergeId`, and a single per-invocation ID in `backgroundRemoval.ts`), and refunding once + marking DB rows `failed` on any provider error, timeout, cancellation, empty/invalid URL, or exception. Also moved `GEMINI_API_KEY` from the URL query string to the `x-goog-api-key` header and clamped `getTokenHistory` limits.

### AUD-007: Fix background-removal ownership comparison

- Status: DONE
- Area: Correctness / Authorization
- Files:
  - `convex/backgroundRemoval.ts`
  - `convex/sessionAuth.ts`
  - `convex/sessionAuth.test.ts`
- Problem: `session.createdBy` is a Convex user ID while `identity.subject` is an authentication subject string, so legitimate owners can be rejected.
- Required changes:
  - Use the centralized authorization helper from AUD-004.
  - Remove the incompatible direct ID comparison.
- Acceptance criteria:
  - Session owners can use the operation.
  - Non-editors cannot use it against the session.
  - Tests cover owner, guest editor, public viewer, and unrelated user.
- Verification: `pnpm run test:run convex/sessionAuth.test.ts` PASS (owner, guest-key editor, wrong guest key, unauthenticated, and private-session outsider cases verified).
- Notes: Completed 2026-11-22. Replaced the incompatible `session.createdBy !== identity.subject` comparison with `internal.sessionAuth.verifySessionAccess` and threaded `guestKey` from `BackgroundRemovalModal.tsx`.

### AUD-008: Replace the client-side password gate

- Status: DONE
- Area: Authentication
- Files:
  - `src/components/PasswordProtection.tsx` (removed)
  - `src/routes/__root.tsx`
  - `selfhost/preview/deploy-preview.sh`
- Problem: The password is hardcoded in client JavaScript and authentication state is a client-controlled `sessionStorage` value. It provides no security boundary.
- Required changes:
  - Remove the component if it is only a visual preview gate, or replace it with server-side authentication/middleware.
  - Rotate the exposed password if it is reused anywhere else.
- Acceptance criteria:
  - Protected routes and APIs reject unauthenticated requests server-side.
  - No access password is shipped in the browser bundle.
- Verification: `pnpm typecheck` PASS; `pnpm test:run` PASS (9 files, 75 tests); `pnpm exec eslint . --quiet` PASS; `pnpm build` PASS; built server smoke test: `/`, `/?session=…` and `/login` return 200 with no SSR crash; in a browser, `/` and `/?session=…` (with seeded localStorage) show no React hydration error #418 and no CSP violation, while a control build with the old `PaintingView` expression reproduces #418.
- Notes: Completed 2026-11-24 (PR #101). The gate was only a visual preview gate (hardcoded password, `sessionStorage` flag), so `PasswordProtection.tsx` and its `VITE_PASSWORD_PROTECTION_ENABLED` setting were removed rather than replaced; the app is public by design, and authorization belongs in the Convex functions (AUD-004/AUD-005). No password ships in the bundle. Rotate the old password anywhere it was reused. Removing the gate turned on full SSR of the editor for the first time: `PaintingView` now renders the same first frame on server and client (the `?session=` check, saved brush settings, `navigator.onLine` and the sync-status store are read after mount), and `getClientId()` no longer caches a value during SSR.

### AUD-009: Secure image uploads and storage registration

- Status: TODO
- Area: Upload security / Cost control
- Files:
  - `convex/images.ts`
  - `src/utils/imageUpload.ts`
- Problem: Anyone can request an upload URL, and server mutations trust client MIME type, dimensions, filename, storage ID, session, and user ID. The 5 MB/type checks exist only in the browser.
- Required changes:
  - Authorize upload URL generation for a specific session.
  - Add server-side file size, decoded type, image dimension, and ownership validation.
  - Bind issued upload intents to user/session and consume them once.
  - Reject unregistered storage IDs and remove abandoned uploads.
- Acceptance criteria:
  - Bypassing the frontend cannot upload arbitrary type/size content.
  - A storage object cannot be attached to an unauthorized session.
  - Abandoned objects expire or are cleaned up.
- Verification: Not run
- Notes:

### AUD-010: Implement storage lifecycle and cascading deletion

- Status: DONE
- Area: Data lifecycle / Cost
- Files:
  - `convex/paintingSessions.ts`
  - `convex/images.ts`
  - `convex/aiGeneration.ts`
  - `convex/geminiGeneration.ts`
  - `convex/backgroundRemoval.ts`
  - `convex/imageMerger.ts`
  - `convex/schema.ts`
  - `convex/storageLifecycle.ts`
  - `convex/aiOperations.ts`
- Problem: Session deletion removes only the parent record. AI input/output files often lack stored storage IDs and cannot be deleted, leaving orphaned documents and blobs.
- Required changes:
  - Record storage IDs for every persisted input and output.
  - Add bounded cascading deletion jobs for session-owned tables and storage.
  - Add cleanup for failed, timed-out, abandoned, and superseded operations.
  - Consider soft deletion plus an asynchronous purge workflow.
- Acceptance criteria:
  - Deleting a session eventually removes all owned documents and blobs.
  - Failed AI operations do not leak input/output storage.
  - Cleanup is resumable and safe to retry.
- Verification: `pnpm typecheck` PASS; `pnpm test:run` PASS (`convex/storageLifecycle.test.ts` covers the cascading purge, round-robin and self-rescheduling drain, restore refusal mid-purge, stale-operation refunds and terminal guards, output ownership transfer and TTL, and the orphan sweep); `pnpm exec eslint . --quiet` PASS; `pnpm build` PASS.
- Notes: Completed 2026-11-24 (PR #106). Every blob is tracked on its owner: upload intents and `uploadedImages`, Replicate canvas snapshots (`aiGenerations.canvasSnapshotId`, freed when the row turns terminal), AI outputs on their operation row until placed and then on the `aiGeneratedImages` layer. Deletes are reference-counted (`isStorageReferenced`). Session deletion is soft; `purgeDeletedSessions` hard-deletes after 30 days, round-robin in bounded batches that reschedule themselves. Crons: stale AI operations (15 min; `pending` rows refunded, `processing` rows `failed_billed`), unplaced AI outputs (24 h TTL), and a daily sweep of unreferenced `_storage` blobs older than 24 h.

### AUD-011: Bound and validate all untrusted inputs

- Status: TODO
- Area: Abuse prevention
- Files: All public functions under `convex/`
- Problem: Names, prompts, point arrays, dimensions, transforms, viewer IDs, peer IDs, WebRTC payloads, history arrays, and numeric values are largely unbounded.
- Required changes:
  - Define shared maximums and validation helpers.
  - Reject non-finite coordinates/scales and out-of-range opacity/brush values.
  - Limit prompt/name/filename lengths, stroke point counts, signal sizes, and history lengths.
  - Add per-user/IP/session rate limits where supported.
- Acceptance criteria:
  - Oversized payloads fail before database/provider work.
  - Stored numeric values are finite and within documented bounds.
  - Abuse tests cover storage, mutation frequency, and large payloads.
- Verification: Not run
- Notes:

### AUD-012: Protect WebRTC peer identity and signaling

- Status: TODO
- Area: Collaboration security
- Files:
  - `convex/webrtc.ts`
  - `src/lib/webrtc/P2PManager.ts`
- Problem: Peer IDs are client-controlled and not bound to a caller. A session participant can potentially read or delete another peer's signals or impersonate a sender.
- Required changes:
  - Issue or register peer identities per authorized connection.
  - Bind signaling reads/deletes/sends to that identity.
  - Limit signal payload size and message rate.
- Acceptance criteria:
  - One peer cannot retrieve or delete another peer's signaling queue.
  - Sender identity cannot be forged.
- Verification: Not run
- Notes:

---

## P2 — Performance, reliability, and operations

### AUD-013: Eliminate duplicate editor subscriptions and side effects

- Status: TODO
- Area: Frontend performance / Correctness
- Files:
  - `src/components/PaintingView.tsx`
  - `src/components/KonvaCanvas.tsx`
  - `src/hooks/usePaintingSession.ts`
  - `src/hooks/useSessionImages.ts`
  - `src/hooks/useP2PPainting.ts`
- Problem: The page and canvas independently instantiate painting, image, AI-image, paint-layer, and P2P hooks, creating duplicate reactive queries, presence timers, random guest identities, and P2P lifecycles.
- Required changes:
  - Instantiate editor/session state once in a provider or controller hook.
  - Pass normalized state and stable actions into the canvas and panels.
  - Remove duplicate AI-image queries already covered by the combined image query.
- Acceptance criteria:
  - One active subscription per logical dataset per editor.
  - One presence heartbeat and one P2P manager per session tab.
  - Query/write counts are measured before and after.
- Verification: Not run
- Notes:

### AUD-014: Make stroke storage and subscriptions scalable

- Status: TODO
- Area: Convex performance / Canvas rendering
- Files:
  - `convex/strokes.ts`
  - `src/hooks/usePaintingSession.ts`
  - `src/components/KonvaCanvas.tsx`
- Problem: `getSessionStrokes` collects and returns every stroke with every point on each reactive update. Large paintings will increase bandwidth, render cost, and risk Convex read limits.
- Required changes:
  - Use paginated initial loading plus incremental recent operations.
  - Avoid retransmitting immutable historical strokes after every change.
  - Snapshot/flatten older strokes into tiles, vector chunks, or raster checkpoints.
  - Virtualize or cache per-layer drawing where practical.
- Acceptance criteria:
  - Adding one stroke does not resend the full painting history.
  - A documented large-canvas benchmark remains responsive and within read limits.
  - Undo/redo behavior remains correct across snapshots.
- Verification: Not run
- Notes:

### AUD-015: Fix thumbnail generation and storage

- Status: TODO
- Area: CPU / Database bandwidth
- Files:
  - `src/hooks/useThumbnailGenerator.ts`
  - `convex/paintingSessions.ts`
  - `convex/schema.ts`
- Problem: Every interval scans full-resolution pixels on the main thread. The change check compares a source image data URL with the previous JPEG thumbnail, so it does not detect unchanged canvases. Thumbnails are stored inline in session documents.
- Required changes:
  - Trigger generation from a canvas revision/change counter.
  - Generate directly at thumbnail resolution without a full-size pixel scan.
  - Store the thumbnail in file storage and retain a storage ID/URL.
  - Authorize thumbnail updates.
- Acceptance criteria:
  - An unchanged canvas produces no thumbnail encode or database write.
  - Thumbnail work does not create a noticeable main-thread stall.
  - Session list queries do not read embedded base64 image payloads.
- Verification: Not run
- Notes:

### AUD-016: Add client code splitting

- Status: TODO
- Area: Bundle performance
- Files:
  - `src/routes/index.tsx`
  - `src/components/PaintingView.tsx`
  - Modal and admin/debug components under `src/components/`
- Baseline: Production build produced initial chunks of approximately 468.35 KB and 643.42 KB minified (134.32 KB and 205.30 KB gzip).
- Required changes:
  - Lazy-load AI, export, library, admin/debug, background removal, and merge workflows.
  - Evaluate route-level lazy loading for the editor and Konva dependencies.
  - Add a bundle-size budget to CI.
- Acceptance criteria:
  - No initial client chunk exceeds the agreed budget.
  - Editor startup behavior is verified on a throttled mobile profile.
- Verification: Baseline recorded 2026-07-09
- Notes:

### AUD-017: Replace long provider polling actions

- Status: TODO
- Area: AI reliability / Scalability
- Files:
  - `convex/aiGeneration.ts`
  - `convex/backgroundRemoval.ts`
  - `convex/imageMerger.ts`
- Problem: Actions poll external providers once per second for up to roughly 180 seconds, consuming action capacity and complicating retries.
- Required changes:
  - Prefer provider webhooks where available.
  - Otherwise schedule bounded status checks with persisted state and backoff.
  - Add cancellation and stale-operation cleanup.
- Acceptance criteria:
  - No action remains active solely to sleep and poll for minutes.
  - Provider retries and duplicate callbacks are idempotent.
- Verification: Not run
- Notes:

### AUD-018: Reduce sensitive and high-volume logging

- Status: TODO
- Area: Privacy / Operations
- Files:
  - AI functions under `convex/`
  - `convex/polarWebhook.ts`
  - `convex/paintingSessions.ts`
  - `src/components/KonvaCanvas.tsx`
  - `src/components/PaintingView.tsx`
  - `src/lib/webrtc/`
- Problem: Production paths log prompts, image samples/URLs, identities, headers, provider responses, peer information, and frequent interaction details.
- Required changes:
  - Add a structured logger with environment-aware levels.
  - Redact prompts, URLs, headers, identities, tokens, and provider payloads.
  - Remove per-stroke, per-poll, and render-path logs from production.
- Acceptance criteria:
  - Production logs contain no secrets or user content.
  - Log volume remains bounded during drawing and provider polling.
- Verification: Not run
- Notes:

### AUD-019: Harden self-hosting configuration

- Status: IN PROGRESS
- Area: Deployment security
- Files:
  - `selfhost/docker-compose.yml`
  - `selfhost/bin/start-app.sh`
  - `selfhost/bin/backup.sh`
  - `selfhost/launchd/`
  - `server/middleware/canonical-host.ts`
- Problem: Containers use unpinned `latest` tags, backend/dashboard ports bind to every interface, and repository code defines no browser security headers.
- Required changes:
  - Pin container versions or immutable digests.
  - Bind internal ports to `127.0.0.1` unless LAN exposure is explicitly required.
  - Add CSP, HSTS, frame-ancestors, Referrer-Policy, and Permissions-Policy at the effective edge/server layer.
  - Document Cloudflare and host firewall assumptions.
- Acceptance criteria:
  - Internal services are not unintentionally reachable from LAN/WAN.
  - Deployment versions are reproducible.
  - Security headers are verified against production responses.
- Verification: `zsh -n selfhost/bin/start-app.sh selfhost/bin/backup.sh` PASS; `bash -n selfhost/preview/*.sh` PASS; `pnpm run typecheck` PASS; `pnpm run build` PASS.
- Verification (headers): `src/lib/securityHeaders.test.ts`; built server (`node .output/server/index.mjs`) responses to `/`, `/?session=…`, `/login` and a 404 carry the CSP, HSTS and X-Frame-Options headers, and the apex 308, `/sign-up` 307 and proxied auth 302/401/413 responses carry HSTS and X-Frame-Options; browser console on `/` and `/?session=…` shows no CSP violations, with PostHog's lazy scripts loading. Not yet verified against production responses.
- Notes: Updated 2026-11-22. Bound production Docker ports (`3210`, `3211`, `6791`) and Nitro (`HOST=127.0.0.1`) to loopback by default, fixed `start-app.sh` / `backup.sh` default paths (`$HOME/apps/wepaintai`) and zsh `NOMATCH` bugs, added `unzip -tq` integrity verification to `backup.sh`, and added baseline security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) + 308 apex/www canonicalization in `server/middleware/canonical-host.ts`. Updated 2026-11-24 (PR #102 review fixes): Convex images moved to `ghcr.io/convex/convex-backend` / `ghcr.io/convex/convex-dashboard` (the `ghcr.io/get-convex/*` paths return 403) and `docker-compose.yml` now defaults to pinned digests; the Cloudflare tunnel example targets `127.0.0.1` to match the loopback binds; `selfhost/launchd/*.plist` point at `~/apps/wepaintai`; `backup.sh` fails loudly when the checkout, `.env.convex`, or the Convex CLI is missing; the README documents Docker Desktop start-at-login and routine backup checks. Preview deploys run trusted scripts from a `main` checkout under `pull_request_target` with the PR checked out as data, verify `~/apps/wepaintai-previews/bin/*` checksums, and install with `--ignore-scripts`; the residual same-user runner risk and the org-admin/sudo follow-ups (runner group restricted to `main` workflows, dedicated runner user or ephemeral VM) are documented in `selfhost/preview/README.md`. Remaining: offsite backup sync and the runner-isolation follow-ups. Browser security headers done 2026-11-24 (PR #101). `server/middleware/canonical-host.ts` sets HSTS (`max-age=31536000; includeSubDomains`), `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy` on every response, including non-2xx responses (404, redirects, 413, proxied auth errors), which h3 would otherwise send without event headers. The root route's `headers` sends an enforced CSP on all SSR HTML (including the 404 page) with a per-request nonce from `src/router.tsx` that TanStack Start puts on every inline script: `script-src 'self' 'nonce-…'` plus the PostHog hosts (no `unsafe-inline` or `unsafe-eval`), `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'` and `form-action 'self'` (Google sign-in is a fetch plus a top-level navigation, not a form post). The CSP is skipped under `vite dev`. HSTS `includeSubDomains` also applies to every `*.wepaint.ai` host once a browser sees it on the apex redirect, so all subdomains must stay HTTPS-only.

### AUD-020: Add automated tests and CI gates

- Status: IN PROGRESS
- Area: Quality engineering
- Files:
  - `package.json`
  - `.github/workflows/ci.yml`
  - `convex/*.test.ts`
- Problem: There is no configured test runner or CI workflow.
- Required changes:
  - Add Vitest for server/unit tests and React Testing Library for UI behavior.
  - Add Playwright for critical editor, sharing, upload, and billing flows.
  - Run pinned-pnpm install, typecheck, lint, test, build, and audit in CI.
  - Make P0/P1 security regression tests required checks.
- Acceptance criteria:
  - Pull requests cannot merge with failing typecheck, tests, or build.
  - Critical authorization, token, payment, and concurrency paths have regression coverage.
- Verification: `pnpm run test:run` PASS (9 files, 64 tests); `pnpm run typecheck` PASS; `pnpm exec eslint . --quiet` PASS; `pnpm run build` PASS.
- Notes: Updated 2026-11-22. Added GitHub-hosted `.github/workflows/ci.yml` running pinned `corepack pnpm` install, typecheck, tests, lint, and production build on PRs and pushes to `main`. Added regression tests in `convex/sessionAuth.test.ts`, `convex/strokes.test.ts`, `convex/tokens.test.ts`, and `convex/polar.test.ts` (64 tests total). React Testing Library UI tests, Playwright E2E tests, and branch-protection required-check configuration remain to complete AUD-020.

### AUD-021: Pay down lint and React correctness warnings

- Status: IN PROGRESS
- Area: Maintainability
- Files:
  - `eslint.config.js`
  - `.prettierignore`
  - Warnings across `src/` and `convex/`
- Baseline:
  - Project-only scan: 198 warnings (2026-07-09); reduced to 181 warnings and 0 errors (2026-11-22).
  - Top groups: explicit `any`, unused variables, hook dependency issues, and state-in-effect warnings.
  - Default `eslint .` previously scanned nested `.claude` worktrees and reported 1,191 warnings.
- Required changes:
  - Ignore nested worktrees and agent/runtime directories.
  - Resolve React hook dependency, purity, refs, and state-in-effect warnings first.
  - Gradually promote correctness rules from warnings to errors.
- Acceptance criteria:
  - Lint scans only the intended repository source.
  - No React correctness warnings remain.
  - CI enforces an agreed warning budget trending toward zero.
- Verification: `pnpm exec eslint . --quiet` PASS (0 errors); full `pnpm lint` now scans only repository source (181 warnings).
- Notes: Updated 2026-11-22. Added `.claude` and `.agents` ignores to `eslint.config.js` and `.prettierignore`. Remaining work: resolve React hook correctness warnings and tighten rules to errors.

### AUD-022: Split oversized editor modules

- Status: TODO
- Area: Architecture
- Files:
  - `src/components/KonvaCanvas.tsx` (approximately 2,218 lines)
  - `src/components/ToolPanel.tsx` (approximately 1,479 lines)
  - `src/components/PaintingView.tsx` (approximately 1,287 lines)
- Required changes:
  - Separate canvas rendering, pointer input, layer transforms, upload handling, keyboard shortcuts, P2P previews, tool panels, and modal orchestration.
  - Establish narrow typed interfaces between controller and view components.
- Acceptance criteria:
  - High-frequency canvas updates do not rerender unrelated panels/modals.
  - Core modules have focused tests and clearly bounded responsibilities.
- Verification: Not run
- Notes:

### AUD-023: Add privacy controls for analytics

- Status: TODO
- Area: Privacy
- Files:
  - `src/client.tsx`
- Problem: PostHog initializes unconditionally, while the repository contains no privacy/consent surface or documented data policy.
- Required changes:
  - Make analytics environment-controlled.
  - Determine and document the legal consent model for deployed regions.
  - Disable capture of prompts, canvas content, session IDs, and sensitive DOM text.
  - Honor opt-out and applicable browser privacy signals.
- Acceptance criteria:
  - Development/self-hosted installations can disable analytics completely.
  - Sensitive editor and authentication data is excluded from analytics.
- Verification: Not run
- Notes:

### AUD-024: Improve accessibility coverage

- Status: TODO
- Area: Accessibility
- Files:
  - `src/routes/__root.tsx`
  - Modal components under `src/components/`
  - Canvas/tool controls
- Problem: No accessibility linting or automated testing is configured. The root lacks `lang`, several modals lack dialog/focus-management semantics, and some icon controls lack accessible labels.
- Required changes:
  - Add `eslint-plugin-jsx-a11y` and automated axe checks.
  - Add `lang`, dialog semantics, focus trap/restore, Escape handling, and labeled controls.
  - Define a keyboard-accessible alternative for essential canvas actions.
- Acceptance criteria:
  - Primary flows pass automated axe checks.
  - All interactive controls are keyboard reachable and named.
  - Modals correctly manage focus.
- Verification: Not run
- Notes:

---

## P3 — Documentation and developer experience

### AUD-025: Correct setup and architecture documentation

- Status: TODO
- Area: Documentation
- Files:
  - `README.md`
  - `.env.example`
  - `docs/`
- Problem: README port and directory examples are stale, production prerequisites are incomplete, and security assumptions are not documented.
- Required changes:
  - Align ports and commands with `package.json`.
  - Replace `/app` examples with the current `src/` structure.
  - Document required app and Convex environment variables separately.
  - Document the public/read/edit model and production deployment checklist.
- Acceptance criteria:
  - A clean clone can be started from the README without undocumented steps.
  - Production startup fails with clear messages for every missing required variable.
- Verification: Not run
- Notes:

### AUD-026: Enforce the repository-pinned pnpm version

- Status: TODO
- Area: Developer experience / Reproducibility
- Files:
  - `package.json`
  - Future CI workflows
- Problem: Bare pnpm 11 ignored the current `pnpm` configuration and produced an incompatible local dependency state; `corepack pnpm` correctly selected pnpm 10.34.4.
- Required changes:
  - Use Corepack in README, deployment scripts, and CI.
  - Add an engine/package-manager guard if contributors frequently use global pnpm.
- Acceptance criteria:
  - Local and CI installs use the pinned package-manager version.
  - Frozen-lockfile installation is reproducible.
- Verification: `corepack pnpm install --frozen-lockfile` passed 2026-07-09
- Notes:

---

## Audit verification baseline

Recorded on 2026-07-09 after installing with the repository-pinned pnpm version:

- `corepack pnpm typecheck`: PASS
- `corepack pnpm build`: PASS with large client chunk warning
- `corepack pnpm audit --prod`: PASS, no known advisories reported
- Project-only ESLint scan: 0 errors, 198 warnings
- Default `corepack pnpm lint`: 0 errors, 1,191 warnings because nested `.claude` worktrees are included
- Automated tests: NOT AVAILABLE
- Browser smoke test: NOT COMPLETED; required Convex URLs were not configured in the audit environment
- Secret-pattern scan: no committed provider private keys found; the client-side access password remains tracked under AUD-008

## Template for future session handoff

Copy this into a new task and replace the ID:

> Work on `AUD-XXX` from `docs/SECURITY_PERFORMANCE_AUDIT.md`. Inspect the current implementation, update the backlog item to `IN PROGRESS`, implement the complete fix with tests, run the relevant verification commands, then mark it `DONE` only if every acceptance criterion passes. Record key decisions and command results in the item's Notes and Verification fields. Do not modify unrelated user changes.

## Completion checklist for each item

- [ ] Status updated before and after work
- [ ] Threat model or failure mode understood
- [ ] Implementation completed
- [ ] Unit/integration tests added
- [ ] Typecheck passed
- [ ] Relevant lint passed
- [ ] Production build passed when frontend/build behavior changed
- [ ] Security or performance acceptance criteria verified
- [ ] Notes record migrations, deployment steps, or follow-up risks
