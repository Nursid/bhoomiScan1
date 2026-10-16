# BhoomiScan smart contract: beginner deployment guide

This guide explains the existing `LandVerification` implementation and the future BSC Testnet procedure. It is instructional documentation only: no deployment or live blockchain transaction has been performed. A later user instruction restricted work to local testing and did not authorize a public-network deployment. Treat any testnet deployment or registration as requiring fresh explicit approval.

## Current evidence and blockers

| Area | Verified evidence | Still unverified or blocked |
|---|---|---|
| Contract | Hash-only registration, duplicate rejection, operator authorization, revocation, and read-only verification; 7 local Hardhat tests pass | No deployed BSC Testnet contract was inspected |
| Backend | 252 unit tests across 13 suites pass, including document hashing, versioning, chain ID, and transaction retry/recovery cases | No database-backed end-to-end upload and chain-registration test |
| Stratus | One harmless Development-bucket text-object smoke test passed upload, download, byte/SHA-256 comparison, and exact-key delayed cleanup; a later GET returned 404 | This does not verify PDF/image upload through the API, the database, or bucket console ACL configuration |
| PostgreSQL | Prisma schema validation passes; migrations exist | Migration is unapplied; integration tests are blocked while the dedicated local PostgreSQL test database is unavailable |
| BSC Testnet | Code has a chain-ID 97 guard and the deploy script is testnet-only | The provider is disabled; no contract address or operator key is configured; RPC connectivity and operator authorization are unverified |

The Stratus evidence and its limits are recorded in [`STRATUS_STORAGE.md`](STRATUS_STORAGE.md). The data flow is already shown in [`ARCHITECTURE.md`](ARCHITECTURE.md); it is not repeated here.

## What the contract records

The API hashes the exact uploaded file bytes with SHA-256 and passes only the resulting `bytes32` hash to `registerLandData`. The contract records the hash, a sequential verification ID, registering wallet address, block timestamp, and revocation flag. It does not prove legal ownership or validate government records. Original PDFs/images, property identifiers, names, contact details, and other document contents are not contract inputs. PostgreSQL is intended to hold owner-scoped history, version lineage, transaction state, chain ID, and Stratus object references; the original file bytes are stored in Stratus.

## Step 1 — Understand the blockchain's role

- **Action:** Treat the chain as a public, append-only timestamped record of a document hash. The hash helps detect whether bytes match what was registered.
- **Expected result:** A verifier can compare a newly computed file hash with the registered hash and inspect the transaction history.
- **Common mistakes:** A matching hash does not prove land ownership, document truth, or government approval. Do not submit a document or personal data to the chain.

## Step 2 — Understand this smart contract

- **Action:** Review `blockchain/contracts/LandVerification.sol` and its local tests. Registration accepts one nonzero hash; duplicate registration reverts. The owner can add or remove operators.
- **Expected result:** Only the hash and contract-defined registration metadata are stored on chain; read-only calls can check whether a hash exists and whether it is revoked.
- **Common mistakes:** Do not add property IDs, IPFS URLs, revocation reasons, or document bytes to transaction parameters. A contract is not an official land registry.

## Step 3 — Prepare a dedicated test wallet

- **Action:** If a testnet run is later approved, create a new wallet only for BSC Testnet. Keep its recovery phrase offline and put its private key only in an approved secret store or a local untracked secret file. Use testnet BNB from a faucet if needed.
- **Expected result:** The test wallet has a public address and test-only signing authority; it holds no valuable mainnet assets.
- **Common mistakes:** Never reuse a personal/funded wallet, paste a private key into chat, commit it, or include it in screenshots or logs. A faucet may be unavailable; do not substitute real funds.

## Step 4 — Distinguish wallet and contract addresses

- **Action:** Record the test wallet address separately from the address returned after deploying `LandVerification`.
- **Expected result:** The wallet signs transactions; the contract address identifies the deployed program. The deployer becomes the initial owner and operator.
- **Common mistakes:** Do not put the wallet address in `LAND_VERIFICATION_CONTRACT_ADDRESS` or confuse a transaction hash with either address.

## Step 5 — Select the network deliberately

