# Custom Provider Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining custom-provider SSRF, configuration disclosure, and short-key false-positive risks without changing the approved provider UX.

**Architecture:** Keep the provider adapter as the single boundary for outbound requests and model output. Require Cloudflare Workers to route global fetches as public-Internet requests, normalize candidate output URLs before comparing them with the configured Base URL, and require a minimum custom-key length so full-key detection is unambiguous.

**Tech Stack:** TypeScript, Cloudflare Workers/Vite compatibility flags, Node test runner.

---

### Task 1: Add regression tests for the security boundary

**Files:**
- Modify: `tests/core.test.ts`

- [ ] **Step 1: Write a failing test for strict public Fetch configuration**

Assert that `vite.config.ts` includes `global_fetch_strictly_public` with the existing Worker compatibility flags.

- [ ] **Step 2: Write failing adapter tests**

Use a public mock resolver and successful mocked Responses payloads to assert that equivalent Base URL output variants (uppercase scheme/host, default HTTPS port, and encoded path) reject with `AI_SENSITIVE_OUTPUT`; assert that a custom key shorter than eight characters is rejected by input validation.

- [ ] **Step 3: Run the focused Node tests**

Run: `node --experimental-strip-types --test tests/core.test.ts`

Expected: the new assertions fail before production code changes.

### Task 2: Implement the minimal hardening

**Files:**
- Modify: `vite.config.ts`
- Modify: `lib/ai-provider.ts`
- Modify: `lib/ai-settings.ts`

- [ ] **Step 1: Enable strict public routing**

Add `global_fetch_strictly_public` to the Cloudflare Worker compatibility flags used by the Vite configuration.

- [ ] **Step 2: Normalize model-output URL candidates**

Extract only `http(s)` URLs from model output, parse them with the platform URL parser, compare protocol, canonical host, effective port, and decoded Base URL path-prefix against the normalized saved Base URL, and fail closed on a match.

- [ ] **Step 3: Define the custom key floor**

Require custom API Keys to contain at least eight non-whitespace, non-control characters before encryption and preserve exact-key/Bearer-key output detection for accepted keys.

- [ ] **Step 4: Run the focused tests**

Run: `node --experimental-strip-types --test tests/core.test.ts`

Expected: every security regression passes.

### Task 3: Verify the full product boundary

**Files:**
- Modify: `tests/core.test.ts`

- [ ] **Step 1: Run static and behavior checks**

Run: `npm run lint`, `npx tsc --noEmit`, `npm test`, and `git diff --check`.

- [ ] **Step 2: Re-review the changed security boundary**

Confirm that the security tests exercise the actual adapter path and that no API Key, configured Base URL, or prohibited relay host is added to source or documentation.
