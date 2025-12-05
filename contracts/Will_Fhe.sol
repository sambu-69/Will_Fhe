pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract WillFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Encrypted data storage
    mapping(uint256 => mapping(address => euint32)) public encryptedWillAmounts;
    mapping(uint256 => mapping(address => euint32)) public encryptedWillReleaseTimes;
    mapping(uint256 => mapping(address => euint32)) public encryptedWillConditionsMet;

    // Access control for beneficiaries/executors (simplified for example)
    mapping(uint256 => mapping(address => bool)) public isBeneficiary;
    mapping(uint256 => mapping(address => bool)) public isExecutor;

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotBeneficiary();
    error NotExecutor();

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool paused);
    event CooldownSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event WillSubmitted(address indexed submitter, uint256 batchId, address indexed willOwner);
    event DecryptionRequested(uint256 requestId, uint256 batchId, address indexed requester);
    event DecryptionCompleted(uint256 requestId, uint256 batchId, address indexed requester, uint256 amount, uint256 releaseTime, bool conditionsMet);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true; // Owner is a provider by default
        emit ProviderAdded(owner);
        cooldownSeconds = 60; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        isProvider[newOwner] = true; // New owner becomes a provider
        emit ProviderAdded(newOwner);
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider] && provider != owner) { // Cannot remove owner as provider
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldown(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSet(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyProvider whenNotPaused {
        if (batchOpen) revert InvalidBatch(); // Or simply allow re-opening if desired
        currentBatchId++;
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyProvider whenNotPaused {
        if (!batchOpen) revert InvalidBatch();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitWill(
        address willOwner,
        euint32 encryptedAmount,
        euint32 encryptedReleaseTime,
        euint32 encryptedConditionsMet
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchClosed();

        _initIfNeeded(encryptedAmount);
        _initIfNeeded(encryptedReleaseTime);
        _initIfNeeded(encryptedConditionsMet);

        encryptedWillAmounts[currentBatchId][willOwner] = encryptedAmount;
        encryptedWillReleaseTimes[currentBatchId][willOwner] = encryptedReleaseTime;
        encryptedWillConditionsMet[currentBatchId][willOwner] = encryptedConditionsMet;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit WillSubmitted(msg.sender, currentBatchId, willOwner);
    }

    function addBeneficiary(uint256 batchId, address beneficiary) external onlyProvider {
        isBeneficiary[batchId][beneficiary] = true;
    }

    function addExecutor(uint256 batchId, address executor) external onlyProvider {
        isExecutor[batchId][executor] = true;
    }

    function requestWillDecryption(uint256 batchId, address willOwner) external checkDecryptionCooldown whenNotPaused {
        if (!isBeneficiary[batchId][msg.sender] && !isExecutor[batchId][msg.sender]) {
            revert NotBeneficiary(); // Or a more specific error
        }

        euint32 amount = encryptedWillAmounts[batchId][willOwner];
        euint32 releaseTime = encryptedWillReleaseTimes[batchId][willOwner];
        euint32 conditionsMet = encryptedWillConditionsMet[batchId][willOwner];

        _requireInitialized(amount);
        _requireInitialized(releaseTime);
        _requireInitialized(conditionsMet);

        // Prepare Ciphertexts
        bytes32[] memory cts = new bytes32[](3);
        cts[0] = FHE.toBytes32(amount);
        cts[1] = FHE.toBytes32(releaseTime);
        cts[2] = FHE.toBytes32(conditionsMet);

        // Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // Store Context
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId, msg.sender);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        // Replay Guard
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }

        // State Verification
        // Rebuild cts array from current contract storage in the *exact same order*
        // This ensures that the state relevant to this decryption request has not changed.
        DecryptionContext memory context = decryptionContexts[requestId];
        euint32 amount = encryptedWillAmounts[context.batchId][msg.sender]; // Assuming msg.sender is willOwner for simplicity
        euint32 releaseTime = encryptedWillReleaseTimes[context.batchId][msg.sender];
        euint32 conditionsMet = encryptedWillConditionsMet[context.batchId][msg.sender];

        bytes32[] memory currentCts = new bytes32[](3);
        currentCts[0] = FHE.toBytes32(amount);
        currentCts[1] = FHE.toBytes32(releaseTime);
        currentCts[2] = FHE.toBytes32(conditionsMet);

        bytes32 currentHash = _hashCiphertexts(currentCts);
        if (currentHash != context.stateHash) {
            revert StateMismatch();
        }

        // Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // Decode & Finalize
        // Cleartexts are expected in the same order: amount, releaseTime, conditionsMet
        // Each is a uint256 (32 bytes)
        uint256 amountCleartext = abi.decode(cleartexts[0:32], (uint256));
        uint256 releaseTimeCleartext = abi.decode(cleartexts[32:64], (uint256));
        bool conditionsMetCleartext = abi.decode(cleartexts[64:96], (bool));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, context.batchId, msg.sender, amountCleartext, releaseTimeCleartext, conditionsMetCleartext);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) internal {
        if (!FHE.isInitialized(val)) {
            val = FHE.asEuint32(0); // Initialize to encrypted zero if not already initialized
        }
    }

    function _requireInitialized(euint32 val) internal pure {
        if (!FHE.isInitialized(val)) {
            revert("Ciphertext not initialized");
        }
    }
}