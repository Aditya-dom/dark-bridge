/**
 * Inco Lightning JavaScript SDK Example
 * 
 * Demonstrates encryption, decryption, and attestation workflows
 */

import { Lightning, supportedChains, getViemChain, handleTypes, type HexString } from '@inco/js';
import { AttestedComputeSupportedOps, generateSecp256k1Keypair } from '@inco/js/lite';
import { createWalletClient, custom, getContract, type Address } from 'viem';

// ============================================================================
// Setup
// ============================================================================

const chainId = supportedChains.baseSepolia;

async function getClients() {
    // Initialize Inco Lightning
    const zap = await Lightning.latest('testnet', chainId);

    // Initialize viem wallet client (browser environment)
    const walletClient = createWalletClient({
        chain: getViemChain(chainId),
        transport: custom(window.ethereum!),
    });

    // Request account access
    const [address] = await walletClient.requestAddresses();

    return { zap, walletClient, address };
}

// ============================================================================
// Encryption Examples
// ============================================================================

/**
 * Encrypt a uint256 value for use in contract calls
 */
async function encryptAmount(amount: bigint, contractAddress: Address): Promise<HexString> {
    const { zap, address } = await getClients();

    const ciphertext = await zap.encrypt(amount, {
        accountAddress: address,
        dappAddress: contractAddress,
        handleType: handleTypes.euint256,
    });

    return ciphertext;
}

/**
 * Encrypt a boolean value
 */
async function encryptBoolean(value: boolean, contractAddress: Address): Promise<HexString> {
    const { zap, address } = await getClients();

    const ciphertext = await zap.encrypt(value, {
        accountAddress: address,
        dappAddress: contractAddress,
        handleType: handleTypes.ebool,
    });

    return ciphertext;
}

/**
 * Encrypt an address (as euint160)
 */
async function encryptAddress(addr: Address, contractAddress: Address): Promise<HexString> {
    const { zap, address } = await getClients();

    const ciphertext = await zap.encrypt(BigInt(addr), {
        accountAddress: address,
        dappAddress: contractAddress,
        handleType: handleTypes.euint160,
    });

    return ciphertext;
}

// ============================================================================
// Decryption Examples
// ============================================================================

/**
 * Decrypt a handle using attested decrypt (requires user signature)
 */
async function decryptHandle(handle: HexString): Promise<bigint> {
    const { zap, walletClient } = await getClients();

    const results = await zap.attestedDecrypt(walletClient, [handle]);
    return results[0].plaintext.value as bigint;
}

/**
 * Decrypt multiple handles in one request
 */
async function decryptMultipleHandles(handles: HexString[]): Promise<bigint[]> {
    const { zap, walletClient } = await getClients();

    const results = await zap.attestedDecrypt(walletClient, handles);
    return results.map((r) => r.plaintext.value as bigint);
}

/**
 * Decrypt with attestation for on-chain verification
 */
async function decryptWithAttestation(handle: HexString) {
    const { zap, walletClient } = await getClients();

    const results = await zap.attestedDecrypt(walletClient, [handle]);
    const { handle: verifiedHandle, plaintext, covalidatorSignatures } = results[0];

    return {
        handle: verifiedHandle,
        value: plaintext.value,
        signatures: covalidatorSignatures,
    };
}

// ============================================================================
// Attested Reveal (for e.reveal() handles)
// ============================================================================

/**
 * Get decryption for publicly revealed handles (no signature required)
 */
async function getRevealedValue(handle: HexString): Promise<bigint> {
    const { zap } = await getClients();

    const results = await zap.attestedReveal([handle]);
    return results[0].plaintext.value as bigint;
}

// ============================================================================
// Attested Compute (off-chain comparison)
// ============================================================================

/**
 * Check if encrypted value meets a threshold without revealing the value
 */
