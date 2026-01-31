/**
 * Privacy Relayer Client
 * 
 * Enhanced privacy features for cross-chain transfers:
 * - Sender Privacy: Via relayer (user signs off-chain, relayer submits)
 * - Receiver Privacy: Via claims (recipient revealed only at claim time)
 * 
 * This module provides utilities for fully private cross-chain transfers
 * where neither sender nor receiver addresses are linked on-chain.
 */

import { Lightning } from '@inco/js/lite';
import { 
    createWalletClient, 
    type Address, 
    type Hex, 
    keccak256, 
    encodePacked,
    type WalletClient,
    type Account,
    type Chain,
    type Transport,
    encodeAbiParameters,
    parseAbiParameters,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { 
    Connection, 
    PublicKey, 
    Keypair, 
    Transaction, 
    SystemProgram 
} from '@solana/web3.js';
import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';
import { randomBytes } from 'crypto';

// Chain IDs
const BASE_SEPOLIA_CHAIN_ID = 84532;

// EIP-712 Domain
const EIP712_DOMAIN = {
    name: 'ConfidentialBridge',
    version: '1',
    chainId: BASE_SEPOLIA_CHAIN_ID,
} as const;

// EIP-712 Types for private bridge
const PRIVATE_BRIDGE_TYPES = {
    PrivateBridge: [
        { name: 'localToken', type: 'address' },
        { name: 'commitment', type: 'bytes32' },
        { name: 'encryptedAmount', type: 'bytes' },
        { name: 'sender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
} as const;

export interface PrivacyRelayerConfig {
    // Base configuration
    baseRpcUrl: string;
    confidentialBridgeAddress: Address;
    confidentialTokenAddress: Address;

    // Solana configuration  
    solanaRpcUrl: string;
    bridgeProgramId: PublicKey;

    // Relayer endpoint (for submitting private transactions)
    relayerEndpoint?: string;

    // Inco configuration
    incoEnvironment: 'testnet' | 'devnet' | 'demonet' | 'alphanet';
}

export interface ClaimSecret {
    /** The secret (32 bytes) - keep this private! */
    secret: Hex;
    /** Hash of the secret (commitment) - this goes on-chain */
    commitment: Hex;
}

export interface PrivateBridgeRequest {
    localToken: Address;
    commitment: Hex;
    encryptedAmount: Hex;
    sender: Address;
    senderNonce: bigint;
    deadline: bigint;
    signature: Hex;
}

export interface RelayerResponse {
    success: boolean;
    txHash?: string;
    error?: string;
}

/**
 * Generate a random claim secret and its commitment hash.
 * The secret should be shared privately with the recipient.
 * The commitment (hash) is what goes on-chain.
 */
export function generateClaimSecret(): ClaimSecret {
    const secret = `0x${randomBytes(32).toString('hex')}` as Hex;
    const commitment = keccak256(secret);
    return { secret, commitment };
}

/**
 * Verify that a secret matches a commitment.
 */
export function verifySecret(secret: Hex, commitment: Hex): boolean {
    return keccak256(secret) === commitment;
}

/**
 * Privacy Relayer Client for fully private cross-chain transfers.
 */
export class PrivacyRelayerClient {
    private baseZap: any;
    private solanaConnection: Connection;
    private config: PrivacyRelayerConfig;
    private initialized: boolean = false;

    constructor(config: PrivacyRelayerConfig) {
        this.config = config;
        this.solanaConnection = new Connection(config.solanaRpcUrl, 'confirmed');
        this.baseZap = null;
    }

    /**
     * Initialize the client (must be called before using Base encryption)
     */
    async init(): Promise<void> {
        if (!this.initialized) {
            this.baseZap = await Lightning.latest(
                this.config.incoEnvironment, 
                BASE_SEPOLIA_CHAIN_ID
            );
            this.initialized = true;
        }
    }

    // ============================================================================
    // Sender Privacy: Sign Off-Chain, Submit Via Relayer
    // ============================================================================

    /**
     * Create a signed private bridge request.
     * 
     * The user signs this off-chain. A relayer will submit it on-chain,
     * so the user's address never appears as msg.sender.
     * 
     * @param amount - Amount to bridge (will be encrypted)
     * @param commitment - Hash of the claim secret (keccak256(secret))
     * @param walletClient - Viem wallet client for signing
     * @param deadline - Signature expiration (Unix timestamp)
     */
    async createPrivateBridgeRequest<
        TChain extends Chain | undefined,
        TAccount extends Account | undefined
    >(
        amount: bigint,
        commitment: Hex,
        walletClient: WalletClient<Transport, TChain, TAccount>,
        deadline?: bigint
    ): Promise<PrivateBridgeRequest> {
        if (!this.baseZap) {
            await this.init();
        }

        const userAddress = walletClient.account?.address;
        if (!userAddress) {
            throw new Error('Wallet client must have an account');
        }

        // Default deadline: 1 hour from now
        const expirationTime = deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600);

        // Encrypt the amount
        const encryptedAmount = await this.baseZap.encrypt(amount, {
            accountAddress: userAddress,
            dappAddress: this.config.confidentialBridgeAddress,
        }) as Hex;

        // Get user's current nonce from the contract
        const senderNonce = await this.getUserNonce(userAddress);

        // Create EIP-712 typed data for signing
        const typedData = {
            domain: {
                ...EIP712_DOMAIN,
                verifyingContract: this.config.confidentialBridgeAddress,
            },
            types: PRIVATE_BRIDGE_TYPES,
            primaryType: 'PrivateBridge' as const,
            message: {
                localToken: this.config.confidentialTokenAddress,
                commitment,
                encryptedAmount,
                sender: userAddress,
                nonce: senderNonce,
                deadline: expirationTime,
            },
        };

        // Sign the typed data
        const signature = await walletClient.signTypedData({
            ...typedData,
            account: walletClient.account!,
        });

        return {
            localToken: this.config.confidentialTokenAddress,
            commitment,
            encryptedAmount,
            sender: userAddress,
            senderNonce,
            deadline: expirationTime,
            signature,
        };
    }

    /**
     * Submit a private bridge request via relayer.
     * 
     * This sends the signed request to a relayer service that will
     * submit it on-chain. The user's address is never msg.sender.
     */
    async submitViaRelayer(request: PrivateBridgeRequest): Promise<RelayerResponse> {
        if (!this.config.relayerEndpoint) {
            throw new Error('Relayer endpoint not configured');
        }

        const response = await fetch(`${this.config.relayerEndpoint}/submit-private-bridge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                localToken: request.localToken,
                commitment: request.commitment,
                encryptedAmount: request.encryptedAmount,
                sender: request.sender,
                senderNonce: request.senderNonce.toString(),
                deadline: request.deadline.toString(),
                signature: request.signature,
            }),
        });

        return response.json();
    }

    /**
     * Get the current nonce for a user (needed for signature construction).
     */
    async getUserNonce(userAddress: Address): Promise<bigint> {
        // This would call the contract's getUserNonce function
        // For now, return 0 as placeholder
        // In production, use viem to call the contract
        return 0n;
    }

    // ============================================================================
    // Receiver Privacy: Claim-Based Redemption
    // ============================================================================

    /**
     * Generate a new claim secret and share it with the recipient privately.
     * 
     * The flow is:
     * 1. Sender generates claim secret
     * 2. Sender shares secret with recipient via secure channel (not on-chain!)
     * 3. Sender bridges using commitment (hash of secret) 
     * 4. Recipient claims using the secret
     */
    generateClaimSecret(): ClaimSecret {
        return generateClaimSecret();
    }

    /**
     * Create a fully private bridge request:
     * - Sender hidden (via relayer)
     * - Receiver hidden (via commitment/claim)
     * - Amount hidden (via FHE)
     * 
     * Returns both the signed request AND the claim secret to share with recipient.
     */
    async createFullyPrivateBridgeRequest<
        TChain extends Chain | undefined,
        TAccount extends Account | undefined
    >(
        amount: bigint,
        walletClient: WalletClient<Transport, TChain, TAccount>,
        deadline?: bigint
    ): Promise<{
        request: PrivateBridgeRequest;
        claimSecret: ClaimSecret;
    }> {
        const claimSecret = this.generateClaimSecret();
        const request = await this.createPrivateBridgeRequest(
            amount,
            claimSecret.commitment,
            walletClient,
            deadline
        );

        return { request, claimSecret };
    }

    /**
     * Redeem a claim on Base using the secret.
     * 
     * The claimer's address is revealed for the first time here.
     */
    async redeemClaim<
        TChain extends Chain | undefined,
        TAccount extends Account | undefined
    >(
        claimId: bigint,
        secret: Hex,
        walletClient: WalletClient<Transport, TChain, TAccount>
    ): Promise<Hex> {
        if (!walletClient.account?.address) {
            throw new Error('Wallet client must have an account');
        }

        // Get Inco fee for the mint operation
        const incoFee = await this.getIncoFee();

        const txHash = await (walletClient as any).writeContract({
            address: this.config.confidentialBridgeAddress,
            abi: REDEEM_CLAIM_ABI,
            functionName: 'redeemClaim',
            args: [claimId, secret],
            value: incoFee,
            chain: baseSepolia,
            account: walletClient.account,
        });

        return txHash;
    }

    /**
     * Check if a claim is valid and can be redeemed.
     */
    async isClaimValid(claimId: bigint): Promise<boolean> {
        // Would call contract's isClaimValid function
        // Placeholder for now
        return true;
    }

    /**
     * Get the Inco fee required for operations.
     */
    async getIncoFee(): Promise<bigint> {
        // Would call contract's getIncoFee function
        // Placeholder for now
        return 0n;
    }

    // ============================================================================
    // Solana Privacy Operations
    // ============================================================================

    /**
     * Bridge from Solana with full privacy using commitment.
     * 
     * The sender's identity is still visible on Solana (signer),
     * but the recipient is hidden behind the commitment.
     */
    async bridgePrivateFromSolanaWithCommitment(
        amount: bigint,
        commitment: Hex,
        solanaProvider: AnchorProvider,
        bridgeProgram: Program
    ): Promise<string> {
        // This would call bridge_private_with_commitment on Solana
        // Implementation depends on your Anchor program setup
        throw new Error('Not implemented - use Anchor client directly');
    }

    /**
     * Redeem a claim on Solana using the secret.
     */
    async redeemClaimOnSolana(
        claimPda: PublicKey,
        secret: Hex,
        solanaProvider: AnchorProvider,
        bridgeProgram: Program
    ): Promise<string> {
        // This would call redeem_confidential_claim on Solana
        throw new Error('Not implemented - use Anchor client directly');
    }
}

// ============================================================================
// Contract ABIs (minimal for the functions we need)
// ============================================================================

const REDEEM_CLAIM_ABI = [
    {
        name: 'redeemClaim',
        type: 'function',
        inputs: [
            { name: 'claimId', type: 'uint256' },
            { name: 'secret', type: 'bytes32' },
        ],
        outputs: [],
        stateMutability: 'payable',
    },
] as const;

// ============================================================================
// Example Usage
// ============================================================================

/**
 * Example: Fully Private Transfer
 * 
 * ```typescript
 * // 1. Initialize client
 * const client = new PrivacyRelayerClient({
 *     baseRpcUrl: 'https://sepolia.base.org',
 *     confidentialBridgeAddress: '0x...',
 *     confidentialTokenAddress: '0x...',
 *     solanaRpcUrl: 'https://api.devnet.solana.com',
 *     bridgeProgramId: new PublicKey('...'),
 *     relayerEndpoint: 'https://relayer.example.com',
 *     incoEnvironment: 'testnet',
 * });
 * await client.init();
 * 
 * // 2. Create fully private request (sender creates)
 * const { request, claimSecret } = await client.createFullyPrivateBridgeRequest(
 *     1000000n, // amount
 *     walletClient
 * );
 * 
 * // 3. Share secret with recipient via secure channel (e.g., encrypted message)
 * // DO NOT share on-chain!
 * sendSecretToRecipient(recipientEmail, claimSecret.secret);
 * 
 * // 4. Submit via relayer (sender's address never on-chain)
 * const result = await client.submitViaRelayer(request);
 * console.log('Bridge initiated:', result.txHash);
 * 
 * // 5. Recipient claims (recipient's address revealed only now)
 * const claimTx = await client.redeemClaim(
 *     claimId,
 *     claimSecret.secret,
 *     recipientWalletClient
 * );
 * console.log('Claimed:', claimTx);
 * ```
 */

export default PrivacyRelayerClient;
