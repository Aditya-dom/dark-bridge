// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint256, ebool, e, inco} from "@inco/lightning/Lib.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {OwnableRoles} from "solady/auth/OwnableRoles.sol";
import {Initializable} from "solady/utils/Initializable.sol";

import {ConfidentialCrossChainERC20} from "./ConfidentialCrossChainERC20.sol";
import {Pubkey} from "./libraries/SVMLib.sol";
import {Ix} from "./libraries/SVMBridgeLib.sol";

/// @title ConfidentialBridge
/// @notice Privacy extension for the Base-Solana bridge using Inco Lightning.
/// @dev Handles confidential token transfers with encrypted amounts on both chains.
contract ConfidentialBridge is ReentrancyGuardTransient, OwnableRoles, Initializable {
    using e for *;

    //////////////////////////////////////////////////////////////
    ///                       Constants                        ///
    //////////////////////////////////////////////////////////////

    /// @notice The main bridge contract address.
    address public immutable BRIDGE;

    /// @notice The confidential token factory address.
    address public immutable CONFIDENTIAL_TOKEN_FACTORY;

    /// @notice Guardian role for token registration and pause.
    uint256 public constant GUARDIAN_ROLE = 1 << 0;

    //////////////////////////////////////////////////////////////
    ///                       Storage                          ///
    //////////////////////////////////////////////////////////////

    /// @notice Mapping of local tokens to their confidential counterparts.
    mapping(address => address) public confidentialTokens;

    /// @notice Nonce for confidential bridge messages.
    uint256 public confidentialNonce;

    /// @notice Mapping of nonce to expected encrypted amount handle for verification.
    /// @dev Used to prevent handle swapping attacks during cross-chain transfers.
    mapping(uint256 => bytes32) public expectedHandles;

    /// @notice Whether the bridge is paused.
    bool public paused;

    //////////////////////////////////////////////////////////////
    ///                       Events                           ///
    //////////////////////////////////////////////////////////////

    /// @notice Emitted when a confidential bridge transfer is initiated.
    event ConfidentialBridgeInitiated(
        uint256 indexed nonce,
        address indexed localToken,
        Pubkey indexed remoteToken,
        bytes32 toSolana,
        euint256 encryptedAmount
    );

    /// @notice Emitted when a confidential transfer is received from Solana.
    event ConfidentialBridgeReceived(
        uint256 indexed nonce,
        address indexed localToken,
        address indexed to,
        euint256 encryptedAmount
    );

    //////////////////////////////////////////////////////////////
    ///                       Errors                           ///
    //////////////////////////////////////////////////////////////

    error InsufficientFees();
    error ZeroAddress();
    error TokenNotRegistered();
    error SenderNotBridge();
    error HandleMismatch();
    error InvalidNonce();
    error Paused();

    //////////////////////////////////////////////////////////////
    ///                       Events                           ///
    //////////////////////////////////////////////////////////////

    /// @notice Emitted when pause state changes.
    event PauseStateChanged(bool paused);

    //////////////////////////////////////////////////////////////
    ///                       Modifiers                        ///
    //////////////////////////////////////////////////////////////

    modifier requiresFee() {
        if (msg.value < inco.getFee()) revert InsufficientFees();
        _;
    }

    modifier onlyBridge() {
        if (msg.sender != BRIDGE) revert SenderNotBridge();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    //////////////////////////////////////////////////////////////
    ///                       Constructor                      ///
    //////////////////////////////////////////////////////////////

    /// @notice Constructs the ConfidentialBridge.
    /// @param bridge_ The main bridge contract address.
    /// @param confidentialTokenFactory_ The confidential token factory address.
    /// @param owner_ The owner of the bridge (also gets guardian role).
    constructor(address bridge_, address confidentialTokenFactory_, address owner_) {
        require(bridge_ != address(0), ZeroAddress());
        require(confidentialTokenFactory_ != address(0), ZeroAddress());
        require(owner_ != address(0), ZeroAddress());
        
        BRIDGE = bridge_;
        CONFIDENTIAL_TOKEN_FACTORY = confidentialTokenFactory_;

        // Initialize owner directly (not using proxy pattern for hackathon)
        _initializeOwner(owner_);
        _grantRoles(owner_, GUARDIAN_ROLE);
    }

    /// @notice Add additional guardians (owner only, for future use).
    /// @param guardians The addresses to grant guardian role.
    function addGuardians(address[] calldata guardians) external onlyOwner {
        for (uint256 i = 0; i < guardians.length; i++) {
            require(guardians[i] != address(0), ZeroAddress());
            _grantRoles(guardians[i], GUARDIAN_ROLE);
        }
    }

    //////////////////////////////////////////////////////////////
    ///                       Bridge Functions                 ///
    //////////////////////////////////////////////////////////////

    /// @notice Bridge tokens privately to Solana.
    /// @dev Burns encrypted tokens on Base and emits commitment for Solana relay.
    /// @param localToken The confidential token to bridge.
    /// @param toSolana The recipient's Solana pubkey.
    /// @param encryptedAmount Client-encrypted amount ciphertext.
    function bridgePrivateToSolana(
        address localToken,
        bytes32 toSolana,
        bytes calldata encryptedAmount
    ) external payable nonReentrant whenNotPaused requiresFee {
        require(localToken != address(0), ZeroAddress());
        require(toSolana != bytes32(0), ZeroAddress());

        // Create encrypted handle from ciphertext (only done ONCE here)
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        // Allow both this contract AND the token contract to use the handle
        e.allow(amount, address(this));
        e.allow(amount, localToken);

        // Burn from sender's confidential balance using the handle (not the raw ciphertext)
        // This avoids calling newEuint256 twice on the same ciphertext
        ConfidentialCrossChainERC20(localToken).confidentialBurnFromHandle(
            msg.sender,
            amount
        );

        // Get remote token mapping
        Pubkey remoteToken = Pubkey.wrap(
            ConfidentialCrossChainERC20(localToken).remoteToken()
        );

        // Increment nonce and store expected handle for verification
        uint256 nonce = confidentialNonce++;
        expectedHandles[nonce] = euint256.unwrap(amount);

        emit ConfidentialBridgeInitiated(
            nonce,
            localToken,
            remoteToken,
            toSolana,
            amount
        );
    }

    /// @notice Bridge tokens privately to Solana with custom instructions.
    /// @param localToken The confidential token to bridge.
    /// @param toSolana The recipient's Solana pubkey.
    /// @param encryptedAmount Client-encrypted amount ciphertext.
    /// @param ixs Optional Solana instructions to execute after bridging.
    function bridgePrivateToSolanaWithInstructions(
        address localToken,
        bytes32 toSolana,
        bytes calldata encryptedAmount,
        Ix[] calldata ixs
    ) external payable nonReentrant whenNotPaused requiresFee {
        // Same logic as bridgePrivateToSolana but includes instructions
        require(localToken != address(0), ZeroAddress());
        require(toSolana != bytes32(0), ZeroAddress());

        // Create encrypted handle from ciphertext (only done ONCE here)
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        // Allow both this contract AND the token contract to use the handle
        e.allow(amount, address(this));
        e.allow(amount, localToken);

        // Burn from sender's confidential balance using the handle (not the raw ciphertext)
        ConfidentialCrossChainERC20(localToken).confidentialBurnFromHandle(
            msg.sender,
            amount
        );

        Pubkey remoteToken = Pubkey.wrap(
            ConfidentialCrossChainERC20(localToken).remoteToken()
        );

        uint256 nonce = confidentialNonce++;
        expectedHandles[nonce] = euint256.unwrap(amount);

        emit ConfidentialBridgeInitiated(
            nonce,
            localToken,
            remoteToken,
            toSolana,
            amount
        );

        // TODO: Serialize and emit instructions for Solana relay
    }

    /// @notice Receive confidential tokens from Solana.
    /// @dev Called by the main bridge when relaying from Solana.
    /// @dev SECURITY: Verifies that the received handle matches the expected handle from the outgoing message.
    /// @param nonce The bridge message nonce for verification.
    /// @param localToken The confidential token to mint.
    /// @param to The recipient on Base.
    /// @param encryptedAmount The encrypted amount to mint.
    function receiveFromSolana(
        uint256 nonce,
        address localToken,
        address to,
        bytes calldata encryptedAmount
    ) external payable onlyBridge nonReentrant {
        require(localToken != address(0), ZeroAddress());
        require(to != address(0), ZeroAddress());

        // Create handle from the received encrypted amount
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        bytes32 receivedHandle = euint256.unwrap(amount);

        // CRITICAL SECURITY CHECK: Verify handle matches expected
        bytes32 expected = expectedHandles[nonce];
        if (expected == bytes32(0)) revert InvalidNonce();
        if (receivedHandle != expected) revert HandleMismatch();

        // Clear the expected handle to prevent replay
        delete expectedHandles[nonce];

        // Mint confidential tokens to recipient
        ConfidentialCrossChainERC20(localToken).confidentialMint{value: msg.value}(
            to,
            encryptedAmount
        );

        emit ConfidentialBridgeReceived(nonce, localToken, to, amount);
    }

    /// @notice Receive confidential tokens from Solana (legacy, no handle verification).
    /// @dev Deprecated: Use receiveFromSolana with nonce parameter for security.
    /// @dev This function is kept for backward compatibility but should not be used.
    function receiveFromSolanaLegacy(
        address localToken,
        address to,
        bytes calldata encryptedAmount
    ) external payable onlyBridge nonReentrant {
        require(localToken != address(0), ZeroAddress());
        require(to != address(0), ZeroAddress());

        // Mint confidential tokens to recipient
        ConfidentialCrossChainERC20(localToken).confidentialMint{value: msg.value}(
            to,
            encryptedAmount
        );

        euint256 amount = encryptedAmount.newEuint256(msg.sender);

        // Emit event without nonce (legacy)
        emit ConfidentialBridgeReceived(0, localToken, to, amount);
    }

    //////////////////////////////////////////////////////////////
    ///                       View Functions                   ///
    //////////////////////////////////////////////////////////////

    /// @notice Get the Inco fee required for operations.
    function getIncoFee() external view returns (uint256) {
        return inco.getFee();
    }

    /// @notice Check if a token has a confidential counterpart.
    function hasConfidentialToken(address localToken) external view returns (bool) {
        return confidentialTokens[localToken] != address(0);
    }

    /// @notice Get the expected handle for a given nonce.
    /// @dev Returns bytes32(0) if nonce is invalid or already consumed.
    function getExpectedHandle(uint256 nonce) external view returns (bytes32) {
        return expectedHandles[nonce];
    }

    //////////////////////////////////////////////////////////////
    ///                       Admin Functions                  ///
    //////////////////////////////////////////////////////////////

    /// @notice Register a confidential token mapping.
    /// @dev Only guardians can register tokens.
    function registerConfidentialToken(
        address originalToken,
        address confidentialToken
    ) external onlyRoles(GUARDIAN_ROLE) {
        require(originalToken != address(0), ZeroAddress());
        require(confidentialToken != address(0), ZeroAddress());
        confidentialTokens[originalToken] = confidentialToken;
    }

    /// @notice Pause or unpause the bridge.
    /// @dev Only guardians can pause.
    function setPaused(bool _paused) external onlyRoles(GUARDIAN_ROLE) {
        paused = _paused;
        emit PauseStateChanged(_paused);
    }

    /// @notice Grant guardian role to an address.
    /// @dev Only owner can grant roles.
    function grantGuardian(address guardian) external onlyOwner {
        require(guardian != address(0), ZeroAddress());
        _grantRoles(guardian, GUARDIAN_ROLE);
    }

    /// @notice Revoke guardian role from an address.
    /// @dev Only owner can revoke roles.
    function revokeGuardian(address guardian) external onlyOwner {
        _removeRoles(guardian, GUARDIAN_ROLE);
    }
}