- **Action:** Use BSC Testnet (chain ID `97`) for an approved integration trial. The current Solidity/Ethers.js integration targets BSC. Ethereum L1, Polygon PoS, or an EVM-compatible L2 would require a separate network, security, operational, and cost review.
- **Expected result:** Test transactions remain on the test network and can be checked with the BSC Testnet explorer.
- **Common mistakes:** Do not infer the network from an RPC URL alone. Confirm chain ID `97` before signing. Testnet BNB is not mainnet BNB, and the project has not been benchmarked on alternative chains.

## Step 6 — Understand the cost assumptions

- **Action:** For a planning-only estimate, assume `100,000` gas per registration, `2,000,000` gas for deployment, and `3 gwei`. Calculate `fee in BNB = gas used × gas price in gwei ÷ 1,000,000,000`.
- **Expected result:** The example estimates are:

  | Activity / monthly document count | Assumed gas | Example fee |
  |---|---:|---:|
  | One registration | 100,000 | 0.0003 BNB |
  | One-time deployment | 2,000,000 | 0.006 BNB |
  | 100 documents/month | 10,000,000 | 0.03 BNB/month |
  | 1,000 documents/month | 100,000,000 | 0.3 BNB/month |
  | 10,000 documents/month | 1,000,000,000 | 3 BNB/month |
  | 100,000 documents/month | 10,000,000,000 | 30 BNB/month |

  These are arithmetic examples, not a fee quote or measured contract gas. They exclude RPC, storage, database, hosting, monitoring, and operations costs.
- **Common mistakes:** Do not call the 3 gwei assumption a current gas price. Actual gas use and price change; replace assumptions with approved test receipt measurements and a contemporaneous price before budgeting.

## Step 7 — Know the tools and run local checks

- **Action:** Solidity defines the contract, Hardhat compiles/tests/deploys it, Ethers.js v6 connects the backend to EVM networks, and an RPC endpoint carries requests to a chain. From the repository root, local checks are:

  ```powershell
  npm --prefix blockchain run compile
  npm run contract:test
  ```

- **Expected result:** Compilation succeeds and Hardhat runs the local contract tests without a public RPC or funded wallet.
- **Common mistakes:** Do not run a deployment script to test compilation. Avoid changing `.env` or network configuration during local checks.

## Step 8 — Deploy to BSC Testnet only after explicit approval

- **Action:** A future approved operator must first set the required testnet configuration in the secret/configuration store, confirm the RPC reports chain ID `97`, and then run:

  ```powershell
  npm run contract:deploy:bsc-testnet
  ```

  The script refuses non-`bscTestnet` networks and checks the chain ID before deployment. This guide does not authorize running it.
- **Expected result:** If a deployment is approved and succeeds, the output provides a contract address and deployment transaction hash. Save both as deployment evidence without saving secrets.
- **Common mistakes:** Do not run without explicit approval, do not select mainnet, do not use a valuable wallet, and do not treat the repository's `contract:deploy:bsc-mainnet` alias as supported. The script guard rejects networks other than testnet.

## Step 9 — Configure the contract and operator

- **Action:** After an approved deployment, configure the backend with the verified address and testnet settings:

  | Variable | Purpose |
  |---|---|
  | `SMART_CONTRACT_PROVIDER` | Set to `bsc` to select the BSC provider |
  | `BSC_RPC_URL` | Approved BSC Testnet RPC URL |
  | `BSC_CHAIN_ID` | `97` |
  | `BSC_EXPLORER_TX_URL` | BSC Testnet transaction link base |
  | `LAND_VERIFICATION_CONTRACT_ADDRESS` | Address returned by the approved deployment |
  | `OPERATOR_PRIVATE_KEY` | Dedicated testnet deployer/operator key; secret |

  If the API signer differs from the deployer, the contract owner must authorize it with `setOperator` in a separately approved transaction.
- **Expected result:** The backend can perform a read-only chain check; before registration, it checks the configured chain ID and that its signer is an authorized operator.
- **Common mistakes:** Do not hardcode or commit the private key. Do not assume a valid-looking address is a deployed compatible contract. A read-only verification needs the RPC, chain ID, and address, but not the private key.

