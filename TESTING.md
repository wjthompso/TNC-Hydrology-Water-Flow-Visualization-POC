# Feature-centered testing

The test catalog at `tests/support/catalog/test-catalog.json` is the declarative source of truth for classification, selection, Feature lifecycle, test enforcement, duration budgets, methodology, and source files. Every test command validates that catalog and the fixture manifests through `tests/support/validation/foundations.ts` before execution. Permanent catalog test identifiers use `FBT`, `FST`, `CCT`, or `SST` plus a number, such as `SST-001`, and must match that test's category. They are catalog labels, not HTML id attributes. Example identifiers keep the `E` form, such as `FBT-E001`. `npm run test:view-test-catalog` creates `.test-results/catalog.html`, a static human-facing view that never executes tests. The page shows Feature Set, Feature, and Feature Behavior Tests, with Critical Core collapsed by default. Supporting Tests are intentionally absent from this page. Opened rows label lifecycle, enforcement, scope, environment, and browser mode separately, and contain a Test methodology disclosure that is closed until opened. Its primary result is the effective catalog state: disabled, deprecated, and retired override a stored execution, and a missing execution is unexecuted. A stored execution on those entries is secondary evidence, such as `last execution: passed`. A stored result with no test-definition fingerprint, or a fingerprint that does not match the current definition, is also unexecuted stale evidence and is never the current Passed result. That fingerprint covers the catalog test identifier, name, methodology, category, owner and associations, scope, environment, browser mode, regression, bug reference, root cause analysis, enforcement, duration budget, and source file. A release-gate result stays current only when its required-gate definition fingerprint still matches the required Feature Behavior and Critical Core definitions. Recording a run drops result entries whose identifiers are no longer in the permanent test catalog. Active required and nonblocking tests still show a truthful passed result when the fingerprint matches, and the advisory badge stays separate from that result.

The current page entries are runner-shaped TypeScript examples. An example uses an `E` in its identifier, such as `FBT-E001`, is labeled Example, and lives only in the `examples` list. Browser examples use `.example.spec.ts`; non-browser examples use `.example.test.ts`. Playwright and Vitest explicitly exclude those suffixes, so examples are not discovered, executed, reported as skipped, or included in the release gate. Their `test.skip`, `describe.skip`, or `it.skip` declarations make the illustrative runner shape recognizable without making the files executable tests. Examples do not protect the application or reserve later release identifiers such as `FBT-001`.

Promotion is deliberate: obtain approval for the permanent test identifier, sentence, methodology, protected behavior, assertions, classifications, duration budget, and target folder; replace declarations and illustrative seams with real production imports and approved test infrastructure; rename the file to the repository's executable runner convention; move its metadata from the `examples` list to the `tests` list; then verify focused discovery and the relevant broader commands.

## Baseline Feature Behavior Tests and Bug Checks

A baseline Feature Behavior Test checks for the presence of desired behavior. Its catalog fields are `regression: false`, `bugReference: null`, and `rootCauseAnalysis: null`.

A Bug Check is a classification on a Feature Behavior Test, stored as `regression: true` and displayed as Bug Check. It is not an organizational category and not a result state. It checks for the absence of one known or likely bug. Passing means that bug's user-visible behavior was not observed under the documented test methodology. One Bug Check covers one bug. Catalog validation requires the nonempty fields below and does not try to count bugs inside the text.

Every Bug Check requires a nonempty `bugReference` and a nonempty `rootCauseAnalysis`. Root cause analysis is stored separately from `methodology`. The viewer shows a static Bug Check badge, with the words Bug Check, directly under the primary result badge. It is metadata, not a button. An opened Bug Check has two collapsed disclosures, in this order: Test methodology, then Root Cause Analysis. Test methodology renders only `methodology`. Root Cause Analysis renders only `rootCauseAnalysis`. A baseline test shows Test methodology only, with no Bug Check badge and no Root Cause Analysis disclosure.

When safe and practical, prove a Bug Check with a Bug Reproduction Run: the test fails for the intended behavioral reason in a safely restored bug-producing environment, then passes in the fixed environment. That run is review evidence only and never replaces the recorded release result. Remove the bug-producing environment after review unless continued maintenance is explicitly approved.

## Commands

Run these commands from the repository root. The browser application package does not own test scripts.

