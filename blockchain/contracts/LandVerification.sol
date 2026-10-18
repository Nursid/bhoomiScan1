// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LandVerification
 * @notice Anchors document integrity hashes. It does not establish legal land ownership.
 * @dev Personal identifiers, property IDs, document contents and free-form metadata
 * are deliberately excluded from storage, events and transaction parameters.
 */
contract LandVerification {
    error Unauthorized(address caller);
    error DuplicateVerification(bytes32 dataHash);
    error RecordNotFound(bytes32 dataHash);
    error RecordNotFoundById(uint256 verificationId);
    error VerificationRevoked(bytes32 dataHash);
    error InvalidDataHash();
    error ZeroAddress();

    struct VerificationRecord {
        uint256 verificationId;
        bytes32 dataHash;
        address registeredBy;
        uint256 timestamp;
        bool isRevoked;
    }

    address public owner;
    uint256 public totalVerifications;

    mapping(bytes32 => VerificationRecord) public verifications;
    mapping(uint256 => bytes32) public verificationIdToHash;
    mapping(address => bool) public operators;

    event LandRecordRegistered(
        uint256 indexed verificationId,
        bytes32 indexed dataHash,
        address indexed registeredBy,
        uint256 timestamp
    );
    event LandRecordRevoked(
        uint256 indexed verificationId,
        bytes32 indexed dataHash,
        address indexed revokedBy,
        uint256 timestamp
    );
    event OperatorStatusChanged(address indexed operator, bool indexed status);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        _;
    }

    modifier onlyAuthorized() {
        if (msg.sender != owner && !operators[msg.sender]) revert Unauthorized(msg.sender);
        _;
    }

    constructor() {
        owner = msg.sender;
        operators[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit OperatorStatusChanged(msg.sender, true);
    }

    function setOperator(address operator, bool status) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        operators[operator] = status;
        emit OperatorStatusChanged(operator, status);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function isOperator(address account) external view returns (bool) {
        return account == owner || operators[account];
    }

    function registerLandData(bytes32 dataHash) external onlyAuthorized returns (uint256 verificationId) {
        if (dataHash == bytes32(0)) revert InvalidDataHash();
        if (verifications[dataHash].timestamp != 0) revert DuplicateVerification(dataHash);

        verificationId = ++totalVerifications;
        verifications[dataHash] = VerificationRecord({
            verificationId: verificationId,
            dataHash: dataHash,
            registeredBy: msg.sender,
            timestamp: block.timestamp,
            isRevoked: false
        });
        verificationIdToHash[verificationId] = dataHash;
        emit LandRecordRegistered(verificationId, dataHash, msg.sender, block.timestamp);
    }

    function verifyLandData(bytes32 dataHash)
        external
        view
        returns (bool exists, bool isValid, uint256 verificationId, address registeredBy, uint256 timestamp)
    {
        VerificationRecord storage record = verifications[dataHash];
        if (record.timestamp == 0) return (false, false, 0, address(0), 0);
        return (true, !record.isRevoked, record.verificationId, record.registeredBy, record.timestamp);
    }

    function getVerificationById(uint256 verificationId) external view returns (VerificationRecord memory) {
        bytes32 dataHash = verificationIdToHash[verificationId];
        if (dataHash == bytes32(0)) revert RecordNotFoundById(verificationId);
        return verifications[dataHash];
    }

    function getVerificationByHash(bytes32 dataHash) external view returns (VerificationRecord memory) {
        if (verifications[dataHash].timestamp == 0) revert RecordNotFound(dataHash);
        return verifications[dataHash];
    }

    function revokeVerification(uint256 verificationId) external onlyAuthorized {
        bytes32 dataHash = verificationIdToHash[verificationId];
        if (dataHash == bytes32(0)) revert RecordNotFoundById(verificationId);
        VerificationRecord storage record = verifications[dataHash];
        if (record.isRevoked) revert VerificationRevoked(dataHash);
        record.isRevoked = true;
        emit LandRecordRevoked(verificationId, dataHash, msg.sender, block.timestamp);
    }

    function revokeVerificationByHash(bytes32 dataHash) external onlyAuthorized {
        VerificationRecord storage record = verifications[dataHash];
        if (record.timestamp == 0) revert RecordNotFound(dataHash);
        if (record.isRevoked) revert VerificationRevoked(dataHash);
        record.isRevoked = true;
        emit LandRecordRevoked(record.verificationId, dataHash, msg.sender, block.timestamp);
    }
}
