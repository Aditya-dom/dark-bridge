// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint256, ebool, e, inco} from "@inco/lightning/Lib.sol";
import {Initializable} from "solady/utils/Initializable.sol";

/// @title ConfidentialCrossChainERC20
/// @notice A cross-chain ERC20 token with encrypted balances using Inco Lightning.
/// @dev Balances are stored as encrypted handles (euint256) and operations are performed
///      on encrypted values without revealing the underlying amounts.
contract ConfidentialCrossChainERC20 is Initializable {
    using e for *;

    //////////////////////////////////////////////////////////////
    ///                       Constants                        ///
    //////////////////////////////////////////////////////////////

    /// @notice The bridge contract address that has minting and burning privileges.
    address private immutable _BRIDGE;

    //////////////////////////////////////////////////////////////
    ///                       Storage                          ///
    //////////////////////////////////////////////////////////////

    /// @notice The name of the token.
    string private _name;

    /// @notice The symbol of the token.
    string private _symbol;

    /// @notice The identifier of the corresponding token on the remote chain.
    bytes32 private _remoteToken;

    /// @notice The number of decimal places for this token.
    uint8 private _decimals;

    /// @notice Encrypted total supply.
    euint256 public totalSupply;

    /// @notice Encrypted balances for each address.
    mapping(address => euint256) internal _balances;

    /// @notice Encrypted allowances.
    mapping(address => mapping(address => euint256)) internal _allowances;

    //////////////////////////////////////////////////////////////
    ///                       Events                           ///
    //////////////////////////////////////////////////////////////

    /// @notice Emitted on encrypted transfer.
    event ConfidentialTransfer(address indexed from, address indexed to, euint256 amount);

    /// @notice Emitted on encrypted approval.
    event ConfidentialApproval(address indexed owner, address indexed spender, euint256 amount);

    /// @notice Emitted on encrypted mint.
    event ConfidentialMint(address indexed to, euint256 amount);

    /// @notice Emitted on encrypted burn.
    event ConfidentialBurn(address indexed from, euint256 amount);

    //////////////////////////////////////////////////////////////
    ///                       Errors                           ///
    //////////////////////////////////////////////////////////////

    /// @notice Thrown when the sender is not the bridge.
    error SenderIsNotBridge();

    /// @notice Thrown when insufficient fee is provided.
    error InsufficientFees();

    /// @notice Thrown when a zero address is provided.
    error ZeroAddress();

    //////////////////////////////////////////////////////////////
    ///                       Modifiers                        ///
    //////////////////////////////////////////////////////////////

    /// @notice Only allows the Bridge to call.
    modifier onlyBridge() {
        require(msg.sender == _BRIDGE, SenderIsNotBridge());
        _;
    }

    /// @notice Requires Inco fee payment.
    modifier requiresFee() {
        if (msg.value < inco.getFee()) revert InsufficientFees();
        _;
    }

    //////////////////////////////////////////////////////////////
    ///                       Constructor                      ///
    //////////////////////////////////////////////////////////////

    /// @notice Constructs the ConfidentialCrossChainERC20 contract.
    /// @param bridge_ Address of the bridge contract with mint/burn privileges.
    constructor(address bridge_) {
        require(bridge_ != address(0), ZeroAddress());
        _BRIDGE = bridge_;
        _disableInitializers();
    }

    /// @notice Initializes the token.
    /// @param remoteToken_ Identifier of the corresponding token on the remote chain.
    /// @param name_ ERC20 name of the token.
    /// @param symbol_ ERC20 symbol of the token.
    /// @param decimals_ ERC20 decimals for the token.
    function initialize(
        bytes32 remoteToken_,
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) external initializer {
        require(remoteToken_ != bytes32(0), ZeroAddress());
        _remoteToken = remoteToken_;
        _decimals = decimals_;
        _name = name_;
        _symbol = symbol_;
    }

    //////////////////////////////////////////////////////////////
    ///                       View Functions                   ///
    //////////////////////////////////////////////////////////////

    function name() public view returns (string memory) {
        return _name;
    }

    function symbol() public view returns (string memory) {
        return _symbol;
    }

    function decimals() public view returns (uint8) {
        return _decimals;
    }

    function bridge() public view returns (address) {
        return _BRIDGE;
    }

    function remoteToken() public view returns (bytes32) {
        return _remoteToken;
    }

    /// @notice Returns the encrypted balance handle for an address.
    /// @dev The actual value can only be decrypted by authorized parties.
    function balanceOf(address owner) public view returns (euint256) {
        return _balances[owner];
    }

    /// @notice Returns the encrypted allowance handle.
    function allowance(address owner, address spender) public view returns (euint256) {
        return _allowances[owner][spender];
    }

    //////////////////////////////////////////////////////////////
    ///                       Transfer Functions               ///
    //////////////////////////////////////////////////////////////

    /// @notice Transfer tokens with encrypted amount (from client ciphertext).
    /// @param to Recipient address.
    /// @param encryptedAmount Client-encrypted amount ciphertext.
    function transfer(
        address to,
        bytes calldata encryptedAmount
    ) external payable requiresFee returns (bool) {
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice Transfer tokens with an existing encrypted handle.
    /// @param to Recipient address.
    /// @param amount Encrypted amount handle.
    function transfer(address to, euint256 amount) public returns (bool) {
        e.allow(amount, address(this));
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice TransferFrom with encrypted amount (from client ciphertext).
    function transferFrom(
        address from,
        address to,
        bytes calldata encryptedAmount
    ) external payable requiresFee returns (bool) {
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        e.allow(amount, address(this));
        ebool isAllowed = _updateAllowance(from, msg.sender, amount);
        _transferWithCheck(from, to, amount, isAllowed);
        return true;
    }

    /// @notice TransferFrom with existing encrypted handle.
    function transferFrom(
        address from,
        address to,
        euint256 amount
    ) public returns (bool) {
        e.allow(amount, address(this));
        ebool isAllowed = _updateAllowance(from, msg.sender, amount);
        _transferWithCheck(from, to, amount, isAllowed);
        return true;
    }

    //////////////////////////////////////////////////////////////
    ///                       Approval Functions               ///
    //////////////////////////////////////////////////////////////

    /// @notice Approve spender with encrypted amount (from client ciphertext).
    function approve(
        address spender,
        bytes calldata encryptedAmount
    ) external payable requiresFee returns (bool) {
        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        _approve(msg.sender, spender, amount);
        return true;
    }

    /// @notice Approve spender with existing encrypted handle.
    function approve(address spender, euint256 amount) public returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    //////////////////////////////////////////////////////////////
    ///                       Bridge Functions                 ///
    //////////////////////////////////////////////////////////////

    /// @notice Confidentially mint tokens (bridge only).
    /// @param to Recipient address.
    /// @param encryptedAmount Encrypted amount to mint.
    function confidentialMint(
        address to,
        bytes calldata encryptedAmount
    ) external payable onlyBridge requiresFee {
        require(to != address(0), ZeroAddress());

        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        e.allow(amount, address(this));

        // Add to balance
        if (euint256.unwrap(_balances[to]) == bytes32(0)) {
            _balances[to] = amount;
        } else {
            _balances[to] = e.add(_balances[to], amount);
        }
        e.allow(_balances[to], address(this));
        e.allow(_balances[to], to);

        // Update total supply
        totalSupply = e.add(totalSupply, amount);
        e.reveal(totalSupply);

        emit ConfidentialMint(to, amount);
    }

    /// @notice Confidentially burn tokens (bridge only).
    /// @param from Address to burn from.
    /// @param encryptedAmount Encrypted amount to burn.
    function confidentialBurn(
        address from,
        bytes calldata encryptedAmount
    ) external payable onlyBridge requiresFee {
        require(from != address(0), ZeroAddress());

        euint256 amount = encryptedAmount.newEuint256(msg.sender);
        e.allow(amount, address(this));

        // Check balance and subtract
        ebool hasSufficient = e.ge(_balances[from], amount);
        euint256 actualBurn = e.select(hasSufficient, amount, e.asEuint256(0));

        _balances[from] = e.sub(_balances[from], actualBurn);
        e.allow(_balances[from], address(this));
        e.allow(_balances[from], from);

        // Update total supply
        totalSupply = e.sub(totalSupply, actualBurn);
        e.reveal(totalSupply);

        emit ConfidentialBurn(from, actualBurn);
    }

    /// @notice Reveal a balance for bridge operations (returns plaintext).
    /// @dev Only the bridge can call this to read amounts for cross-chain messaging.
    function revealBalanceForBridge(address owner) external view onlyBridge returns (euint256) {
        return _balances[owner];
    }

    //////////////////////////////////////////////////////////////
    ///                       Internal Functions               ///
    //////////////////////////////////////////////////////////////

    function _transfer(address from, address to, euint256 amount) internal {
        // Check balance
        ebool hasSufficient = e.ge(_balances[from], amount);
        _transferWithCheck(from, to, amount, hasSufficient);
    }

    function _transferWithCheck(
        address from,
        address to,
        euint256 amount,
        ebool isTransferable
    ) internal {
        // Select actual transfer amount (0 if not transferable)
        euint256 transferValue = e.select(isTransferable, amount, e.asEuint256(0));

        // Update destination balance
        if (euint256.unwrap(_balances[to]) == bytes32(0)) {
            _balances[to] = transferValue;
        } else {
            _balances[to] = e.add(_balances[to], transferValue);
        }
        e.allow(_balances[to], address(this));
        e.allow(_balances[to], to);

        // Update source balance
        _balances[from] = e.sub(_balances[from], transferValue);
        e.allow(_balances[from], address(this));
        e.allow(_balances[from], from);

        emit ConfidentialTransfer(from, to, transferValue);
    }

    function _approve(address owner, address spender, euint256 amount) internal {
        _allowances[owner][spender] = amount;
        e.allow(amount, address(this));
        e.allow(amount, owner);
        e.allow(amount, spender);

        emit ConfidentialApproval(owner, spender, amount);
    }

    function _updateAllowance(
        address owner,
        address spender,
        euint256 amount
    ) internal returns (ebool) {
        euint256 currentAllowance = _allowances[owner][spender];
        ebool allowedTransfer = e.ge(currentAllowance, amount);
        ebool canTransfer = e.ge(_balances[owner], amount);
        ebool isTransferable = e.select(canTransfer, allowedTransfer, e.asEbool(false));

        // Update allowance
        _allowances[owner][spender] = e.select(
            isTransferable,
            e.sub(currentAllowance, amount),
            currentAllowance
        );
        e.allow(_allowances[owner][spender], address(this));
        e.allow(_allowances[owner][spender], owner);
        e.allow(_allowances[owner][spender], spender);

        return isTransferable;
    }
}
