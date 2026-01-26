"use client";

import { useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { BRIDGE_PROGRAM_ID, SOLANA_CDARK_TOKEN_MINT, INCO_LIGHTNING_PROGRAM_ID } from "@/lib/constants";
import { decrypt } from "@inco/solana-sdk/attested-decrypt";

// Inco Lightning Program ID on Solana Devnet
const INCO_LIGHTNING_ID = new PublicKey(INCO_LIGHTNING_PROGRAM_ID);

// Vault seed prefix
const VAULT_SEED_PREFIX = "confidential_vault";

function readU128LE(buffer: Uint8Array): bigint {
    let result = BigInt(0);
    for (let i = 0; i < Math.min(16, buffer.length); i++) {
        result += BigInt(buffer[i] ?? 0) << BigInt(i * 8);
    }
    return result;
}

function deriveVaultPda(owner: PublicKey, tokenMint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [
            Buffer.from(VAULT_SEED_PREFIX),
            owner.toBuffer(),
            tokenMint.toBuffer(),
        ],
        new PublicKey(BRIDGE_PROGRAM_ID)
    );
}

interface VaultData {
    owner: string;
    tokenMint: string;
    bridgeAuthority: string;
    encryptedBalanceHandle: bigint;
    bump: number;
}

// Helper to convert handle to 16-byte little-endian buffer
function handleToBuffer(handle: bigint): Buffer {
    const buffer = Buffer.alloc(16);
    let h = handle;
    for (let i = 0; i < 16; i++) {
        buffer[i] = Number(h & BigInt(0xff));
        h >>= BigInt(8);
    }
    return buffer;
}

// Derive the allowance PDA for grant_handle_access
function deriveAllowancePDA(handle: bigint, allowedAddress: PublicKey): [PublicKey, number] {
    const handleBuffer = handleToBuffer(handle);
    return PublicKey.findProgramAddressSync(
        [handleBuffer, allowedAddress.toBuffer()],
        INCO_LIGHTNING_ID
    );
}

// Pre-computed discriminator for grant_handle_access
// sha256("global:grant_handle_access")[0:8] = 24470d30a07322ff
const GRANT_HANDLE_ACCESS_DISCRIMINATOR = Buffer.from([0x24, 0x47, 0x0d, 0x30, 0xa0, 0x73, 0x22, 0xff]);