## Step 10 — Test one document only in an approved testnet run

- **Action:** After database setup, deployment, and separate approval for a test registration, use a synthetic non-sensitive PDF/image with the authenticated `POST /api/v1/documents` endpoint. The API computes SHA-256 from the exact uploaded bytes; the backend submits only the hash. Then check registration history and use the read-only `GET /api/v1/documents/{id}/verify` endpoint or `POST /api/v1/documents/verify` with the same file. Inspect the transaction hash on BSC Testnet Explorer.
- **Expected result:** The stored document hash matches the file's SHA-256, the registration reaches a confirmed status, and read-only verification reports the matching on-chain record. Keep the explorer transaction hash with the test evidence.
- **Common mistakes:** Do not use a real person's land document for a smoke test, do not claim a pending transaction is confirmed, and do not interpret a transaction receipt alone as proof of document authenticity. These endpoints have not been exercised end-to-end with PostgreSQL and a deployed BSC contract.

## Step 11 — Plan production separately

- **Action:** Before any production launch, require a separate reviewed and approved plan covering threat review, secret management, backup/recovery, monitoring, tested migration, operational ownership, and current fee measurements. The original client brief explicitly requires approval before mainnet deployment.
- **Expected result:** Production is considered only after testnet evidence, database integration, independent contract/address checks, and a rollback/incident plan are reviewed.
- **Common mistakes:** Do not treat testnet success as a mainnet approval. Blockchain writes cannot be rolled back; a backend can pause new writes, but existing chain history remains. The current deploy script is testnet-only.

## Step 12 — Maintain the integration

- **Action:** Monitor pending transaction age, retry schedule, receipt status, operator gas balance, and API errors. The worker recovers the original transaction hash before considering any new registration. Rotate an operator by authorizing a new key and revoking the old one through approved owner transactions. The current contract is not a proxy/upgradeable contract; a changed contract would require a new deployment and an explicit data migration plan.
- **Expected result:** Pending, successful, and reverted registrations remain distinguishable, and key rotation or contract replacement has recorded approval and evidence.
- **Common mistakes:** Do not resubmit a pending hash as a new transaction, revoke the only authorized operator before its replacement is confirmed, or assume the old contract's state moves to a new address.

## Batching and Merkle-root trade-offs

The current contract registers one document hash per call. This keeps lookup and event history simple and aligns with per-document version records, but each document incurs its own transaction overhead and persistent state write.

- **Batch registration:** A future function could accept an array of hashes in one transaction, reducing repeated transaction-envelope overhead. Each hash still needs validation, storage, and usually an event, so total gas remains roughly proportional to the number of documents. Large batches approach block gas limits, increase all-or-nothing failure risk, and make retries/idempotency more complex. The current contract has no batch method.
- **Merkle root:** A batch can be represented by one Merkle root stored on chain, with each document hash and proof retained off chain. One root transaction can anchor many documents, but verification then requires a durable manifest and a correct Merkle proof; the API/contract must define proof format, batch identity, version lineage, revocation, and data-availability responsibilities. The current contract has no Merkle-root or proof-verification method.
- **Decision for this implementation:** Keep individual hash registration for the current scope. At the illustrative assumptions above, 1,000 documents/month are estimated at `0.3 BNB/month` using 100,000 gas per document and 3 gwei, but this is not measured. Consider batching or a Merkle design only after approved testnet gas measurements and evidence that transaction volume justifies the extra implementation and operational complexity. No Merkle savings are quantified here.

## Existing completion checklist

- [x] Local contract tests pass (7 tests).
- [x] Backend unit tests pass (252 tests across 13 suites).
- [x] A limited Stratus Development smoke test verified upload, download, SHA-256 integrity, and delayed cleanup for one harmless text object.
- [ ] Dedicated local PostgreSQL test database is available; migration and database integration tests remain blocked.
- [ ] BSC testnet deployment and address verification are pending and not currently authorized.
- [ ] Testnet operator authorization, a confirmed registration receipt, and live document verification remain unverified.
- [ ] Update fee assumptions from an approved live test receipt before production budgeting.

No live BSC registration, testnet deployment, production deployment, or measured network-cost result is claimed by this guide.
