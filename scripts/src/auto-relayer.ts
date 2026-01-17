#!/usr/bin/env bun
/**
 * Automatic Relayer Service 
 * 
 * Run this as a service to automatically relay Solana→Base messages.
 * Usage: EVM_PRIVATE_KEY=0x... bun run src/auto-relayer.ts [message-pubkey]
 * 
 * Without a message pubkey, it monitors the validator nonce.
 * With a message pubkey, it processes that specific message.
 */

import { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, toHex, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createSolanaRpc, getBase58Encoder, type Address as SolAddress } from "@solana/kit";
import { fetchOutgoingMessage, type Call } from "@base/bridge/bridge";

const BRIDGE_VALIDATOR_ABI = [
    {
        name: "registerMessages",
        type: "function",
        inputs: [
            {
                name: "signedMessages",
                type: "tuple[]",
                components: [
                    { name: "innerMessageHash", type: "bytes32" },
                    { name: "outgoingMessagePubkey", type: "bytes32" },
                ],
            },
            { name: "validatorSigs", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    { name: "nextNonce", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
    { name: "validMessages", type: "function", inputs: [{ name: "messageHash", type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" },
] as const;

const BRIDGE_ABI = [
    {
        name: "relayMessages", type: "function", inputs: [{
            name: "messages", type: "tuple[]", components: [
                { name: "outgoingMessagePubkey", type: "bytes32" },
                { name: "nonce", type: "uint64" },
                { name: "sender", type: "bytes32" },
                { name: "gasLimit", type: "uint64" },
                { name: "ty", type: "uint8" },
                { name: "data", type: "bytes" },
            ]
        }], outputs: [], stateMutability: "nonpayable"
    },
    { name: "successes", type: "function", inputs: [{ name: "messageHash", type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" },
    { name: "failures", type: "function", inputs: [{ name: "messageHash", type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" },
] as const;

const BRIDGE_VALIDATOR = "0x9fc354b36a6a1da0c1dBdcE2fc73793eAb6FC462";
const BRIDGE_CONTRACT = "0x8e46419298a9620ea326113baf4019a23594bb11";
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const MessageType = { Call: 0, Transfer: 1, TransferAndCall: 2 } as const;

const account = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);
const solRpc = createSolanaRpc("https://api.devnet.solana.com");
const publicClient = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http("https://sepolia.base.org") });

console.log("=== Dark Bridge Auto-Relayer ===");
console.log(`Signer: ${account.address}`);

async function processMessage(messagePubkey: string): Promise<boolean> {
    console.log(`\n=== Processing: ${messagePubkey} ===`);

    try {
        const outgoing = await fetchOutgoingMessage(solRpc, messagePubkey as SolAddress);
        const nonce = BigInt(outgoing.data.nonce);
        const senderBytes32 = bytes32FromPubkey(outgoing.data.sender);
        const { ty, data } = buildIncomingPayload(outgoing);

        const innerHash = keccak256(
            encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "bytes" }], [senderBytes32, ty, data])
        );

        const pubkeyBytes = getBase58Encoder().encode(outgoing.address);
        const pubkeyBytes32 = toHex(new Uint8Array(pubkeyBytes)) as Hex;

        const outerHash = keccak256(
            encodeAbiParameters([{ type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }], [nonce, pubkeyBytes32, innerHash])
        );

        console.log(`   Nonce: ${nonce}, OuterHash: ${outerHash.slice(0, 18)}...`);

        // Check if already processed
        const isRelayed = await publicClient.readContract({ address: BRIDGE_CONTRACT, abi: BRIDGE_ABI, functionName: "successes", args: [outerHash] });
        const isFailed = await publicClient.readContract({ address: BRIDGE_CONTRACT, abi: BRIDGE_ABI, functionName: "failures", args: [outerHash] });

        if (isRelayed) { console.log("   Already relayed (success)!"); return true; }
        if (isFailed) { console.log("   Already relayed (inner call failed)"); return true; }

        // Check registration
        const isValid = await publicClient.readContract({ address: BRIDGE_VALIDATOR, abi: BRIDGE_VALIDATOR_ABI, functionName: "validMessages", args: [outerHash] });

        if (!isValid) {
            console.log("   Registering...");
            await registerMessage(nonce, innerHash, pubkeyBytes32);
        }

        // Relay
        console.log("   Relaying...");
        const evmMessage = { outgoingMessagePubkey: pubkeyBytes32, nonce, sender: senderBytes32, gasLimit: 100_000n, ty, data };

        const tx = await walletClient.writeContract({
            address: BRIDGE_CONTRACT, abi: BRIDGE_ABI, functionName: "relayMessages", args: [[evmMessage]]
        });

        console.log(`   TX: ${tx}`);
        console.log(`   https://sepolia.basescan.org/tx/${tx}`);
        return true;

    } catch (error: any) {
        console.error(`   Error: ${error.message}`);
        return false;
    }
}

async function registerMessage(solNonce: bigint, innerHash: Hex, pubkeyBytes32: Hex): Promise<void> {
    const validatorNonce = await publicClient.readContract({ address: BRIDGE_VALIDATOR, abi: BRIDGE_VALIDATOR_ABI, functionName: "nextNonce" });

    // Sync nonces if needed
    if (validatorNonce !== solNonce) {
        console.log(`   Syncing nonces ${validatorNonce} → ${solNonce}...`);
        for (let n = Number(validatorNonce); n < Number(solNonce); n++) {
            const dummyInnerHash = keccak256(encodeAbiParameters([{ type: "uint256" }], [BigInt(n)]));
            const dummyPubkey = "0x" + "00".repeat(32) as Hex;
            const dummyMessageHash = keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }], [BigInt(n), dummyPubkey, dummyInnerHash]));
            const encodedDummy = encodeAbiParameters([{ type: "bytes32[]" }], [[dummyMessageHash]]);
            const dummySig = await account.signMessage({ message: { raw: encodedDummy } });
            await walletClient.writeContract({ address: BRIDGE_VALIDATOR, abi: BRIDGE_VALIDATOR_ABI, functionName: "registerMessages", args: [[{ innerMessageHash: dummyInnerHash, outgoingMessagePubkey: dummyPubkey }], dummySig] });
            console.log(`   Synced nonce ${n}`);
        }
    }

    const newValidatorNonce = await publicClient.readContract({ address: BRIDGE_VALIDATOR, abi: BRIDGE_VALIDATOR_ABI, functionName: "nextNonce" });
    const validatorMessageHash = keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }], [newValidatorNonce, pubkeyBytes32, innerHash]));
    const encodedHashes = encodeAbiParameters([{ type: "bytes32[]" }], [[validatorMessageHash]]);
    const signature = await account.signMessage({ message: { raw: encodedHashes } });
    const tx = await walletClient.writeContract({ address: BRIDGE_VALIDATOR, abi: BRIDGE_VALIDATOR_ABI, functionName: "registerMessages", args: [[{ innerMessageHash: innerHash, outgoingMessagePubkey: pubkeyBytes32 }], signature] });
    console.log(`   Registered: ${tx}`);
}

