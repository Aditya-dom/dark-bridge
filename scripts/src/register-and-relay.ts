#!/usr/bin/env bun
/**
 * Register a specific Solana→Base message on the BridgeValidator and relay it
 * 
 * Usage: EVM_PRIVATE_KEY=0x... bun run src/register-and-relay.ts <solana-pubkey>
 */

import { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, toHex, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createSolanaRpc, getBase58Encoder, getBase58Codec, type Address as SolAddress } from "@solana/kit";
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
] as const;

const BRIDGE_VALIDATOR = "0x9fc354b36a6a1da0c1dBdcE2fc73793eAb6FC462";
const BRIDGE_CONTRACT = "0x8e46419298a9620ea326113baf4019a23594bb11";
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

// See MessageType enum in MessageLib.sol
const MessageType = { Call: 0, Transfer: 1, TransferAndCall: 2 } as const;

async function main() {
    const outgoingPubkey = process.argv[2] || "FFgJNyWnBbTHfCBri6zQ5KczkxJeD31RQ5JJt8QJa1tC";
    console.log("=== Register and Relay Message ===\n");
    console.log(`Message pubkey: ${outgoingPubkey}`);

    const account = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);
    console.log(`Signer: ${account.address}`);

    // Fetch the Solana message
    const solRpc = createSolanaRpc("https://api.devnet.solana.com");
    const outgoing = await fetchOutgoingMessage(solRpc, outgoingPubkey as SolAddress);
    console.log(`Solana message nonce: ${outgoing.data.nonce}`);

    // Build the message components
    const nonce = BigInt(outgoing.data.nonce);
    const senderBytes32 = bytes32FromPubkey(outgoing.data.sender);
    const { ty, data } = buildIncomingPayload(outgoing);

    // Compute inner hash (what the sender and data hash to)
    const innerHash = keccak256(
        encodeAbiParameters(
            [{ type: "bytes32" }, { type: "uint8" }, { type: "bytes" }],
            [senderBytes32, ty, data]
        )
    );
    console.log(`Inner hash: ${innerHash}`);

    // Compute pubkey bytes32
    const pubkeyBytes = getBase58Encoder().encode(outgoing.address);
    const pubkeyBytes32 = toHex(new Uint8Array(pubkeyBytes)) as `0x${string}`;
    console.log(`Pubkey bytes32: ${pubkeyBytes32}`);

    // Compute outer hash (what the relay expects)
    const outerHash = keccak256(
        encodeAbiParameters(
            [{ type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
            [nonce, pubkeyBytes32, innerHash]
        )
    );
    console.log(`Outer hash: ${outerHash}`);

    // Setup clients
    const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http("https://sepolia.base.org"),
    });

    const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http("https://sepolia.base.org"),
    });

    // Check if already registered
    const isValid = await publicClient.readContract({
        address: BRIDGE_VALIDATOR,
        abi: BRIDGE_VALIDATOR_ABI,
        functionName: "validMessages",
        args: [outerHash],
    });

    if (!isValid) {
        console.log("\nMessage not yet registered. Registering...");

        // We need to register with the ACTUAL Solana nonce, not the validator's nextNonce
        // But the validator uses its own incrementing nonce!
        // This means we need to sync the validator nonce to match Solana's

        // For now, compute what message hash the validator WILL create
        const validatorNonce = await publicClient.readContract({
            address: BRIDGE_VALIDATOR,
            abi: BRIDGE_VALIDATOR_ABI,
            functionName: "nextNonce",
        });
        console.log(`Validator next nonce: ${validatorNonce}`);

        // The validator computes: keccak256(abi.encode(validatorNonce, pubkey, innerHash))
        // But we need: keccak256(abi.encode(solana_nonce, pubkey, innerHash))
        // These must match!

        if (validatorNonce !== nonce) {
            console.log(`\n⚠️  WARNING: Nonce mismatch!`);
            console.log(`   Validator nonce: ${validatorNonce}`);
            console.log(`   Solana nonce: ${nonce}`);
            console.log(`   Need to register ${Number(nonce) - Number(validatorNonce)} dummy messages first.`);

            // Register dummy messages to sync up nonces
            for (let n = Number(validatorNonce); n < Number(nonce); n++) {
                console.log(`\nRegistering dummy message for nonce ${n}...`);
                const dummyInnerHash = keccak256(encodeAbiParameters([{ type: "uint256" }], [BigInt(n)]));
                const dummyPubkey = "0x" + "00".repeat(32) as `0x${string}`;
                const dummyMessageHash = keccak256(
                    encodeAbiParameters(
                        [{ type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
                        [BigInt(n), dummyPubkey, dummyInnerHash]
                    )
                );

                const encodedDummy = encodeAbiParameters([{ type: "bytes32[]" }], [[dummyMessageHash]]);
                const dummySig = await account.signMessage({ message: { raw: encodedDummy } });

                try {
                    const tx = await walletClient.writeContract({
                        address: BRIDGE_VALIDATOR,
                        abi: BRIDGE_VALIDATOR_ABI,
                        functionName: "registerMessages",
                        args: [[{ innerMessageHash: dummyInnerHash, outgoingMessagePubkey: dummyPubkey }], dummySig],
                    });
                    console.log(`   Registered: ${tx}`);
                } catch (e: any) {
                    console.log(`   Failed: ${e.shortMessage || e.message}`);
                }
            }
        }

        // Now register the actual message
        console.log(`\nRegistering actual message...`);

        // Re-fetch the validator nonce after dummy registrations
        const newValidatorNonce = await publicClient.readContract({
            address: BRIDGE_VALIDATOR,
            abi: BRIDGE_VALIDATOR_ABI,
            functionName: "nextNonce",
        });
        console.log(`Validator nonce after dummies: ${newValidatorNonce}`);

        // The validator will compute the message hash using its own nonce
        const validatorMessageHash = keccak256(
            encodeAbiParameters(
                [{ type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
                [newValidatorNonce, pubkeyBytes32, innerHash]
            )
        );
        console.log(`Validator will compute hash: ${validatorMessageHash}`);

        // Sign the array containing this hash
        const encodedHashes = encodeAbiParameters([{ type: "bytes32[]" }], [[validatorMessageHash]]);
        const signature = await account.signMessage({ message: { raw: encodedHashes } });
        console.log(`Signature: ${signature.slice(0, 20)}...`);

        try {
            const tx = await walletClient.writeContract({
                address: BRIDGE_VALIDATOR,
                abi: BRIDGE_VALIDATOR_ABI,
                functionName: "registerMessages",
                args: [[{ innerMessageHash: innerHash, outgoingMessagePubkey: pubkeyBytes32 }], signature],
            });
            console.log(`Registration tx: ${tx}`);
        } catch (e: any) {
            console.error(`Registration failed: ${e.shortMessage || e.message}`);
            throw e;
        }
    } else {
        console.log("Message already registered!");
    }

    // Now relay the message
    console.log("\nRelaying message to Base...");
    const evmMessage = {
        outgoingMessagePubkey: pubkeyBytes32,
        nonce,
        sender: senderBytes32,
        gasLimit: 100_000n,
        ty,
        data,
    };

    try {
        const tx = await walletClient.writeContract({
            address: BRIDGE_CONTRACT,
            abi: BRIDGE_ABI,
            functionName: "relayMessages",
            args: [[evmMessage]],
        });
        console.log(`Relay tx: ${tx}`);
        console.log(`Explorer: https://sepolia.basescan.org/tx/${tx}`);
    } catch (e: any) {
        console.error(`Relay failed: ${e.shortMessage || e.message}`);
        if (e.cause) console.error(`Cause:`, e.cause);
        console.error(`Full message data:`, JSON.stringify(evmMessage, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    }
}

function bytes32FromPubkey(pubkey: SolAddress): Hex {
    const bytes = getBase58Encoder().encode(pubkey);
    let hex = toHex(new Uint8Array(bytes));
    return hex as Hex;
}

function buildIncomingPayload(outgoing: Awaited<ReturnType<typeof fetchOutgoingMessage>>) {
    const msg = outgoing.data.message;

    if (msg.__kind === "Call") {
        const call = msg.fields[0];
        const ty = MessageType.Call;
        const data = encodeCallData(call);
        return { ty, data };
    }

    throw new Error("Unsupported message type: " + msg.__kind);
}

function encodeCallData(call: Call): Hex {
    const evmTo = toHex(new Uint8Array(call.to));
    return encodeAbiParameters(
        [{
            type: "tuple",
            components: [
                { name: "ty", type: "uint8" },
                { name: "to", type: "address" },
                { name: "value", type: "uint128" },
                { name: "data", type: "bytes" },
            ],
        }],
        [{
            ty: Number(call.ty),
            to: evmTo,
            value: BigInt(call.value),
            data: toHex(new Uint8Array(call.data)),
        }]
    );
}

main().catch(console.error);
