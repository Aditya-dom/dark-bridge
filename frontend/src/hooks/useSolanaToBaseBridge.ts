/**
 * React Hook for Solana → Base Privacy Bridge
 * 
 * Handles the complete flow:
 * 1. Bridge out on Solana (burn encrypted tokens)
 * 2. Attested decrypt (user signs to reveal plaintext)
 * 3. Mint on Base (re-encrypt on destination chain)
 */

import { useState, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { useAccount, useWalletClient } from 'wagmi';
import { 
    requestAttestedDecrypt, 
    parseConfidentialBridgeOutEvent,
    type AttestedDecryptResult 
} from '@/lib/attested-decrypt';

// Contract addresses (v6 - DARK token)
const CONFIDENTIAL_TOKEN_ADDRESS = '0xc4104aCBa7059c2f8FEFdf746a1c4b9B8a89Ec7D' as const;
const BRIDGE_PROGRAM_ID = new PublicKey('EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9');
const INCO_LIGHTNING_ID = new PublicKey('5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj');
const SOLANA_RPC = 'https://api.devnet.solana.com';

export type BridgeStep = 
    | 'idle'
    | 'burning'      // Burning on Solana
    | 'decrypting'   // User signing for attested decrypt
    | 'minting'      // Minting on Base
    | 'complete'
    | 'error';

export interface BridgeState {
    step: BridgeStep;
    solanaTxHash?: string;
    handle?: bigint;
    plaintext?: bigint;
    baseTxHash?: string;
    error?: string;
}

export function useSolanaToBaseBridge() {
    const [state, setState] = useState<BridgeState>({ step: 'idle' });
    
    // Solana wallet
    const { publicKey: solanaPublicKey, signMessage, signTransaction } = useWallet();
    
    // EVM wallet
    const { address: evmAddress } = useAccount();
    const { data: walletClient } = useWalletClient();
    
    /**
     * Bridge tokens from Solana to Base
     * 
     * @param amount - Amount to bridge (plaintext, will be encrypted)
     * @param tokenMint - SPL token mint address on Solana
     */
    const bridge = useCallback(async (
        amount: bigint,
        tokenMint: PublicKey
    ) => {
        if (!solanaPublicKey || !signMessage || !signTransaction) {
            setState({ step: 'error', error: 'Solana wallet not connected' });
            return;
        }
        
        if (!evmAddress || !walletClient) {
            setState({ step: 'error', error: 'EVM wallet not connected' });
            return;
        }
        
        try {
            const connection = new Connection(SOLANA_RPC, 'confirmed');
            
            // ============================================================
            // Step 1: Bridge Out on Solana
            // ============================================================
            setState({ step: 'burning' });
            
            // Derive vault PDA
            const [vaultPda] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from('confidential_vault'),
                    solanaPublicKey.toBuffer(),
                    tokenMint.toBuffer(),
                ],
                BRIDGE_PROGRAM_ID
            );
            
            // Create bridge_confidential_out instruction
            // Instruction data: discriminator (8) + encrypted_amount (Vec<u8>) + destination_evm ([u8; 20])
            const discriminator = Buffer.from('d206f7649b1fe9dc', 'hex'); // bridge_confidential_out
            
            // For demo, encrypt the amount (in production use @inco/solana-sdk)
            const encryptedAmount = encryptAmountForDemo(amount);
            const encryptedAmountLen = Buffer.alloc(4);
            encryptedAmountLen.writeUInt32LE(encryptedAmount.length, 0);
            
            // Destination EVM address (remove 0x prefix)
            const destinationEvm = Buffer.from(evmAddress.slice(2), 'hex');
            
            const instructionData = Buffer.concat([
                discriminator,
                encryptedAmountLen,
                encryptedAmount,
                destinationEvm,
            ]);
            
            const bridgeOutIx = new TransactionInstruction({
                keys: [
                    { pubkey: solanaPublicKey, isSigner: true, isWritable: true },
                    { pubkey: vaultPda, isSigner: false, isWritable: true },
                    { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
                    { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
                ],
                programId: BRIDGE_PROGRAM_ID,
                data: instructionData,
            });
            
            const tx = new Transaction().add(bridgeOutIx);
            tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
            tx.feePayer = solanaPublicKey;
            
            const signedTx = await signTransaction(tx);
            const solanaTxHash = await connection.sendRawTransaction(signedTx.serialize());
            await connection.confirmTransaction(solanaTxHash, 'confirmed');
            
            console.log('Solana TX:', solanaTxHash);
            
            // Get the handle from the transaction logs
            const txDetails = await connection.getTransaction(solanaTxHash, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0,
            });
            
            const event = parseConfidentialBridgeOutEvent(txDetails?.meta?.logMessages || []);
            if (!event) {
                throw new Error('Failed to parse bridge event from transaction');
            }
            
            setState({ 
                step: 'decrypting', 
                solanaTxHash,
                handle: event.encryptedAmountHandle,
            });
            
            // ============================================================
            // Step 2: Attested Decrypt (User Signs)
            // ============================================================
            console.log('Requesting attested decrypt...');
            
            const attestation = await requestAttestedDecrypt(
                event.encryptedAmountHandle,
                { 
                    publicKey: solanaPublicKey, 
                    signMessage: async (msg) => {
                        const sig = await signMessage(msg);
                        return sig;
                    }
                }
            );
            
            setState(prev => ({ 
                ...prev, 
                step: 'minting',
                plaintext: attestation.plaintext,
            }));
            
            // ============================================================
            // Step 3: Mint on Base
            // ============================================================
            console.log('Minting on Base...');
            
            const incoFee = BigInt('1000000000000'); // 0.000001 ETH
            
            const baseTxHash = await walletClient.writeContract({
                address: CONFIDENTIAL_TOKEN_ADDRESS,
                abi: [{
                    name: 'confidentialMintForDemo',
                    type: 'function',
                    inputs: [
                        { name: 'to', type: 'address' },
                        { name: 'plainAmount', type: 'uint256' },
                    ],
                    outputs: [],
                    stateMutability: 'payable',
                }],
                functionName: 'confidentialMintForDemo',
                args: [evmAddress, attestation.plaintext],
                value: incoFee,
            });
            
            setState({
                step: 'complete',
                solanaTxHash,
                handle: event.encryptedAmountHandle,
                plaintext: attestation.plaintext,
                baseTxHash,
            });
            
        } catch (error: any) {
            console.error('Bridge error:', error);
            setState(prev => ({ 
                ...prev, 
                step: 'error', 
                error: error.message 
            }));
        }
    }, [solanaPublicKey, signMessage, signTransaction, evmAddress, walletClient]);
    
    const reset = useCallback(() => {
        setState({ step: 'idle' });
    }, []);
    
    return {
        state,
        bridge,
        reset,
        isConnected: !!solanaPublicKey && !!evmAddress,
    };
}

/**
 * Demo encryption - creates a simple ciphertext.
 * In production, use @inco/solana-sdk encryptValue()
 */
function encryptAmountForDemo(amount: bigint): Buffer {
    const buffer = Buffer.alloc(16);
    let remaining = amount;
    for (let i = 0; i < 16; i++) {
        buffer[i] = Number(remaining & BigInt(0xff));
        remaining >>= BigInt(8);
    }
    return buffer;
}