function bytes32FromPubkey(pubkey: SolAddress): Hex {
    const bytes = getBase58Encoder().encode(pubkey);
    return toHex(new Uint8Array(bytes)) as Hex;
}

function buildIncomingPayload(outgoing: Awaited<ReturnType<typeof fetchOutgoingMessage>>) {
    const msg = outgoing.data.message;
    if (msg.__kind === "Call") {
        const call = msg.fields[0];
        const evmTo = toHex(new Uint8Array(call.to));
        const data = encodeAbiParameters(
            [{ type: "tuple", components: [{ name: "ty", type: "uint8" }, { name: "to", type: "address" }, { name: "value", type: "uint128" }, { name: "data", type: "bytes" }] }],
            [{ ty: Number(call.ty), to: evmTo, value: BigInt(call.value), data: toHex(new Uint8Array(call.data)) }]
        );
        return { ty: MessageType.Call, data };
    }
    throw new Error("Unsupported message type: " + msg.__kind);
}

// Main
async function main() {
    const messagePubkey = process.argv[2];

    if (messagePubkey) {
        console.log(`\nProcessing specific message: ${messagePubkey}`);
        await processMessage(messagePubkey);
    } else {
        console.log("\n=== Monitoring Mode ===");
        console.log("Pass a message pubkey as argument to relay it.");
        console.log("Example: EVM_PRIVATE_KEY=0x... bun run src/auto-relayer.ts <PUBKEY>\n");

        // Monitor mode - poll and show status
        while (true) {
            const nonce = await publicClient.readContract({ address: BRIDGE_VALIDATOR, abi: BRIDGE_VALIDATOR_ABI, functionName: "nextNonce" });
            console.log(`[${new Date().toISOString()}] Validator nonce: ${nonce}`);
            await new Promise(r => setTimeout(r, 30000));
        }
    }
}

main().catch(console.error);
