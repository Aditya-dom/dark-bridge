/**
 * Check Solana Vault Balance
 * 
 * Shows the encrypted balance handle in your Solana vault.
 * Note: The actual decrypted value requires attested decrypt.
 * 
 * Usage: bun run src/check-vault-balance.ts [SOLANA_PUBKEY]
 */

import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// Configuration
const SOLANA_RPC = "https://api.devnet.solana.com";
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");

// Token mint (matches remoteToken on EVM contract)
const TOKEN_MINT = new PublicKey("2wcB7tJ56xTa68zMstHhMBYymeCaBvG3Vp2xW9JMVNrH");

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
        BRIDGE_PROGRAM_ID
    );
}

async function main() {
    const connection = new Connection(SOLANA_RPC, "confirmed");

    // Get pubkey from args or default keypair
    let ownerPubkey: PublicKey;
    
    if (process.argv[2]) {
        ownerPubkey = new PublicKey(process.argv[2]);
    } else {
        // Try to load default keypair
        const keypairPath = path.join(process.env.HOME || "", ".config/solana/id.json");
        try {
            const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
            const { Keypair } = await import("@solana/web3.js");
            const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
            ownerPubkey = keypair.publicKey;
        } catch {
            console.error("Usage: bun run src/check-vault-balance.ts <SOLANA_PUBKEY>");
            console.error("Or configure default keypair at ~/.config/solana/id.json");
            process.exit(1);
        }
    }

    console.log("=".repeat(60));
    console.log(" Solana Vault Balance Checker");
    console.log("=".repeat(60));
    console.log(`\nOwner: ${ownerPubkey.toBase58()}`);
    console.log(`Token Mint: ${TOKEN_MINT.toBase58()}`);

    // Derive vault PDA
    const [vaultPda, bump] = deriveVaultPda(ownerPubkey, TOKEN_MINT);
    console.log(`\nVault PDA: ${vaultPda.toBase58()}`);

    // Fetch vault account
    const vaultAccount = await connection.getAccountInfo(vaultPda);
    
    if (!vaultAccount) {
        console.log("\n❌ Vault does not exist!");
        console.log("   You need to initialize a vault first by bridging from Base → Solana");
        return;
    }

    console.log(`✓ Vault exists (${vaultAccount.data.length} bytes)`);

    // Parse vault data
    // Structure: discriminator (8) + owner (32) + token_mint (32) + bridge_authority (32) + encrypted_balance (16) + bump (1)
    const vaultData = vaultAccount.data;
    
    const ownerBytes = vaultData.subarray(8, 8 + 32);
    const tokenMintBytes = vaultData.subarray(8 + 32, 8 + 32 + 32);
    const bridgeAuthorityBytes = vaultData.subarray(8 + 32 + 32, 8 + 32 + 32 + 32);
    const encryptedBalance = vaultData.subarray(8 + 32 + 32 + 32, 8 + 32 + 32 + 32 + 16);
    const vaultBump = vaultData[8 + 32 + 32 + 32 + 16];

    const storedOwner = new PublicKey(ownerBytes);
    const storedMint = new PublicKey(tokenMintBytes);
    const storedBridgeAuth = new PublicKey(bridgeAuthorityBytes);
    const balanceHandle = readU128LE(encryptedBalance);

    console.log("\n--- Vault Details ---");
    console.log(`Owner: ${storedOwner.toBase58()}`);
    console.log(`Token Mint: ${storedMint.toBase58()}`);
    console.log(`Bridge Authority: ${storedBridgeAuth.toBase58()}`);
    console.log(`Bump: ${vaultBump}`);
    
    console.log("\n--- Balance Info ---");
    console.log(`Encrypted Balance Handle: ${balanceHandle}`);
    
    if (balanceHandle === 0n) {
        console.log("\n⚠️  Balance handle is 0 - vault is empty or just initialized");
        console.log("   Bridge some tokens from Base → Solana to receive funds");
    } else {
        console.log("\n✓ Vault has an encrypted balance!");
        console.log("  The actual amount is encrypted using Inco TEE (Euint128)");
        console.log("  Use attested decrypt to reveal the actual value");
        console.log("\n  Note: The handle is NOT the token amount.");
        console.log("  It's a reference to the encrypted value stored in Inco TEE.");
    }

    console.log("\n" + "=".repeat(60));
}

main().catch(console.error);
