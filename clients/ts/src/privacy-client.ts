/**
 * Privacy Bridge Client
 * 
 * Unified client for private cross-chain transfers using Inco Lightning
 * on both Base (EVM) and Solana (SVM).
 */

import { Lightning } from '@inco/js/lite';
import { encryptValue } from '@inco/solana-sdk/encryption';
import { createWalletClient, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { Connection, PublicKey, Keypair, Transaction, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';

// Deployed Bridge Program ID on Solana Devnet
const BRIDGE_PROGRAM_ID = new PublicKey('EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9');

// Inco Lightning Program ID on Solana Devnet
const INCO_LIGHTNING_PROGRAM_ID = new PublicKey('5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj');

// Chain IDs
const BASE_SEPOLIA_CHAIN_ID = 84532;

export interface PrivateBridgeConfig {
    // Base configuration
    baseRpcUrl: string;
    confidentialBridgeAddress: Address;
    confidentialTokenAddress: Address;

    // Solana configuration
    solanaRpcUrl: string;
    bridgeProgramId: PublicKey;

    // Inco configuration
    incoEnvironment: 'testnet' | 'devnet' | 'demonet' | 'alphanet';
}

export interface EncryptedTransferResult {
    txHash: string;
    encryptedAmountHandle: Hex;
}

/**
 * Privacy Bridge Client for Inco Lightning on Base and Solana.
 */
export class PrivacyBridgeClient {
    private baseZap: any;
    private solanaConnection: Connection;
    private config: PrivateBridgeConfig;
    private initialized: boolean = false;

    constructor(config: PrivateBridgeConfig) {
        this.config = config;
        this.solanaConnection = new Connection(config.solanaRpcUrl, 'confirmed');
        this.baseZap = null;
    }

    /**
     * Initialize the client (must be called before using Base encryption)
     */
    async init(): Promise<void> {
        if (!this.initialized) {
            // Initialize Inco Lightning for Base
            this.baseZap = await Lightning.latest(this.config.incoEnvironment, BASE_SEPOLIA_CHAIN_ID);
            this.initialized = true;
        }
    }

    // ============================================================================
    // Base (EVM) Encryption
    // ============================================================================

    /**
     * Encrypt an amount for Base using Inco Lightning.
     * This creates a ciphertext that can be used with ConfidentialBridge.
     */
    async encryptForBase(
        amount: bigint,
        userAddress: Address
    ): Promise<Hex> {
        // Ensure initialized
        if (!this.baseZap) {
            await this.init();
        }

        const ciphertext = await this.baseZap.encrypt(amount, {
            accountAddress: userAddress,
            dappAddress: this.config.confidentialBridgeAddress,
        });

        return ciphertext as Hex;
    }

    /**
     * Decrypt a balance handle from Base.
     * Requires the user to have decryption permission on the handle.
     */
    async decryptFromBase(
        handle: Hex,
        userAddress: Address
    ): Promise<bigint> {
        const result = await this.baseZap.attestedDecrypt({
            handles: [handle],
            accountAddress: userAddress,
        });

        return BigInt(result[0]);
    }

    // ============================================================================
    // Solana (SVM) Encryption
    // ============================================================================

    /**
     * Encrypt an amount for Solana using Inco Lightning.
     */
    async encryptForSolana(
        amount: bigint,
        userAddress: PublicKey
    ): Promise<Uint8Array> {
        const encrypted = await encryptValue(amount);
        return Buffer.from(encrypted, 'hex');
    }

    // ============================================================================
    // Cross-Chain Bridge Operations
    // ============================================================================

    /**
     * Bridge tokens privately from Base to Solana.
     * 
     * 1. Encrypts the amount on Base
     * 2. Burns from ConfidentialCrossChainERC20
     * 3. Emits bridge message for Solana relay
     * 
     * @param amount - Amount to bridge (plaintext, will be encrypted)
     * @param solanaRecipient - Recipient's Solana pubkey
     * @param walletClient - Viem wallet client for signing
     */
    async bridgePrivateToSolana(
        amount: bigint,
        solanaRecipient: PublicKey,
        walletClient: any
    ): Promise<EncryptedTransferResult> {
        const userAddress = walletClient.account.address;

        // Step 1: Encrypt the amount
        const encryptedAmount = await this.encryptForBase(amount, userAddress);

        // Step 2: Get Inco fee
        const incoFee = await this.getIncoFeeBase();

        // Step 3: Call bridgePrivateToSolana on ConfidentialBridge
        const txHash = await walletClient.writeContract({
            address: this.config.confidentialBridgeAddress,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: 'bridgePrivateToSolana',
            args: [
                this.config.confidentialTokenAddress,
                solanaRecipient.toBytes(),
                encryptedAmount,
            ],
            value: incoFee,
        });

        return {
            txHash,
            encryptedAmountHandle: encryptedAmount,
        };
    }

    /**
     * Bridge tokens privately from Solana to Base.
     * 
     * 1. Encrypts the amount on Solana
     * 2. Burns from ConfidentialVault
     * 3. Emits bridge message for Base relay
     * 
     * @param amount - Amount to bridge (plaintext, will be encrypted)
     * @param baseRecipient - Recipient's Base address
     * @param solanaWallet - Solana keypair for signing
     */
    async bridgePrivateToBase(
        amount: bigint,
        baseRecipient: Address,
        solanaProvider: AnchorProvider,
        bridgeProgram: Program
    ): Promise<string> {
        const userPubkey = solanaProvider.wallet.publicKey;

        // Step 1: Encrypt the amount
        const encryptedAmount = await this.encryptForSolana(amount, userPubkey);

        // Step 2: Derive vault PDA
        const [vaultPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from('confidential_vault'),
                userPubkey.toBuffer(),
                // token mint would go here
            ],
            this.config.bridgeProgramId
        );

        // Step 3: Derive allowance PDA for access control
        const handleBuffer = Buffer.alloc(16); // Euint128 = 16 bytes
        const [allowancePda] = PublicKey.findProgramAddressSync(
            [handleBuffer, userPubkey.toBuffer()],
            INCO_LIGHTNING_PROGRAM_ID
        );

        // Step 4: Call bridge_confidential_out
        const txSig = await bridgeProgram.methods
            .bridgeConfidentialOut(
                encryptedAmount,
                Array.from(Buffer.from(baseRecipient.slice(2), 'hex'))
            )
            .accounts({
                owner: userPubkey,
                vault: vaultPda,
                incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .remainingAccounts([
                { pubkey: allowancePda, isSigner: false, isWritable: true },
                { pubkey: userPubkey, isSigner: false, isWritable: false },
            ])
            .rpc();

        return txSig;
    }

    // ============================================================================
    // Balance Queries
    // ============================================================================

    /**
     * Get encrypted balance handle on Base.
     * Returns the handle, which can be decrypted if user has permission.
     */
    async getBaseConfidentialBalance(
        owner: Address
    ): Promise<Hex> {
        // This would call balanceOf on ConfidentialCrossChainERC20
        // Returns the euint256 handle
        throw new Error('Not implemented - requires viem publicClient setup');
    }

    /**
     * Get encrypted balance handle on Solana.
     * Returns the handle, which can be decrypted if user has permission.
     */
    async getSolanaConfidentialBalance(
        owner: PublicKey,
        bridgeProgram: Program
    ): Promise<bigint> {
        // Derive vault PDA
        const [vaultPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from('confidential_vault'),
                owner.toBuffer(),
                // token mint would go here
            ],
            this.config.bridgeProgramId
        );

        // Fetch vault account (cast to any since confidentialVault isn't in generated IDL yet)
        const vault = await (bridgeProgram.account as any).confidentialVault.fetch(vaultPda);

        // Return the encrypted balance handle (not the actual value)
        return vault.encryptedBalance.toNumber();
    }

    // ============================================================================
    // Utility Functions
    // ============================================================================

    /**
     * Get the current Inco fee on Base.
     */
    async getIncoFeeBase(): Promise<bigint> {
        // Default fee is 0.0001 ETH = 100000000000000 wei
        return BigInt('100000000000000');
    }

    /**
     * Initialize a confidential vault on Solana for a user.
     */
    async initializeConfidentialVault(
        solanaProvider: AnchorProvider,
        bridgeProgram: Program,
        tokenMint: PublicKey
    ): Promise<string> {
        const userPubkey = solanaProvider.wallet.publicKey;

        // Derive vault PDA
        const [vaultPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from('confidential_vault'),
                userPubkey.toBuffer(),
                tokenMint.toBuffer(),
            ],
            this.config.bridgeProgramId
        );

        // Initialize vault
        const txSig = await bridgeProgram.methods
            .initializeConfidentialVault()
            .accounts({
                owner: userPubkey,
                tokenMint,
                bridgeAuthority: this.config.bridgeProgramId, // Simplified
                vault: vaultPda,
                incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        return txSig;
    }
}

// ============================================================================
// ABI for ConfidentialBridge contract
// ============================================================================

const CONFIDENTIAL_BRIDGE_ABI = [
    {
        name: 'bridgePrivateToSolana',
        type: 'function',
        stateMutability: 'payable',
        inputs: [
            { name: 'localToken', type: 'address' },
            { name: 'toSolana', type: 'bytes32' },
            { name: 'encryptedAmount', type: 'bytes' },
        ],
        outputs: [],
    },
    {
        name: 'getIncoFee',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'uint256' }],
    },
] as const;

export default PrivacyBridgeClient;
