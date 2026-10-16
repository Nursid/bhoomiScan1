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
});
