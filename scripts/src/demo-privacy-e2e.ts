#!/usr/bin/env bun
/**
 * Privacy Bridge E2E Demo
 * 
 * Complete demonstration of private cross-chain transfers using Inco Lightning.
 * Perfect for hackathon demos - shows the full flow with detailed explanations.
 * 
 * Usage:
 *   EVM_PRIVATE_KEY=0x... bun run src/demo-privacy-e2e.ts
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    formatEther,
    parseEther,
    type Address,
    type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";

// Dynamically import Inco SDK (ESM module)
let Lightning: any;
try {
    const inco = await import("@inco/js/lite");
    Lightning = inco.Lightning;
} catch (e) {
    console.log("Note: @inco/js not available, encryption will be simulated");
}

// --- Configuration ---
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Deployed addresses
const CONFIDENTIAL_BRIDGE = "0x7C788FE737acf46e2dbc2F6219653533bd02c558" as Address;
const CONFIDENTIAL_TOKEN = "0x905367eff70fE43F0792bf16DB183a6929E181d7" as Address;
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

// --- Clients ---
const basePublicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

const baseWalletClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// --- ABIs ---
const CONFIDENTIAL_BRIDGE_ABI = [
    {
        name: "bridgePrivateToSolana",
        type: "function",
        stateMutability: "payable",
        inputs: [
            { name: "localToken", type: "address" },
            { name: "toSolana", type: "bytes32" },
            { name: "encryptedAmount", type: "bytes" },
        ],
        outputs: [],
    },
    {
        name: "getIncoFee",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "confidentialNonce",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
] as const;

const CONFIDENTIAL_TOKEN_ABI = [
    {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "owner", type: "address" }],
        outputs: [{ type: "bytes32" }], // Returns euint256 handle
    },
    {
        name: "name",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
    {
        name: "symbol",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
] as const;

// --- Demo Functions ---

function printHeader(title: string) {
    console.log("\n" + "=".repeat(60));
    console.log(`  ${title}`);
    console.log("=".repeat(60) + "\n");
}

function printStep(step: number, description: string) {
    console.log(`\n📍 Step ${step}: ${description}`);
    console.log("-".repeat(40));
}

async function demoIntroduction() {
    printHeader("🔒 Dark Bridge Privacy Demo");

    console.log(`
Welcome to the Dark Bridge Privacy Demo!

This demonstrates the first bidirectional PRIVACY BRIDGE between 
Base (EVM) and Solana (SVM) using Inco Lightning.

What makes this special?
========================
• Transfer amounts are ENCRYPTED using Inco's TEE covalidators
• Neither chain reveals the actual transfer amount
• Only the sender and recipient can decrypt their balances
• Front-running and MEV attacks are impossible

Technology Stack:
• EVM: Solidity with euint256 encrypted handles
• SVM: Rust/Anchor with Euint128 encrypted handles  
• Inco Lightning: TEE-based encrypted computation
• Cross-chain: Handle conversion (euint256 ↔ Euint128)
`);

    console.log("\nYour Wallet:");
    console.log(`   Address: ${evmAccount.address}`);

    const balance = await basePublicClient.getBalance({ address: evmAccount.address });
    console.log(`   Balance: ${formatEther(balance)} ETH`);
}

async function demoCheckContracts() {
    printStep(1, "Checking Deployed Contracts");

    console.log("Confidential Bridge Contract:");
    console.log(`   Address: ${CONFIDENTIAL_BRIDGE}`);

    try {
        const nonce = await basePublicClient.readContract({
            address: CONFIDENTIAL_BRIDGE,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "confidentialNonce",
        });
        console.log(`   Contract is live! Current nonce: ${nonce}`);

        const fee = await basePublicClient.readContract({
            address: CONFIDENTIAL_BRIDGE,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "getIncoFee",
        });
        console.log(`   Inco Fee: ${formatEther(fee)} ETH`);
    } catch (e: any) {
        console.log(`   Error reading contract: ${e.message}`);
    }

    console.log("\nConfidential Token Contract:");
    console.log(`   Address: ${CONFIDENTIAL_TOKEN}`);

    try {
        const name = await basePublicClient.readContract({
            address: CONFIDENTIAL_TOKEN,
            abi: CONFIDENTIAL_TOKEN_ABI,
            functionName: "name",
        });
        const symbol = await basePublicClient.readContract({
            address: CONFIDENTIAL_TOKEN,
            abi: CONFIDENTIAL_TOKEN_ABI,
            functionName: "symbol",
        });
        console.log(`   Token: ${name} (${symbol})`);
    } catch (e: any) {
        console.log(`   Token may need initialization`);
    }
}

async function demoEncryption() {
    printStep(2, "Encrypting Transfer Amount");

    const amount = parseEther("10"); // 10 tokens
    console.log(`\nAmount to encrypt: ${formatEther(amount)} tokens`);

    console.log("\nHow Inco Encryption Works:");
    console.log(`
   1. Client calls Inco SDK: zap.encrypt(amount, {accountAddress, dappAddress})
   2. SDK encrypts locally using network's public key
   3. Returns ciphertext (bytes) that can be sent on-chain
   4. Contract calls newEuint256(ciphertext, msg.sender)
   5. Inco covalidators store the encrypted value off-chain
   6. Returns a handle (bytes32) that references the encrypted value
`);

    if (Lightning) {
        try {
            console.log("   Initializing Inco Lightning...");
            const zap = await Lightning.latest("testnet", 84532);

            console.log("   Encrypting amount...");
            const ciphertext = await zap.encrypt(amount, {
                accountAddress: evmAccount.address,
                dappAddress: CONFIDENTIAL_BRIDGE,
            });

            console.log(`\nEncryption successful!`);
            console.log(`   Ciphertext length: ${(ciphertext as string).length} bytes`);
            console.log(`   Preview: ${(ciphertext as string).slice(0, 66)}...`);

            return ciphertext as Hex;
        } catch (e: any) {
            console.log(`\n Encryption failed: ${e.message}`);
            console.log("   Using simulated ciphertext for demo...");
        }
    } else {
        console.log("\n @inco/js not available");
        console.log("   Install with: bun add @inco/js");
    }

    // Return simulated ciphertext for demo
    const simulatedCiphertext = "0x" + "ab".repeat(64) as Hex;
    console.log(`\n Simulated ciphertext: ${simulatedCiphertext.slice(0, 50)}...`);
    return simulatedCiphertext;
}

async function demoBridgePrivate(ciphertext: Hex) {
    printStep(3, "Bridging Private Tokens to Solana");

    // Generate a random Solana recipient for demo
    const solanaRecipient = Keypair.generate().publicKey;
    const recipientBytes32 = "0x" + Buffer.from(solanaRecipient.toBytes()).toString("hex") as Hex;

    console.log(`\nTransfer Details:`);
    console.log(`   From: ${evmAccount.address} (Base)`);
    console.log(`   To: ${solanaRecipient.toBase58()} (Solana)`);
    console.log(`   Amount: [ENCRYPTED - only parties can see]`);

    console.log("\nTransaction Flow:");
    console.log(`
   1. User calls bridgePrivateToSolana(token, recipient, encryptedAmount)
   2. Contract creates euint256 handle from ciphertext
   3. Burns tokens from user's encrypted balance
   4. Stores expected handle for cross-chain verification
   5. Emits ConfidentialBridgeInitiated event
   6. Relayer picks up event and calls Solana bridge
   7. Solana mints encrypted tokens to recipient's vault
`);

    // Check balance
    const balance = await basePublicClient.getBalance({ address: evmAccount.address });
    if (balance < parseEther("0.01")) {
        console.log("\n  Insufficient balance for demo transaction");
        console.log("   Get test ETH from: https://www.base.org/faucet");
        return;
    }

    console.log("\n Would you like to execute the bridge transaction?");
    console.log("   (This is a demo - transaction not actually sent)");
    console.log("\n   To execute for real, use:");
    console.log(`   
   const hash = await walletClient.writeContract({
       address: "${CONFIDENTIAL_BRIDGE}",
       abi: CONFIDENTIAL_BRIDGE_ABI,
       functionName: "bridgePrivateToSolana",
       args: [
           "${CONFIDENTIAL_TOKEN}",
           "${recipientBytes32}",
           "${ciphertext.slice(0, 20)}..."
       ],
       value: incoFee,
   });
`);
}

async function demoSolanaIntegration() {
    printStep(4, "Solana Privacy Integration");

    console.log("\nSolana Side Architecture:");
    console.log(`
   ConfidentialVault Account:
   ├── owner: Pubkey
   ├── token_mint: Pubkey  
   ├── encrypted_balance: Euint128 (u128 handle)
   ├── bridge_authority: Pubkey
   └── bump: u8

   Instructions:
   ├── initialize_confidential_vault() - Create vault with zero balance
   ├── bridge_confidential_out() - Burn encrypted, emit bridge event
   └── receive_confidential_in() - Mint encrypted from bridge
`);

    console.log("\nInco Lightning CPI Operations:");
    console.log(`
   use inco_lightning::cpi::{e_add, e_sub, e_ge, e_select, new_euint128, allow};
   
   // Create encrypted handle from ciphertext
   let amount: Euint128 = new_euint128(cpi_ctx, encrypted_bytes, 0)?;
   
   // Check sufficient balance (encrypted comparison)
   let has_balance: Ebool = e_ge(cpi_ctx, vault.balance, amount, 0)?;
   
   // Conditional selection (no information leakage!)
   let actual = e_select(cpi_ctx, has_balance, amount, zero, 0)?;
   
   // Update balance
   vault.balance = e_sub(cpi_ctx, vault.balance, actual, 0)?;
   
   // Grant decrypt access to owner
   allow(cpi_ctx, vault.balance.0, true, owner)?;
`);

    console.log("\n Deployed Programs:");
    console.log(`   Bridge Program: ${BRIDGE_PROGRAM_ID.toBase58()}`);
    console.log(`   Inco Lightning: ${INCO_LIGHTNING_ID.toBase58()}`);
}

async function demoRelayers() {
    printStep(5, "Privacy Relayers");

    console.log("\n Relayer Architecture:");
    console.log(`
   ┌─────────────────┐        ┌──────────────────┐
   │   Base Sepolia  │        │  Solana Devnet   │
   │                 │        │                  │
   │  Confidential   │───────▶│  Confidential    │
   │     Bridge      │ events │     Vault        │
   │                 │        │                  │
   └────────┬────────┘        └────────▲─────────┘
            │                          │
            │  ConfidentialBridge      │  receive_confidential_in
            │  Initiated event         │  instruction
            │                          │
            └──────────┬───────────────┘
                       │
                ┌──────▼──────┐
                │   Privacy   │
                │   Relayer   │
                │             │
                │ Converts:   │
                │ euint256 →  │
                │ Euint128    │
                └─────────────┘
`);

    console.log("\n Running Relayers:");
    console.log(`
   # Terminal 1: Solana → Base
   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-sol-to-base.ts --monitor

   # Terminal 2: Base → Solana  
   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts --monitor
`);
}

async function demoSecurityFeatures() {
    printStep(6, "Security Features");

    console.log("\n Privacy Guarantees:");
    console.log(`
   ✅ Transfer amounts never visible on-chain
   ✅ Balance handles are meaningless without decryption key
   ✅ Only authorized addresses can decrypt (via allow())
   ✅ Inco covalidators run in TEE (Trusted Execution Environment)
`);

    console.log("\n Anti-Attack Measures:");
    console.log(`
   Handle Verification:
   - Nonce-based verification prevents handle swapping
   - expectedHandles[nonce] stores outgoing handle
   - receiveFromSolana verifies handle matches
   
   if (receivedHandle != expectedHandles[nonce]) revert HandleMismatch();
   delete expectedHandles[nonce]; // Prevent replay

   Access Control:
   - Every new handle requires allow() call
   - allowThis() for contract to use value in future
   - select() for if/else without leaking condition
`);
}

async function demoConclusion() {
    printHeader(" Demo Complete!");

    console.log(`
Summary:
========
You've seen how Dark Bridge enables PRIVATE cross-chain transfers:

1. Amounts encrypted using Inco Lightning (TEE-based)
2. Confidential ERC20 with euint256 balances on Base
3. Confidential Vault with Euint128 balances on Solana
4. Privacy-preserving bridge messages
5. Handle verification to prevent attacks
6. Permissionless relayers for decentralization

Next Steps:
===========
• Run the privacy relayers:
  bun run src/privacy-relayer-sol-to-base.ts --monitor
  bun run src/privacy-relayer-base-to-sol.ts --monitor

• Test with real transactions:
  - Get test ETH: https://www.base.org/faucet
  - Get SOL devnet: solana airdrop 1

• Check the code:
  - EVM: base/src/ConfidentialBridge.sol
  - SVM: solana/programs/bridge/src/confidential/

Documentation:
- CLAUDE.md for full integration guide
- PRIVACY_ARCHITECTURE.md for deep dive
`);

}

// --- Main ---
async function main() {
    await demoIntroduction();
    await demoCheckContracts();
    const ciphertext = await demoEncryption();
    await demoBridgePrivate(ciphertext);
    await demoSolanaIntegration();
    await demoRelayers();
    await demoSecurityFeatures();
    await demoConclusion();
}

main().catch(console.error);
