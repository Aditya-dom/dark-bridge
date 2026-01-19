/**
 * Attested Decrypt for Solana → Base Bridge
 * 
 * This module handles the user-signed attested decryption flow
 * for cross-chain privacy bridging.
 */

import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

// Inco Solana Devnet endpoint
const INCO_ATTESTED_DECRYPT_ENDPOINT = 
    "https://grpc.solana-devnet.alpha.devnet.inco.org/crypto/getDecryptAttested";

export interface AttestedDecryptResult {
    handle: string;
    plaintext: bigint;
    signature: string;  // Covalidator signature for on-chain verification
}

export interface WalletAdapter {
    publicKey: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Request attested decryption using the user's wallet.
 * 
 * This function:
 * 1. Has the user sign the handle to prove ownership
 * 2. Sends the signed request to Inco covalidators
 * 3. Returns the plaintext amount + attestation signature
 * 
 * @param handle - The Euint128 handle from Solana (u128 as bigint)
 * @param wallet - Solana wallet adapter with signMessage capability
 * @returns The decrypted plaintext and covalidator attestation
 */
export async function requestAttestedDecrypt(
    handle: bigint,
    wallet: WalletAdapter
): Promise<AttestedDecryptResult> {
    const handleStr = handle.toString();
    const address = wallet.publicKey.toBase58();
    
    console.log(`Requesting attested decrypt for handle: ${handleStr}`);
    console.log(`Wallet address: ${address}`);
    
    // Step 1: Sign the handle with user's wallet
    // This proves the user owns/has access to this encrypted value
    const messageBytes = new TextEncoder().encode(handleStr);
    const signatureBytes = await wallet.signMessage(messageBytes);
    const signature = bs58.encode(signatureBytes);
    
    console.log(`Signature: ${signature.slice(0, 20)}...`);
    
    // Step 2: Call Inco covalidator API
    const response = await fetch(INCO_ATTESTED_DECRYPT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            handle: handleStr,
            address: address,
            signature: signature,
        }),
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Attested decrypt failed: ${errorText}`);
    }
    
    const data = await response.json();
    
    if (data.plaintext === undefined) {
        throw new Error("No plaintext in attested decrypt response");
    }
    
    console.log(`Decrypted plaintext: ${data.plaintext}`);
    
    return {
        handle: handleStr,
        plaintext: BigInt(data.plaintext),
        signature: data.signature, // Covalidator attestation signature
    };
}

/**
 * Bridge from Solana to Base with attested decryption.
 * 
 * Complete flow:
 * 1. Call bridge_confidential_out on Solana (burns tokens, emits handle)
 * 2. User signs attested decrypt request
 * 3. Call Base contract with plaintext + attestation
 * 
 * @param solanaWallet - Solana wallet for signing
 * @param evmSigner - EVM signer for Base transaction
 * @param handle - The encrypted amount handle from Solana bridge event
 * @param destinationEvm - Recipient address on Base
 * @param confidentialTokenAddress - DARK token address on Base
 */
export async function bridgeSolanaToBaseWithAttestation(
    solanaWallet: WalletAdapter,
    evmSigner: any, // viem WalletClient
    handle: bigint,
    destinationEvm: `0x${string}`,
    confidentialTokenAddress: `0x${string}`
): Promise<{ plaintextAmount: bigint; baseTxHash: string }> {
    // Step 1: Get attested decryption (user signs with Solana wallet)
    console.log("\n📝 Step 1: Requesting attested decryption...");
    console.log("   (Your wallet will prompt you to sign a message)");
    
    const attestation = await requestAttestedDecrypt(handle, solanaWallet);
    console.log(`   ✅ Decrypted amount: ${attestation.plaintext}`);
    
    // Step 2: Call Base contract to mint with attestation
    console.log("\n📝 Step 2: Minting on Base with attestation...");
    
    // For now, use confidentialMintForDemo which takes plaintext
    // In production, you'd verify the covalidator signature on-chain
    const CONFIDENTIAL_TOKEN_ABI = [
        {
            name: 'confidentialMintForDemo',
            type: 'function',
            inputs: [
                { name: 'to', type: 'address' },
                { name: 'plainAmount', type: 'uint256' },
            ],
            outputs: [],
            stateMutability: 'payable',
        },
    ] as const;
    
    // Get Inco fee (approximately 0.001 ETH)
    const incoFee = BigInt("1000000000000"); // 0.000001 ETH
    
    const hash = await evmSigner.writeContract({
        address: confidentialTokenAddress,
        abi: CONFIDENTIAL_TOKEN_ABI,
        functionName: 'confidentialMintForDemo',
        args: [destinationEvm, attestation.plaintext],
        value: incoFee,
    });
    
    console.log(`   ✅ Base TX: ${hash}`);
    
    return {
        plaintextAmount: attestation.plaintext,
        baseTxHash: hash,
    };
}

/**
 * Parse ConfidentialBridgeOutEvent from Solana transaction logs.
 * Used to extract the handle after calling bridge_confidential_out.
 */
export function parseConfidentialBridgeOutEvent(logs: string[]): {
    vault: string;
    owner: string;
    destinationEvm: string;
    encryptedAmountHandle: bigint;
} | null {
    // Anchor event discriminator for ConfidentialBridgeOutEvent
    // sha256("event:ConfidentialBridgeOutEvent")[0:8]
    const EXPECTED_DISCRIMINATOR = Buffer.from("fee3f47c36edab41", "hex");
    
    for (const log of logs) {
        if (log.startsWith("Program data:")) {
            try {
                const base64Data = log.replace("Program data: ", "");
                const data = Buffer.from(base64Data, "base64");
                
                // Check discriminator
                const discriminator = data.subarray(0, 8);
                if (!discriminator.equals(EXPECTED_DISCRIMINATOR)) {
                    continue;
                }
                
                // Parse event data
                if (data.length >= 8 + 32 + 32 + 20 + 16) {
                    let offset = 8;
                    
                    // vault: Pubkey (32 bytes)
                    const vault = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
                    offset += 32;
                    
                    // owner: Pubkey (32 bytes)  
                    const owner = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
                    offset += 32;
                    
                    // destination_evm: [u8; 20]
                    const destinationEvm = "0x" + data.subarray(offset, offset + 20).toString("hex");
                    offset += 20;
                    
                    // encrypted_amount_handle: u128 (16 bytes, little-endian)
                    const handleBytes = data.subarray(offset, offset + 16);
                    let handle = BigInt(0);
                    for (let i = 0; i < 16; i++) {
                        handle += BigInt(handleBytes[i] ?? 0) << BigInt(i * 8);
                    }
                    
                    return {
                        vault,
                        owner,
                        destinationEvm,
                        encryptedAmountHandle: handle,
                    };
                }
            } catch {
                // Not our event
            }
        }
    }
    
    return null;
}
