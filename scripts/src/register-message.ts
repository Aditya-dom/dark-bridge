#!/usr/bin/env bun
/**
 * Manually register a Solana→Base message on the BridgeValidator
 * 
 * This script signs and submits the message hash to the BridgeValidator contract
 */

import { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, toHex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount, signMessage } from "viem/accounts";

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

const BRIDGE_VALIDATOR = "0x9fc354b36a6a1da0c1dBdcE2fc73793eAb6FC462";
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

// Message details from the bridge-call output
const INNER_MESSAGE_HASH = "0x113c1b09a9c71e500b5ffd9a2e19752bf1906e5779c986dab1855b9f6532ba3c" as const;
// FFgJNyWnBbTHfCBri6zQ5KczkxJeD31RQ5JJt8QJa1tC converted to bytes32
const OUTGOING_MESSAGE_PUBKEY = "0xd3c62f3dbb2d5ca16b2d91b975501ebf8b9833f5b749af58da3a86f3f55b9071" as const;

async function main() {
    console.log("=== Manual Message Registration ===\n");

    const account = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);
    console.log(`Signer: ${account.address}`);

    const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http("https://sepolia.base.org"),
    });

    const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http("https://sepolia.base.org"),
    });

    // Get current nonce
    const currentNonce = await publicClient.readContract({
        address: BRIDGE_VALIDATOR,
        abi: BRIDGE_VALIDATOR_ABI,
        functionName: "nextNonce",
    });
    console.log(`Current nonce: ${currentNonce}`);

    // Build message hash for the message we want to register
    // messageHash = keccak256(abi.encode(nonce, outgoingMessagePubkey, innerMessageHash))
    // Note: We need to compute this based on the currentNonce
    const messageHash = keccak256(
        encodeAbiParameters(
            [{ type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
            [currentNonce, OUTGOING_MESSAGE_PUBKEY, INNER_MESSAGE_HASH]
        )
    );
    console.log(`Message hash: ${messageHash}`);

    // Check if already registered
    const isValid = await publicClient.readContract({
        address: BRIDGE_VALIDATOR,
        abi: BRIDGE_VALIDATOR_ABI,
        functionName: "validMessages",
        args: [messageHash],
    });

    if (isValid) {
        console.log("Message already registered!");
        return;
    }

    // Sign the message hashes array
    // The validators sign: toEthSignedMessageHash(abi.encode(messageHashes[]))
    // viem's signMessage already adds the EIP-191 prefix, so we sign abi.encode(messageHashes) as raw bytes
    const encodedHashes = encodeAbiParameters([{ type: "bytes32[]" }], [[messageHash]]);

    // Sign with Ethereum prefix (signMessage adds the prefix automatically)
    const signature = await account.signMessage({
        message: { raw: encodedHashes as `0x${string}` },
    });
    console.log(`Signature: ${signature.slice(0, 20)}...`);

    // Build the signedMessages array
    const signedMessages = [
        {
            innerMessageHash: INNER_MESSAGE_HASH,
            outgoingMessagePubkey: OUTGOING_MESSAGE_PUBKEY,
        },
    ];

    console.log("\nSending registerMessages transaction...");

    try {
        const tx = await walletClient.writeContract({
            address: BRIDGE_VALIDATOR,
            abi: BRIDGE_VALIDATOR_ABI,
            functionName: "registerMessages",
            args: [signedMessages, signature],
        });
        console.log(`Transaction hash: ${tx}`);
        console.log(`Explorer: https://sepolia.basescan.org/tx/${tx}`);
    } catch (error) {
        console.error("Transaction failed:", error);
    }
}

main().catch(console.error);
