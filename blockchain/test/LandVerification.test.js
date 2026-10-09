const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LandVerification Contract", function () {
  let landVerification;
  let owner;
  let operator1;
  let operator2;
  let unauthorizedUser;

  const SAMPLE_HASH_1 = "0x" + "a".repeat(64);
  const SAMPLE_HASH_2 = "0x" + "b".repeat(64);
  const ZERO_HASH = "0x" + "0".repeat(64);
  const PROPERTY_ID_1 = "MH-PUNE-2024-00129";
  const PROPERTY_ID_2 = "PB-AMR-2024-99812";
  const IPFS_CID_1 = "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco";

  beforeEach(async function () {
    [owner, operator1, operator2, unauthorizedUser] = await ethers.getSigners();

    const LandVerification = await ethers.getContractFactory("LandVerification");
    landVerification = await LandVerification.deploy();
    await landVerification.waitForDeployment();
  });

  describe("Deployment & Initial State", function () {
    it("Should set deployer as owner and initial operator", async function () {
      expect(await landVerification.owner()).to.equal(owner.address);
      expect(await landVerification.isOperator(owner.address)).to.be.true;
      expect(await landVerification.totalVerifications()).to.equal(0);
    });

    it("Should not have other accounts as operators by default", async function () {
      expect(await landVerification.isOperator(unauthorizedUser.address)).to.be.false;
    });
  });

  describe("Operator & Access Control", function () {
    it("Owner can grant and revoke operator role", async function () {
      await expect(landVerification.setOperator(operator1.address, true))
        .to.emit(landVerification, "OperatorStatusChanged")
        .withArgs(operator1.address, true);

      expect(await landVerification.isOperator(operator1.address)).to.be.true;

      await expect(landVerification.setOperator(operator1.address, false))
        .to.emit(landVerification, "OperatorStatusChanged")
        .withArgs(operator1.address, false);

      expect(await landVerification.isOperator(operator1.address)).to.be.false;
    });

    it("Non-owner cannot modify operators", async function () {
      await expect(
        landVerification.connect(unauthorizedUser).setOperator(operator1.address, true)
      ).to.be.revertedWithCustomError(landVerification, "Unauthorized");
    });

    it("Owner can transfer ownership", async function () {
      await expect(landVerification.transferOwnership(operator1.address))
        .to.emit(landVerification, "OwnershipTransferred")
        .withArgs(owner.address, operator1.address);

      expect(await landVerification.owner()).to.equal(operator1.address);
    });
  });

  describe("Registering Land Verification", function () {
    beforeEach(async function () {
      await landVerification.setOperator(operator1.address, true);
    });

    it("Authorized operator can register land verification", async function () {
      const tx = await landVerification
        .connect(operator1)
        .registerLandData(SAMPLE_HASH_1, PROPERTY_ID_1, IPFS_CID_1);

      const receipt = await tx.wait();

      expect(await landVerification.totalVerifications()).to.equal(1);

      // Verify event emission
      const event = receipt.logs.find((log) => {
        try {
          const parsed = landVerification.interface.parseLog(log);
          return parsed.name === "LandRecordRegistered";
        } catch {
          return false;
        }
      });

      expect(event).to.not.be.undefined;
      const parsed = landVerification.interface.parseLog(event);
      expect(parsed.args.verificationId).to.equal(1n);
      expect(parsed.args.dataHash).to.equal(SAMPLE_HASH_1);
      expect(parsed.args.propertyId).to.equal(PROPERTY_ID_1);
      expect(parsed.args.ipfsCid).to.equal(IPFS_CID_1);
      expect(parsed.args.registeredBy).to.equal(operator1.address);
    });

    it("Rejects registration from unauthorized caller", async function () {
      await expect(
        landVerification
          .connect(unauthorizedUser)
          .registerLandData(SAMPLE_HASH_1, PROPERTY_ID_1, IPFS_CID_1)
      ).to.be.revertedWithCustomError(landVerification, "Unauthorized");
    });

    it("Rejects zero data hash", async function () {
      await expect(
        landVerification
          .connect(operator1)
          .registerLandData(ZERO_HASH, PROPERTY_ID_1, IPFS_CID_1)
      ).to.be.revertedWithCustomError(landVerification, "InvalidDataHash");
    });

    it("Rejects duplicate data hash registration", async function () {
      await landVerification
        .connect(operator1)
        .registerLandData(SAMPLE_HASH_1, PROPERTY_ID_1, IPFS_CID_1);

      await expect(
        landVerification
          .connect(operator1)
          .registerLandData(SAMPLE_HASH_1, PROPERTY_ID_2, "QmOther")
      ).to.be.revertedWithCustomError(landVerification, "DuplicateVerification");
    });
  });

  describe("Querying & Verification", function () {
    beforeEach(async function () {
      await landVerification.setOperator(operator1.address, true);
      await landVerification
        .connect(operator1)
        .registerLandData(SAMPLE_HASH_1, PROPERTY_ID_1, IPFS_CID_1);
    });

    it("verifyLandData returns correct verification details for existing record", async function () {
      const result = await landVerification.verifyLandData(SAMPLE_HASH_1);
      expect(result.exists).to.be.true;
      expect(result.isValid).to.be.true;
      expect(result.verificationId).to.equal(1n);
      expect(result.propertyId).to.equal(PROPERTY_ID_1);
      expect(result.ipfsCid).to.equal(IPFS_CID_1);
      expect(result.registeredBy).to.equal(operator1.address);
      expect(result.timestamp).to.be.greaterThan(0n);
    });

    it("verifyLandData returns exists=false for unregistered hash", async function () {
      const result = await landVerification.verifyLandData(SAMPLE_HASH_2);
      expect(result.exists).to.be.false;
      expect(result.isValid).to.be.false;
      expect(result.verificationId).to.equal(0n);
    });

    it("verifyProperty validates matching property ID and hash", async function () {
      const matchResult = await landVerification.verifyProperty(SAMPLE_HASH_1, PROPERTY_ID_1);
      expect(matchResult.isValidMatch).to.be.true;
      expect(matchResult.verificationId).to.equal(1n);

      const mismatchResult = await landVerification.verifyProperty(SAMPLE_HASH_1, "DIFFERENT-PROP-ID");
      expect(mismatchResult.isValidMatch).to.be.false;
    });

    it("getHashesByPropertyId returns list of hashes", async function () {
      const hashes = await landVerification.getHashesByPropertyId(PROPERTY_ID_1);
      expect(hashes.length).to.equal(1);
      expect(hashes[0]).to.equal(SAMPLE_HASH_1);
    });

    it("getVerificationById and getVerificationByHash return valid structs", async function () {
      const byId = await landVerification.getVerificationById(1);
      expect(byId.dataHash).to.equal(SAMPLE_HASH_1);
      expect(byId.propertyId).to.equal(PROPERTY_ID_1);

      const byHash = await landVerification.getVerificationByHash(SAMPLE_HASH_1);
      expect(byHash.verificationId).to.equal(1n);
      expect(byHash.isRevoked).to.be.false;
    });
  });

  describe("Revocation Workflow", function () {
    beforeEach(async function () {
      await landVerification.setOperator(operator1.address, true);
      await landVerification
        .connect(operator1)
        .registerLandData(SAMPLE_HASH_1, PROPERTY_ID_1, IPFS_CID_1);
    });

    it("Authorized operator can revoke verification by ID", async function () {
      await expect(
        landVerification
          .connect(operator1)
          .revokeVerification(1, "Court injunction received")
      )
        .to.emit(landVerification, "LandRecordRevoked")
        .withArgs(1n, SAMPLE_HASH_1, operator1.address, "Court injunction received", (val) => val > 0n);

      const record = await landVerification.getVerificationById(1);
      expect(record.isRevoked).to.be.true;

      const verifyData = await landVerification.verifyLandData(SAMPLE_HASH_1);
      expect(verifyData.exists).to.be.true;
      expect(verifyData.isValid).to.be.false;

      const propCheck = await landVerification.verifyProperty(SAMPLE_HASH_1, PROPERTY_ID_1);
      expect(propCheck.isValidMatch).to.be.false;
    });

    it("Authorized operator can revoke verification by Hash", async function () {
      await landVerification
        .connect(operator1)
        .revokeVerificationByHash(SAMPLE_HASH_1, "Title disputed");

      const record = await landVerification.getVerificationByHash(SAMPLE_HASH_1);
      expect(record.isRevoked).to.be.true;
    });

    it("Cannot revoke an already revoked record", async function () {
      await landVerification
        .connect(operator1)
        .revokeVerification(1, "First revocation");

      await expect(
        landVerification
          .connect(operator1)
          .revokeVerification(1, "Second revocation attempt")
      ).to.be.revertedWithCustomError(landVerification, "VerificationRevoked");
    });

    it("Unauthorized account cannot revoke", async function () {
      await expect(
        landVerification
          .connect(unauthorizedUser)
          .revokeVerification(1, "Unauthorized attempt")
      ).to.be.revertedWithCustomError(landVerification, "Unauthorized");
    });
  });
});
