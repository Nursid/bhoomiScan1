// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LandVerification
 * @dev Production-grade decentralized land record verification smart contract for BNB Smart Chain (BSC).
 * Stores cryptographic hashes of verified land titles and off-chain metadata (IPFS CID, Property IDs).
 */
contract LandVerification {
    // -------------------------------------------------------------
    // Custom Errors (Gas-Optimized)
    // -------------------------------------------------------------
    error Unauthorized(address caller);
    error DuplicateVerification(bytes32 dataHash);
    error RecordNotFound(bytes32 dataHash);
    error RecordNotFoundById(uint256 verificationId);
    error VerificationRevoked(bytes32 dataHash);
    error InvalidDataHash();
    error InvalidPropertyId();
    error ZeroAddress();

    // -------------------------------------------------------------
    // Data Structures
    // -------------------------------------------------------------
    struct VerificationRecord {
        uint256 verificationId;
        bytes32 dataHash;
        string propertyId;
        string ipfsCid;
        address registeredBy;
        uint256 timestamp;
        bool isRevoked;
    }

    // -------------------------------------------------------------
    // State Variables
    // -------------------------------------------------------------
    address public owner;
    uint256 public totalVerifications;

    /// @notice Maps land record data hash to its verification record
    mapping(bytes32 => VerificationRecord) public verifications;

    /// @notice Maps sequential verification ID to data hash
    mapping(uint256 => bytes32) public verificationIdToHash;

    /// @notice Maps property identifier string to list of associated data hashes
    mapping(string => bytes32[]) private propertyIdToHashes;

    /// @notice Authorized backend operator wallets allowed to register/revoke verifications
    mapping(address => bool) public operators;

    // -------------------------------------------------------------
    // Events
    // -------------------------------------------------------------
    event LandRecordRegistered(
        uint256 indexed verificationId,
        bytes32 indexed dataHash,
        string propertyId,
        string ipfsCid,
        address indexed registeredBy,
        uint256 timestamp
    );

    event LandRecordRevoked(
        uint256 indexed verificationId,
        bytes32 indexed dataHash,
        address indexed revokedBy,
        string reason,
        uint256 timestamp
    );

    event OperatorStatusChanged(address indexed operator, bool indexed status);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // -------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------
    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert Unauthorized(msg.sender);
        }
        _;
    }

    modifier onlyAuthorized() {
        if (msg.sender != owner && !operators[msg.sender]) {
            revert Unauthorized(msg.sender);
        }
        _;
    }

    // -------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------
    constructor() {
        owner = msg.sender;
        operators[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit OperatorStatusChanged(msg.sender, true);
    }

    // -------------------------------------------------------------
    // Access Control Functions
    // -------------------------------------------------------------

    /**
     * @notice Grants or revokes operator status for an address.
     * @param operator The address to update.
     * @param status True to authorize, false to revoke.
     */
    function setOperator(address operator, bool status) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        operators[operator] = status;
        emit OperatorStatusChanged(operator, status);
    }

    /**
     * @notice Transfers contract ownership to a new address.
     * @param newOwner The new owner address.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    /**
     * @notice Checks if an address is an authorized operator or owner.
     * @param account The address to check.
     */
    function isOperator(address account) external view returns (bool) {
        return account == owner || operators[account];
    }

    // -------------------------------------------------------------
    // Core Verification Functions
    // -------------------------------------------------------------

    /**
     * @notice Registers a new verified land record on the blockchain.
     * @param dataHash Deterministic cryptographic SHA-256 / keccak256 hash of the canonical land record JSON.
     * @param propertyId Official property / deed identifier (e.g., registration number, survey number).
     * @param ipfsCid Optional IPFS CID containing encrypted metadata or document attachment.
     * @return verificationId The unique sequential ID assigned to this record.
     */
    function registerLandData(
        bytes32 dataHash,
        string calldata propertyId,
        string calldata ipfsCid
    ) external onlyAuthorized returns (uint256 verificationId) {
        if (dataHash == bytes32(0)) revert InvalidDataHash();
        if (verifications[dataHash].timestamp != 0) {
            revert DuplicateVerification(dataHash);
        }

        verificationId = ++totalVerifications;

        VerificationRecord storage record = verifications[dataHash];
        record.verificationId = verificationId;
        record.dataHash = dataHash;
        record.propertyId = propertyId;
        record.ipfsCid = ipfsCid;
        record.registeredBy = msg.sender;
        record.timestamp = block.timestamp;
        record.isRevoked = false;

        verificationIdToHash[verificationId] = dataHash;

        if (bytes(propertyId).length > 0) {
            propertyIdToHashes[propertyId].push(dataHash);
        }

        emit LandRecordRegistered(
            verificationId,
            dataHash,
            propertyId,
            ipfsCid,
            msg.sender,
            block.timestamp
        );

        return verificationId;
    }

    /**
     * @notice Verifies whether a given land record data hash exists and is valid (not revoked).
     * @param dataHash Cryptographic hash of the land record.
     * @return exists True if the record was ever registered.
     * @return isValid True if the record exists and is active (not revoked).
     * @return verificationId Sequential ID of the verification.
     * @return propertyId Property identifier registered with this hash.
     * @return ipfsCid IPFS CID attached to this record.
     * @return registeredBy Address of the operator who registered the record.
     * @return timestamp Block timestamp when registered.
     */
    function verifyLandData(bytes32 dataHash)
        external
        view
        returns (
            bool exists,
            bool isValid,
            uint256 verificationId,
            string memory propertyId,
            string memory ipfsCid,
            address registeredBy,
            uint256 timestamp
        )
    {
        VerificationRecord storage record = verifications[dataHash];
        if (record.timestamp == 0) {
            return (false, false, 0, "", "", address(0), 0);
        }

        return (
            true,
            !record.isRevoked,
            record.verificationId,
            record.propertyId,
            record.ipfsCid,
            record.registeredBy,
            record.timestamp
        );
    }

    /**
     * @notice Verifies if a given hash matches the expected property identifier.
     * @param dataHash Cryptographic hash of the land record.
     * @param propertyId Expected property identifier.
     * @return isValidMatch True if hash exists, is active, and propertyId matches.
     * @return verificationId Sequential ID of the record.
     * @return ipfsCid IPFS CID attached to the record.
     * @return registeredBy Address that registered the verification.
     * @return timestamp Block timestamp when registered.
     */
    function verifyProperty(
        bytes32 dataHash,
        string calldata propertyId
    )
        external
        view
        returns (
            bool isValidMatch,
            uint256 verificationId,
            string memory ipfsCid,
            address registeredBy,
            uint256 timestamp
        )
    {
        VerificationRecord storage record = verifications[dataHash];
        if (record.timestamp == 0 || record.isRevoked) {
            return (false, 0, "", address(0), 0);
        }

        bool matchFound = (keccak256(bytes(record.propertyId)) == keccak256(bytes(propertyId)));
        if (!matchFound) {
            return (false, 0, "", address(0), 0);
        }

        return (
            true,
            record.verificationId,
            record.ipfsCid,
            record.registeredBy,
            record.timestamp
        );
    }

    /**
     * @notice Retrieves all data hashes registered for a specific property ID.
     * @param propertyId Property identifier string.
     */
    function getHashesByPropertyId(string calldata propertyId)
        external
        view
        returns (bytes32[] memory)
    {
        return propertyIdToHashes[propertyId];
    }

    /**
     * @notice Retrieves verification record by sequential ID.
     * @param verificationId The sequential ID of the record.
     */
    function getVerificationById(uint256 verificationId)
        external
        view
        returns (VerificationRecord memory)
    {
        bytes32 hash = verificationIdToHash[verificationId];
        if (hash == bytes32(0)) revert RecordNotFoundById(verificationId);
        return verifications[hash];
    }

    /**
     * @notice Retrieves verification record by data hash.
     * @param dataHash The cryptographic hash of the record.
     */
    function getVerificationByHash(bytes32 dataHash)
        external
        view
        returns (VerificationRecord memory)
    {
        if (verifications[dataHash].timestamp == 0) revert RecordNotFound(dataHash);
        return verifications[dataHash];
    }

    // -------------------------------------------------------------
    // Revocation Functions
    // -------------------------------------------------------------

    /**
     * @notice Revokes a verification by ID (e.g., in case of court dispute or invalidation).
     * @param verificationId Sequential ID of the record to revoke.
     * @param reason Human-readable explanation for revocation.
     */
    function revokeVerification(uint256 verificationId, string calldata reason)
        external
        onlyAuthorized
    {
        bytes32 hash = verificationIdToHash[verificationId];
        if (hash == bytes32(0)) revert RecordNotFoundById(verificationId);

        VerificationRecord storage record = verifications[hash];
        if (record.isRevoked) revert VerificationRevoked(hash);

        record.isRevoked = true;

        emit LandRecordRevoked(
            verificationId,
            hash,
            msg.sender,
            reason,
            block.timestamp
        );
    }

    /**
     * @notice Revokes a verification by its data hash.
     * @param dataHash Cryptographic hash of the record to revoke.
     * @param reason Human-readable explanation for revocation.
     */
    function revokeVerificationByHash(bytes32 dataHash, string calldata reason)
        external
        onlyAuthorized
    {
        VerificationRecord storage record = verifications[dataHash];
        if (record.timestamp == 0) revert RecordNotFound(dataHash);
        if (record.isRevoked) revert VerificationRevoked(dataHash);

        record.isRevoked = true;

        emit LandRecordRevoked(
            record.verificationId,
            dataHash,
            msg.sender,
            reason,
            block.timestamp
        );
    }
}
