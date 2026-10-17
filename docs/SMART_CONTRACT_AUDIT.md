# BhoomiScan smart-contract implementation audit

## Scope and evidence

This report compares the current BhoomiScan backend repository with the client-provided archive `third-party-Design_improvment.zip` and the client brief. The archive was available at the supplied Downloads path and was inspected read-only; no files were extracted into the repository. Findings below are limited to source, tests, configuration, and execution evidence already available locally. No deployment address or live BSC verification is asserted.

## Current repository versus older ZIP

| Area | Older ZIP evidence | Current BhoomiScan implementation | Assessment |
|---|---|---|---|
| Application shape | React Native mobile application, Node server, `contracts/` Hardhat project; package dependencies include Ethers.js v6 and Hardhat | Current workspace is the API backend plus a `blockchain/` Hardhat project and Prisma PostgreSQL models | The archive is a separate mobile/backend codebase; its smart-contract service is not itself proof of a deployment |
| Contract data | `contracts/LandVerification.sol` stores `propertyId` and `ipfsCid` in each record; registration event includes both, and revocation event includes a free-form reason | `blockchain/contracts/LandVerification.sol` accepts only `bytes32 dataHash`; on-chain state has verification ID, hash, registering address, timestamp, and revoked flag | Current implementation removes property identifiers, CIDs, and free-form reasons from contract storage and event parameters, improving privacy |
| Contract API | Older ABI exposes `verifyProperty`, `getHashesByPropertyId`, and property/CID return values; `registerLandData` takes hash, property ID, and CID | Current ABI/provider uses hash-only `registerLandData`, `verifyLandData`, and `isOperator` for the integration | Current API is narrower and matches the client's hash-only privacy requirement; the older property/CID APIs were not copied |
| Backend integration | `server/blockchainService.js` uses Ethers.js v6 and includes registration, verification, property verification, revocation, and status methods; it passes/logs property ID and supports legacy private-key aliases | Current `src/integrations/smart-contract/bsc.provider.js` checks configured chain ID and operator authorization, submits only the document hash, preserves/reuses a pending transaction hash, and supports receipt recovery; document routes compute SHA-256 from uploaded bytes | Current backend integrates more tightly with document records and retry state while avoiding the older service's property-ID transaction payload |
| Deployment safeguards | Older `hardhat.config.js` defines local, BSC Testnet (97), and BSC Mainnet (56) networks; its deployment script has no visible testnet-only guard | Current `blockchain/scripts/deployLandVerification.js` rejects networks other than `bscTestnet` and checks chain ID `97`; the current mainnet alias is not a supported route through that guarded script | Current deployment script is more restrictive. No deployment was performed |
| Existing deployment evidence | The archive contains contract artifacts and deploy scripts; no deployment-record file or contract address was found in the archive paths inspected | Current configured contract address is empty in the last local configuration audit; no deployed address or explorer evidence is recorded | Neither local artifacts nor scripts establish that a live contract exists |

The older archive also contains an older blockchain guide and E2E-oriented test files. Their presence does not prove that its live RPC tests passed or that any deployed contract was compatible. No external chain or explorer was contacted for this audit.

## Client requirement checklist

| Requirement | Status | Evidence / limitation |
|---|---|---|
| Hash-only, privacy-conscious contract registration | **Implemented and locally verified** | Contract accepts only a nonzero `bytes32`; duplicate and authorization behavior covered by 7 local Hardhat tests |
| Authenticated document upload, SHA-256 of actual bytes, owner-scoped retrieval, version lineage | **Implemented; unit tested** | Backend unit tests cover hash, ownership, version ordering/conflicts, and verification behavior; no PostgreSQL-backed integration run |
| Browser upload with original filename | **Fixed; locally tested** | Application CORS now permits `X-File-Name`; regression tests exercise the application preflight response and confirm unauthenticated uploads still return 401 |
| Original-file storage | **Direct storage path live-smoke-verified** | Harmless text object uploaded/downloaded, byte and SHA-256 equality checked, exact-key delayed cleanup confirmed by later 404; not a PDF/image through the full API |
| Transaction status, retry/recovery, and duplicate prevention | **Implemented; unit tested** | Tests cover reuse of original transaction hash and pending/success/revert handling; no real receipt or transaction was exercised |
| Per-registration chain ID | **Implemented; unit tested** | Schema/service/provider persist the verified chain ID; migration remains unapplied |
| Smart-contract and backend tests | **Locally verified** | 2026-10-17 runs: 288 backend unit tests across 15 suites, including 23 integration URL guard tests and mocked PDF/PNG round-trips; earlier 7 local Hardhat tests passed |
| API and architecture documentation | **Present** | `docs/openapi.yaml` documents document routes and `docs/ARCHITECTURE.md` includes the flow diagram; YAML parse/root validation passed in the latest local verification |
| Beginner deployment instructions and cost assumptions | **Present, expanded** | See `SMART_CONTRACT_DEPLOYMENT.md`; cost arithmetic is explicitly illustrative, not measured |
| Database migration/integration | **Blocked pending isolation and approval** | Neon PostgreSQL is supported; prepare a disposable `bhoomiscan_test` database and explicit process-environment `TEST_DATABASE_URL`. Migrations and integration tests remain unrun; preserve application `DATABASE_URL` |
| BSC Testnet deployment, operator authorization, registration, and explorer verification | **Not performed; deployment not authorized** | Last local audit found provider disabled, no contract address, and no operator key configured. No RPC, explorer, or transaction was used |
| Mobile client wired to the new document API | **Not evidenced in this backend workspace** | The supplied archive has mobile code, but this task's current repository changes/documentation do not establish a client-side upload/history/verification integration |