async function checkThreshold(handle: HexString, threshold: bigint): Promise<boolean> {
    const { zap, walletClient } = await getClients();

    const result = await zap.attestedCompute(
        walletClient,
        handle,
        AttestedComputeSupportedOps.Ge, // >= comparison
        threshold
    );

    return result.plaintext.value as boolean;
}

/**
 * Check equality with encrypted value
 */
async function checkEquals(handle: HexString, expected: bigint): Promise<boolean> {
    const { zap, walletClient } = await getClients();

    const result = await zap.attestedCompute(
        walletClient,
        handle,
        AttestedComputeSupportedOps.Eq,
        expected
    );

    return result.plaintext.value as boolean;
}

// ============================================================================
// Session Keys (for UX without repeated signatures)
// ============================================================================

const DEFAULT_SESSION_VERIFIER = '0xc34569efc25901bdd6b652164a2c8a7228b23005' as Address;

/**
 * Create a session key for signature-free decryption
 */
async function createSessionKey() {
    const { zap, walletClient } = await getClients();

    // Generate ephemeral keypair
    const ephemeralKeypair = generateSecp256k1Keypair();

    // Grant session key allowance (user signs once)
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour
    const voucher = await zap.grantSessionKeyAllowanceVoucher(
        walletClient,
        ephemeralKeypair.encodePublicKey(),
        expiresAt,
        DEFAULT_SESSION_VERIFIER
    );

    return { ephemeralKeypair, voucher };
}

/**
 * Decrypt using session key (no user signature needed)
 */
async function decryptWithSessionKey(
    handle: HexString,
    ephemeralKeypair: ReturnType<typeof generateSecp256k1Keypair>,
    voucher: Awaited<ReturnType<typeof createSessionKey>>['voucher']
): Promise<bigint> {
    const { zap } = await getClients();

    const results = await zap.attestedDecryptWithVoucher(ephemeralKeypair, voucher, [handle]);

    return results[0].plaintext.value as bigint;
}

// ============================================================================
// Full Transfer Example
// ============================================================================

const TOKEN_ABI = [
    {
        inputs: [
            { name: 'to', type: 'address' },
            { name: 'valueInput', type: 'bytes' },
        ],
        name: 'transfer',
        outputs: [{ name: '', type: 'bytes32' }],
        stateMutability: 'payable',
        type: 'function',
    },
    {
        inputs: [{ name: 'account', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: '', type: 'bytes32' }],
        stateMutability: 'view',
        type: 'function',
    },
] as const;

/**
 * Complete confidential transfer flow
 */
async function confidentialTransfer(
    tokenAddress: Address,
    recipient: Address,
    amount: bigint
): Promise<{ txHash: HexString; newBalance: bigint }> {
    const { zap, walletClient, address } = await getClients();

    // 1. Encrypt the transfer amount
    const encryptedAmount = await zap.encrypt(amount, {
        accountAddress: address,
        dappAddress: tokenAddress,
        handleType: handleTypes.euint256,
    });

    // 2. Get contract instance
    const token = getContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        client: walletClient,
    });

    // 3. Get current fee
    // Note: In real code, call inco.getFee() on-chain
    const fee = BigInt('100000000000000'); // 0.0001 ETH

    // 4. Execute transfer
    const txHash = await token.write.transfer([recipient, encryptedAmount], {
        value: fee,
    });

    // 5. Wait for transaction and get new balance handle
    // ... wait for confirmation ...

    const balanceHandle = (await token.read.balanceOf([address])) as HexString;

    // 6. Decrypt new balance
    const results = await zap.attestedDecrypt(walletClient, [balanceHandle]);
    const newBalance = results[0].plaintext.value as bigint;

    return { txHash, newBalance };
}

// ============================================================================
// Exports
// ============================================================================

export {
    encryptAmount,
    encryptBoolean,
    encryptAddress,
    decryptHandle,
    decryptMultipleHandles,
    decryptWithAttestation,
    getRevealedValue,
    checkThreshold,
    checkEquals,
    createSessionKey,
    decryptWithSessionKey,
    confidentialTransfer,
};
