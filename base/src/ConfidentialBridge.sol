// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint256, ebool, e, inco} from "@inco/lightning/Lib.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";

import {ConfidentialCrossChainERC20} from "./ConfidentialCrossChainERC20.sol";
import {Pubkey} from "./libraries/SVMLib.sol";
import {Ix} from "./libraries/SVMBridgeLib.sol";

/// @title ConfidentialBridge
/// @notice Privacy extension for the Base-Solana bridge using Inco Lightning.
/// @dev Handles confidential token transfers with encrypted amounts on both chains.
contract ConfidentialBridge is ReentrancyGuardTransient {
    using e for *;

    //////////////////////////////////////////////////////////////
    ///                       Constants                        ///
    //////////////////////////////////////////////////////////////

    /// @notice The main bridge contract address.
    address public immutable BRIDGE;

    /// @notice The confidential token factory address.
    address public immutable CONFIDENTIAL_TOKEN_FACTORY;

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
    error Unauthorized();
    error HandleMismatch();
    error InvalidNonce();

    //////////////////////////////////////////////////////////////
    ///                       Modifiers                        ///
    //////////////////////////////////////////////////////////////

    modifier requiresFee() {
        if (msg.value < inco.getFee()) revert InsufficientFees();
        _;
    }

    modifier onlyBridge() {
        if (msg.sender != BRIDGE) revert Unauthorized();
        _;
    }

    //////////////////////////////////////////////////////////////
    ///                       Constructor                      ///
    //////////////////////////////////////////////////////////////

    /// @notice Constructs the ConfidentialBridge.
    /// @param bridge_ The main bridge contract address.
    /// @param confidentialTokenFactory_ The confidential token factory address.
    constructor(address bridge_, address confidentialTokenFactory_) {
        require(bridge_ != address(0), ZeroAddress());
        require(confidentialTokenFactory_ != address(0), ZeroAddress());
        
        BRIDGE = bridge_;
        CONFIDENTIAL_TOKEN_FACTORY = confidentialTokenFactory_;
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
    ) external payable nonReentrant requiresFee {
        require(localToken != address(0), ZeroAddress());
        require(toSolana != bytes32(0), ZeroAddress());

        // Create encrypted handle from ciphertext
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        e.allow(amount, address(this));

        // Burn from sender's confidential balance
        ConfidentialCrossChainERC20(localToken).confidentialBurn{value: inco.getFee()}(
            msg.sender,
            encryptedAmount
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
    ) external payable nonReentrant requiresFee {
        // Same logic as bridgePrivateToSolana but includes instructions
        require(localToken != address(0), ZeroAddress());
        require(toSolana != bytes32(0), ZeroAddress());

        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        e.allow(amount, address(this));

        ConfidentialCrossChainERC20(localToken).confidentialBurn{value: inco.getFee()}(
            msg.sender,
            encryptedAmount
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
    /// @dev Should be called by the factory or admin.
    function registerConfidentialToken(
        address originalToken,
        address confidentialToken
    ) external {
        // TODO: Add access control
        confidentialTokens[originalToken] = confidentialToken;
    }
}