## Verification record and limits

The safe local checks rerun on 2026-10-17, directly in the existing `vishal-changes` branch, were:

- `npm run test:unit -- --selectProjects unit --runInBand --no-cache` — PASS, 15 suites / 288 tests after the document workflow fixes. Explicit project selection excludes integration setup and its automatic migration; guard tests mock migration execution.
- `npm --prefix blockchain test -- --no-compile --network hardhat` — PASS, 7 local Hardhat tests on the in-process network, using existing compiled artifacts.
- `node node_modules/prisma/build/index.js validate` — PASS, launched through a Node child-process wrapper with a dummy local `DATABASE_URL` only for schema validation; no database connection or environment-file change. Prisma emitted a deprecation warning for `package.json#prisma` configuration.
- OpenAPI YAML parse and root-structure check — PASS; this was not a full OpenAPI schema conformance test.
- `git diff --check` — PASS.
- Earlier Stratus Development smoke test — PASS for a single harmless text object; cleanup was accepted for the exact key and a later read returned 404. Not rerun on 2026-10-17.

The new browser preflight regression failed before the CORS change because `X-File-Name` was missing from the allowed headers. Both new tests passed in the subsequent full unit run. This establishes local application behavior; it does not verify the AppSail gateway's separate CORS settings.

The document review reproduced two further bugs with mocked regression tests: a duplicate version upload could return a different series, and unconditional cleanup after an ambiguous insert failure could delete a possibly committed file. The service now enforces matching series for version duplicates and restricts insert-error cleanup to definite unique/foreign-key rejections. Other insert failures recover the row by its generated ID if visible, or retain the object and preserve the original error. Retained unreferenced objects may require later reconciliation; no orphan sweep is implemented. PDF/PNG round-trips through the real routes and Stratus client pass with HTTP/Prisma mocked. The prepared integration suite now has 17 cases, including concurrent successor constraints and insert recovery, but it has not run: actual SQL commits/constraints and cross-service behavior remain unverified. Syntax checks passed for all 10 modified/untracked JavaScript files; OpenAPI YAML syntax/root validation also passed.

### Integration database gate

Local configuration inspection confirmed Neon PostgreSQL: `DATABASE_URL_UNPOOLED` points to the same application database as `DATABASE_URL`, and `NEON_BRANCH` has a production-oriented label. `TEST_DATABASE_URL` was absent from both the process environment and `.env`. No isolated test endpoint could be established locally, and remote branches were not inspected. No credentials were printed.

Neon PostgreSQL does not require a local server. Keep the application `DATABASE_URL` unchanged. First check whether an existing isolated, disposable Neon branch/database can be used; a new project is not mandatory. The integration setup requires explicit process-environment `TEST_DATABASE_URL`, validates its PostgreSQL URL and exact `bhoomiscan_test` database name before migrations and worker setup, and has no fallback. It copies the validated URL into only the migration child's/test worker's `DATABASE_URL`; the Prisma schema has no `DIRECT_URL` setting. See the [safe Neon test configuration](../README.md#safe-neon-integration-testing).

The integration runner automatically executes `prisma migrate deploy`, and fixtures truncate tables with `RESTART IDENTITY CASCADE`. Database access, migrations, and destructive tests remain unapproved and unrun. The guard cannot verify that an endpoint belongs to a separate project: manual project/credential isolation review is still required before execution.

Database integration tests, the storage migration, full API-to-PostgreSQL document flow, deployed-contract compatibility, on-chain operator authorization, live registration, and live on-chain verification remain unverified. A deployment guide or local artifact must not be described as deployment evidence.

## Documentation follow-up

The original client brief also requested cost estimates for 100, 1,000, 10,000, and 100,000 documents/month and an assessment of batching/Merkle roots. Those assumptions and trade-offs are documented in `SMART_CONTRACT_DEPLOYMENT.md`. They are planning examples only; no live gas price or gas measurement is claimed.