export function VaultBalance() {
    const { publicKey, connected, signMessage, signTransaction } = useWallet();
    const { connection } = useConnection();

    const [vaultExists, setVaultExists] = useState<boolean | null>(null);
    const [vaultData, setVaultData] = useState<VaultData | null>(null);
    const [vaultPda, setVaultPda] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [decryptedBalance, setDecryptedBalance] = useState<bigint | null>(null);
    const [decrypting, setDecrypting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<string>("");
    const [mounted, setMounted] = useState(false);
    const [lastHandle, setLastHandle] = useState<string>("");

    useEffect(() => {
        setMounted(true);
    }, []);

    const tokenMint = new PublicKey(SOLANA_CDARK_TOKEN_MINT);

    // Fetch vault data when wallet connects
    useEffect(() => {
        if (connected && publicKey) {
            fetchVaultData();
        } else {
            setVaultExists(null);
            setVaultData(null);
            setDecryptedBalance(null);
        }
    }, [connected, publicKey]);

    // Auto-poll for vault updates every 10 seconds
    useEffect(() => {
        if (!connected || !publicKey) return;
        
        const interval = setInterval(async () => {
            // Silently check for updates
            try {
                const [pda] = deriveVaultPda(publicKey, tokenMint);
                const accountInfo = await connection.getAccountInfo(pda);
                
                if (accountInfo) {
                    const data = accountInfo.data;
                    // Correct offset: discriminator (8) + owner (32) + token_mint (32) = 72
                    const encryptedBalance = data.subarray(8 + 32 + 32, 8 + 32 + 32 + 16);
                    const newHandle = readU128LE(encryptedBalance).toString();
                    
                    // If handle changed, refresh the full data
                    if (newHandle !== lastHandle) {
                        console.log("Vault handle changed! Refreshing...", newHandle);
                        setLastHandle(newHandle);
                        setDecryptedBalance(null); // Reset decrypted balance
                        setError(null);
                        fetchVaultData();
                    }
                }
            } catch (e) {
                // Silent fail for polling
            }
        }, 10000); // Poll every 10 seconds
        
        return () => clearInterval(interval);
    }, [connected, publicKey, lastHandle, connection]);

    const fetchVaultData = async () => {
        if (!publicKey) return;

        setLoading(true);
        setError(null);

        try {
            const [pda] = deriveVaultPda(publicKey, tokenMint);
            setVaultPda(pda.toBase58());

            const accountInfo = await connection.getAccountInfo(pda);

            if (!accountInfo) {
                setVaultExists(false);
                setVaultData(null);
                return;
            }

            setVaultExists(true);

            // Parse vault data
            // Structure: discriminator (8) + owner (32) + token_mint (32) + encrypted_balance (16) + bridge_authority (32) + bump (1)
            const data = accountInfo.data;

            const ownerBytes = data.subarray(8, 8 + 32);
            const tokenMintBytes = data.subarray(8 + 32, 8 + 32 + 32);
            const encryptedBalance = data.subarray(8 + 32 + 32, 8 + 32 + 32 + 16);
            const bridgeAuthorityBytes = data.subarray(8 + 32 + 32 + 16, 8 + 32 + 32 + 16 + 32);
            const bump = data[8 + 32 + 32 + 16 + 32];

            console.log("Parsed vault - encrypted balance bytes:", Buffer.from(encryptedBalance).toString('hex'));
            console.log("Parsed vault - handle:", readU128LE(encryptedBalance).toString());

            setVaultData({
                owner: new PublicKey(ownerBytes).toBase58(),
                tokenMint: new PublicKey(tokenMintBytes).toBase58(),
                bridgeAuthority: new PublicKey(bridgeAuthorityBytes).toBase58(),
                encryptedBalanceHandle: readU128LE(encryptedBalance),
                bump: bump ?? 0,
            });
            
            // Track the handle for change detection
            setLastHandle(readU128LE(encryptedBalance).toString());
        } catch (err: any) {
            console.error("Error fetching vault:", err);
            setError(err.message || "Failed to fetch vault");
        } finally {
            setLoading(false);
        }
    };

    const handleDecrypt = async () => {
        if (!publicKey || !signMessage || !signTransaction || !vaultData) {
            setError("Wallet not connected or missing signMessage/signTransaction capability");
            return;
        }

        if (vaultData.encryptedBalanceHandle === BigInt(0)) {
            setError("Vault has no balance to decrypt");
            return;
        }

        setDecrypting(true);
        setError(null);
        setStatus("Starting attested decrypt...");

        try {
            const handle = vaultData.encryptedBalanceHandle;

            // Step 1: Grant handle access (required before decryption)
            setStatus("Granting handle access (sign TX)...");
            
            const [allowancePDA] = deriveAllowancePDA(handle, publicKey);
            console.log("Allowance PDA:", allowancePDA.toBase58());

            // Build grant_handle_access instruction
            const handleBuffer = handleToBuffer(handle);
            const instructionData = Buffer.concat([
                GRANT_HANDLE_ACCESS_DISCRIMINATOR,
                handleBuffer,
            ]);

            const instruction = new TransactionInstruction({
                programId: new PublicKey(BRIDGE_PROGRAM_ID),
                keys: [
                    { pubkey: publicKey, isSigner: true, isWritable: true },
                    { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: allowancePDA, isSigner: false, isWritable: true },
                    { pubkey: publicKey, isSigner: false, isWritable: false },
                ],
                data: instructionData,
            });

            const tx = new Transaction().add(instruction);
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = publicKey;

            try {
                const signedTx = await signTransaction(tx);
                const sig = await connection.sendRawTransaction(signedTx.serialize());
                await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
                console.log("Handle access granted:", sig);
                setStatus(`Handle access granted! TX: ${sig.slice(0, 20)}...`);
                
                // Wait a bit for the allowance to propagate
                await new Promise(r => setTimeout(r, 2000));
            } catch (grantErr: any) {
                console.error("Grant handle access error:", grantErr);
                // Check if it's "already in use" which means allowance already exists
                if (grantErr.message?.includes("already in use") || 
                    grantErr.logs?.some((l: string) => l.includes("already in use"))) {
                    console.log("Allowance already exists, continuing...");
                    setStatus("Allowance already exists, decrypting...");
                } else {
                    // Log the full error for debugging
                    console.error("Grant TX failed:", grantErr.logs || grantErr.message);
                    setError(`Grant handle access failed: ${grantErr.message}. Check console for details.`);
                    setDecrypting(false);
                    return;
                }
            }

            // Step 2: Use Inco SDK for attested decrypt
            setStatus("Sign message to prove ownership...");

            try {
                const result = await decrypt([handle.toString()], {
                    address: publicKey,
                    signMessage: signMessage,
                });
                
                console.log("Decrypt result:", result);
                
                if (result.plaintexts && result.plaintexts.length > 0) {
                    const plaintext = BigInt(result.plaintexts[0]);
                    setDecryptedBalance(plaintext);
                    setStatus("Decryption successful!");
                } else {
                    throw new Error("No plaintext returned from decryption");
                }
            } catch (decryptErr: any) {
                console.error("Decrypt SDK error:", decryptErr);
                // Check for "No ciphertext found" error
                if (decryptErr.message?.includes("No ciphertext found") || 
                    decryptErr.message?.includes("ciphertext")) {
                    throw new Error(
                        "Handle expired! The encrypted value no longer exists in Inco's TEE. " +
                        "This happens when the Inco network is reset. " +
                        "Please bridge fresh tokens from Base → Solana to create a new encrypted balance."
                    );
                }
                throw decryptErr;
            }
        } catch (err: any) {
            console.error("Decrypt error:", err);
            setError(err.message || "Decryption failed");
            setStatus("");
        } finally {
            setDecrypting(false);
        }
    };

    if (!mounted) {
        return (
            <div className="p-6 bg-neutral-900 rounded-lg border border-neutral-800">
                <h2 className="text-lg font-semibold mb-2">Solana Vault</h2>
                <p className="text-neutral-400 text-sm">Loading...</p>
            </div>
        );
    }

    if (!connected) {
        return (
            <div className="p-6 bg-neutral-900 rounded-lg border border-neutral-800">
                <h2 className="text-lg font-semibold mb-2">Solana Vault</h2>
                <p className="text-neutral-400 text-sm">Connect Solana wallet to view your vault</p>
            </div>
        );
    }

    return (
        <div className="p-6 bg-neutral-900 rounded-lg border border-neutral-800">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Solana Vault</h2>
                <button
                    onClick={fetchVaultData}
                    disabled={loading}
                    className="text-xs text-blue-400 hover:text-blue-300 disabled:text-neutral-500"
                >
                    {loading ? "Loading..." : "Refresh"}
                </button>
            </div>

            {/* Vault Address */}
            {vaultPda && (
                <div className="mb-4 p-3 bg-neutral-800 rounded text-xs">
                    <p className="text-neutral-400 mb-1">Vault PDA</p>
                    <a
                        href={`https://explorer.solana.com/address/${vaultPda}?cluster=devnet`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:underline break-all"
                    >
                        {vaultPda}
                    </a>
                </div>
            )}

            {loading && (
                <div className="text-center py-4">
                    <p className="text-neutral-400">Loading vault data...</p>
                </div>
            )}

            {!loading && vaultExists === false && (
                <div className="p-4 bg-yellow-900/30 border border-yellow-700 rounded text-sm">
                    <p className="text-yellow-200">No vault found</p>
                    <p className="text-yellow-300/70 text-xs mt-1">
                        Bridge tokens from Base → Solana to create your vault
                    </p>
                </div>
            )}

            {!loading && vaultExists && vaultData && (
                <div className="space-y-4">
                    {/* Encrypted Balance Handle */}
                    <div className="p-4 bg-neutral-800 rounded">
                        <p className="text-sm text-neutral-400 mb-2">Encrypted Balance Handle</p>
                        <p className="text-lg font-mono text-white break-all">
                            {vaultData.encryptedBalanceHandle === BigInt(0)
                                ? "0 (empty)"
                                : vaultData.encryptedBalanceHandle.toString()}
                        </p>
                        <p className="text-xs text-neutral-500 mt-2">
                            This is NOT your balance. It&apos;s an encrypted reference stored in Inco TEE.
                        </p>
                    </div>

                    {/* Decrypted Balance */}
                    {decryptedBalance !== null && (
                        <div className="p-4 bg-green-900/30 border border-green-700 rounded">
                            <p className="text-sm text-green-400 mb-2">Decrypted Balance</p>
                            <p className="text-2xl font-bold text-green-300">
                                {(Number(decryptedBalance) / 1e18).toFixed(4)} cDARK
                            </p>
                            <p className="text-xs text-green-400/70 mt-2">
                                ✓ Successfully decrypted using Inco attested decrypt
                            </p>
                        </div>
                    )}

                    {/* Decrypt Button */}
                    {vaultData.encryptedBalanceHandle !== BigInt(0) && decryptedBalance === null && (
                        <button
                            onClick={handleDecrypt}
                            disabled={decrypting}
                            className="w-full py-3 bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 disabled:cursor-not-allowed rounded font-medium transition-colors"
                        >
                            {decrypting ? (status || "Decrypting...") : "🔓 Decrypt Balance (Attested)"}
                        </button>
                    )}

                    {/* Decrypt Again Button */}
                    {decryptedBalance !== null && (
                        <button
                            onClick={() => {
                                setDecryptedBalance(null);
                                setStatus("");
                            }}
                            className="w-full py-2 bg-neutral-700 hover:bg-neutral-600 rounded text-sm font-medium transition-colors"
                        >
                            Clear & Decrypt Again
                        </button>
                    )}

                    {/* Status */}
                    {status && !decryptedBalance && (
                        <p className="text-sm text-blue-400 text-center">{status}</p>
                    )}

                    {/* Info */}
                    <div className="p-3 bg-neutral-800/50 rounded text-xs text-neutral-400">
                        <p className="font-medium text-neutral-300 mb-1">How attested decrypt works:</p>
                        <ol className="list-decimal list-inside space-y-1">
                            <li>Sign a message to prove wallet ownership</li>
                            <li>Inco TEE verifies your signature</li>
                            <li>TEE returns the decrypted plaintext value</li>
                        </ol>
                    </div>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="mt-4 p-3 bg-red-900/30 border border-red-800 rounded text-sm">
                    <p className="text-red-300 font-medium mb-2">⚠️ Error</p>
                    <p className="text-red-200/80">{error}</p>
                    {error.includes("Handle expired") && (
                        <div className="mt-3 pt-3 border-t border-red-800/50">
                            <p className="text-yellow-300 text-xs font-medium">💡 How to fix:</p>
                            <ol className="list-decimal list-inside text-xs text-neutral-300 mt-1 space-y-1">
                                <li>Use the Faucet to get cDARK on Base</li>
                                <li>Bridge Base → Solana to create a fresh encrypted balance</li>
                                <li>Wait for relayer to process (check terminal)</li>
                                <li>Refresh and try decrypt again</li>
                            </ol>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