- `npm run test:view-test-catalog` writes `.test-results/catalog.html`, serves it at `http://127.0.0.1:4174/` (the next free port if that one is busy; set `TNC_CATALOG_PORT` to change the preferred port), and opens that page. Ctrl+C stops the server. `--no-open` serves without launching a browser; `--no-serve` writes the file and exits. The page shows Feature Set, Feature, and Feature Behavior Tests, with Critical Core collapsed by default. Supporting Tests are intentionally absent from this page. Each opened baseline test keeps Test methodology collapsed until it is opened. A Bug Check also keeps a separate Root Cause Analysis disclosure collapsed, directly after Test methodology, and shows a static Bug Check badge under the primary result badge. Example entries are labeled Example and do not run. It does not execute tests.
- `npm run test:fast-only`runs non-browser tests explicitly marked`fast: true` and reports exclusions.
- `npm run test:features` runs enabled Feature Behavior Tests, including nonblocking tests, and excludes Supporting Tests.
- `npm run test:core` runs enabled Critical Core Tests.
- `npm run test:shared` runs enabled Shared Supporting Tests.
- `npm run test:browser-deterministic` uses controlled inputs. Deterministic specs import `tests/support/browser/deterministic-network.ts`, whose automatic fixture fails unexpected external requests. Same-origin recorded fixtures and mocks stay allowed. `deterministicRequestAllowlist` in `playwright.config.ts` is the explicit external exception list.
- `npm run test:browser-live` runs the approved live-service browser project with one worker.
- `npm run test:browser-all` and `npm run test:browser-only` run both browser modes.
- `npm run test:gate` uses the shared release-gate function: required Critical Core first, stop on failure or inconclusive verification, then required Feature Behavior Tests, including live tests. Supporting Tests stay outside the gate. An empty Critical Core phase is allowed when required Feature Behavior tests exist. When the catalog has zero required Feature Behavior and Critical Core tests, the gate is inconclusive, exits with code 2, explains that no required tests are configured, and does not report or store Passed.
- `npm run test:all` runs every enabled test plus linting and reports release eligibility separately from diagnostic health. When zero required tests exist, release eligibility is inconclusive and not verified. Diagnostic health still reflects the executed tests and lint on their own.
- `npm run test:feature -- F-110` runs enabled tests owned by or additionally associated with one Feature.
- `npm run test:feature-set -- FS-100` runs enabled tests associated with one Feature Set.

A browser test's result is its final attempt. When that attempt passes and an earlier attempt failed, timed out, was interrupted, or was inconclusive, the stored state is `passed`, with `passedAfterRetry: true` and a `failedAttempts` list (attempt number, status, the first 20 error lines, location, stdout and stderr tails, and artifact paths). That pass counts for the command status, `npm run test:gate`, and `test:all` release eligibility. `durationMs` is the final attempt, and duration-budget warnings use that value. `totalDurationMs` is the sum across attempts. The console prints a `PASSED AFTER RETRY` line for each failed attempt, and the catalog shows a Passed after retry badge with those details collapsed. There is no separate `flaky` state.

Required inconclusive verification exits with code 2, including a catalog that has no required tests configured. Failure exits with code 1. A passed gate exits with code 0. Local results are ignored by Git, with the latest observations in `.test-results/latest.json` and up to 20 command runs in `.test-results/history.json`. Each stored test result includes the test-definition fingerprint, and a gate result includes the required-gate definition fingerprint. Failed-attempt traces and screenshots stay in that run's `.test-results/playwright-artifacts-*` directory. Playwright 1.64 `trace: 'retain-on-failure'` keeps a failed attempt's trace when a later retry passes, `screenshot: 'only-on-failure'` writes the screenshot on the failed attempt, and `preserveOutput: 'always'` keeps the attempt directory.

## Lifecycle and enforcement

Feature lifecycle (`active`, `deprecated`, or `retired`) and test enforcement (`required`, `nonblocking`, or `disabled`) are independent catalog fields. Legal combinations follow category semantics:

- Critical Core Tests use `required` enforcement.
- Active Feature Behavior Tests default to `required`. A `nonblocking` or `disabled` exception needs approval evidence.
- Deprecated Feature Behavior Tests may stay `required` or, with explicit approval metadata, use `nonblocking` or `disabled`.
- Feature Supporting Tests and Shared Supporting Tests are advisory. They may be `nonblocking` or `disabled`. `required` is rejected, so those tests stay out of `test:features` and `test:gate`.

Nonblocking and disabled tests remain visible. Disabled tests are not executed. A nonblocking pass is recorded as passed and stays outside the release gate. The catalog never presents disabled, deprecated, retired, or unexecuted as the primary passing result. Required inconclusive verification exits with code 2 and blocks a passed gate. Failure exits with code 1.

Live readiness, layer-settle, and hit-test timeouts are failures unless concrete evidence shows approved external-service unavailability, a network, Domain Name System (DNS), or Transport Layer Security (TLS) failure, HTTP (Hypertext Transfer Protocol) 429 or 5xx responses, or a graphics-environment failure. Timeout text alone, or `net::ERR_ABORTED` alone, stays a failure.

Lifecycle or legal non-default enforcement changes require a concise reason, affected behaviors, consequences, and approval evidence. Reactivation additionally requires a recorded expected-behavior review and restored required Feature Behavior verification. Preserve deprecated definitions, test metadata, and relevant implementation whenever reactivation remains plausible. Supporting Test failures still require investigation before a release is called verified.

## Fixtures, cache, and reports

Reviewed fixtures live in `tests/fixtures/recorded`, with source, version, checksum, review, and association metadata in `tests/fixtures/manifests`. Fixture refresh is manual: edit or replace the reviewed file, run `shasum -a 256 <fixture>`, update its manifest, and obtain review approval. No refresh automation is provided.

The ignored local cache defaults to `.test-cache`. Set `TNC_TEST_CACHE_DIR` to an absolute or shared cache location when multiple clones should reuse large local test assets. Generated browser artifacts, reports, latest results, and history remain under ignored local directories.

## Browser build

`npm run build -w creek-visualization-browser` typechecks and builds. The old `constraints.collision` failure is gone: `@arcgis/core` 4.34 `SceneViewConstraintsProperties` has no `collision` property, and the scene no longer sets one.
