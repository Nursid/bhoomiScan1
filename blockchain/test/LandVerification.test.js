const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LandVerification", function () {
  let contract;
  let owner;
  let operator;
  let stranger;
  const HASH = `0x${"a".repeat(64)}`;
  const OTHER_HASH = `0x${"b".repeat(64)}`;
  const ZERO_HASH = `0x${"0".repeat(64)}`;

  beforeEach(async function () {
    [owner, operator, stranger] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("LandVerification");
    contract = await factory.deploy();
    await contract.waitForDeployment();
  });

  it("sets the deployer as owner and initial operator", async function () {
    expect(await contract.owner()).to.equal(owner.address);
    expect(await contract.isOperator(owner.address)).to.equal(true);
    expect(await contract.totalVerifications()).to.equal(0n);
  });

  it("allows the owner to grant an operator and blocks unauthorized registration", async function () {
    await contract.setOperator(operator.address, true);
    expect(await contract.isOperator(operator.address)).to.equal(true);
    await expect(contract.connect(stranger).registerLandData(HASH))
      .to.be.revertedWithCustomError(contract, "Unauthorized");
  });

  it("registers only the document hash and emits a privacy-safe event", async function () {
    await contract.setOperator(operator.address, true);
    const tx = await contract.connect(operator).registerLandData(HASH);
    const receipt = await tx.wait();
    const parsed = receipt.logs
      .map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } })
      .find((log) => log?.name === "LandRecordRegistered");

    expect(parsed.args.verificationId).to.equal(1n);
    expect(parsed.args.dataHash).to.equal(HASH);
    expect(parsed.args.registeredBy).to.equal(operator.address);
    expect(parsed.fragment.inputs.map((input) => input.name)).to.deep.equal([
      "verificationId", "dataHash", "registeredBy", "timestamp",
    ]);
    expect((await contract.getVerificationByHash(HASH)).dataHash).to.equal(HASH);
  });

  it("rejects a zero hash and duplicate registrations", async function () {
    await expect(contract.registerLandData(ZERO_HASH))
      .to.be.revertedWithCustomError(contract, "InvalidDataHash");
    await contract.registerLandData(HASH);
    await expect(contract.registerLandData(HASH))
      .to.be.revertedWithCustomError(contract, "DuplicateVerification");
  });

  it("returns a false result for unknown hashes and record details for known hashes", async function () {
    const missing = await contract.verifyLandData(OTHER_HASH);
    expect(missing.exists).to.equal(false);
    expect(missing.isValid).to.equal(false);
    expect(missing.verificationId).to.equal(0n);

    await contract.registerLandData(HASH);
    const result = await contract.verifyLandData(HASH);
    expect(result.exists).to.equal(true);
    expect(result.isValid).to.equal(true);
    expect(result.verificationId).to.equal(1n);
    expect(result.registeredBy).to.equal(owner.address);
    expect(result.timestamp).to.be.greaterThan(0n);
  });

  it("allows authorized revocation without putting a free-form reason on-chain", async function () {
    await contract.setOperator(operator.address, true);
    await contract.registerLandData(HASH);
    await expect(contract.connect(operator).revokeVerification(1))
      .to.emit(contract, "LandRecordRevoked");
    const result = await contract.verifyLandData(HASH);
    expect(result.exists).to.equal(true);
    expect(result.isValid).to.equal(false);
    await expect(contract.connect(operator).revokeVerification(1))
      .to.be.revertedWithCustomError(contract, "VerificationRevoked");
  });

  it("rejects owner-only actions from non-owners", async function () {
    await expect(contract.connect(stranger).setOperator(operator.address, true))
      .to.be.revertedWithCustomError(contract, "Unauthorized");
    await expect(contract.connect(stranger).transferOwnership(operator.address))
      .to.be.revertedWithCustomError(contract, "Unauthorized");
  });

  it("rejects zero addresses for operator and ownership changes", async function () {
    await expect(contract.setOperator(ethers.ZeroAddress, true))
      .to.be.revertedWithCustomError(contract, "ZeroAddress");
    await expect(contract.transferOwnership(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(contract, "ZeroAddress");
    expect(await contract.owner()).to.equal(owner.address);
  });

  it("removes operator write access while retaining public read access", async function () {
    await contract.setOperator(operator.address, true);
    await contract.connect(operator).registerLandData(HASH);
    await contract.setOperator(operator.address, false);
    expect(await contract.isOperator(operator.address)).to.equal(false);
    await expect(contract.connect(operator).registerLandData(OTHER_HASH))
      .to.be.revertedWithCustomError(contract, "Unauthorized");
    await expect(contract.connect(operator).revokeVerification(1))
      .to.be.revertedWithCustomError(contract, "Unauthorized");
    await expect(contract.connect(operator).revokeVerificationByHash(HASH))
      .to.be.revertedWithCustomError(contract, "Unauthorized");
    expect((await contract.connect(stranger).verifyLandData(HASH)).isValid).to.equal(true);
  });

  it("rejects lookups and revocations of missing records", async function () {
    await expect(contract.getVerificationById(1))
      .to.be.revertedWithCustomError(contract, "RecordNotFoundById").withArgs(1);
    await expect(contract.getVerificationByHash(HASH))
      .to.be.revertedWithCustomError(contract, "RecordNotFound").withArgs(HASH);
    await expect(contract.revokeVerification(1))
      .to.be.revertedWithCustomError(contract, "RecordNotFoundById").withArgs(1);
    await expect(contract.revokeVerificationByHash(HASH))
      .to.be.revertedWithCustomError(contract, "RecordNotFound").withArgs(HASH);
    expect(await contract.totalVerifications()).to.equal(0n);
  });

  it("revokes by hash without erasing registration history or permitting re-registration", async function () {
    await contract.registerLandData(HASH);
    const before = await contract.getVerificationById(1);
    const tx = await contract.revokeVerificationByHash(HASH);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    await expect(tx).to.emit(contract, "LandRecordRevoked")
      .withArgs(1, HASH, owner.address, block.timestamp);
    const after = await contract.getVerificationByHash(HASH);
    expect(after.isRevoked).to.equal(true);
    expect(after.verificationId).to.equal(before.verificationId);
    expect(after.registeredBy).to.equal(before.registeredBy);
    expect(after.timestamp).to.equal(before.timestamp);
    expect(await contract.verificationIdToHash(1)).to.equal(HASH);
    expect(await contract.totalVerifications()).to.equal(1n);
    await expect(contract.registerLandData(HASH))
      .to.be.revertedWithCustomError(contract, "DuplicateVerification");
    await expect(contract.revokeVerificationByHash(HASH))
      .to.be.revertedWithCustomError(contract, "VerificationRevoked");
  });

  it("preserves the former owner's explicit operator grant until the new owner revokes it", async function () {
    await contract.transferOwnership(operator.address);
    expect(await contract.owner()).to.equal(operator.address);
    expect(await contract.isOperator(operator.address)).to.equal(true);
    expect(await contract.isOperator(owner.address)).to.equal(true);
    await expect(contract.setOperator(stranger.address, true))
      .to.be.revertedWithCustomError(contract, "Unauthorized");
    await contract.connect(operator).setOperator(owner.address, false);
    expect(await contract.isOperator(owner.address)).to.equal(false);
    await expect(contract.registerLandData(HASH))
      .to.be.revertedWithCustomError(contract, "Unauthorized");
    await contract.connect(operator).registerLandData(HASH);
  });
});
