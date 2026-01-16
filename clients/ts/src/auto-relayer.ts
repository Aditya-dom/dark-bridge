/**
 * Automated Relayer Watcher
 * 
 * Watches for outgoing messages on Solana and automatically:
 * 1. Signs the message as validator
 * 2. Registers it on BridgeValidator
 * 3. Relays it to the Bridge for execution
 * 
 * Run: EVM_PRIVATE_KEY=0x... bun run src/auto-relayer.ts
 */

import { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, toHex, padHex, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createSolanaRpc, getBase58Encoder, type Address as SolAddress } from '@solana/kit';
import { fetchBridge, fetchOutgoingMessage } from './bridge/generated';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
    // Base Sepolia contracts (latest deployment)
    bridgeValidator: '0x9fc354b36a6a1da0c1dBdcE2fc73793eAb6FC462' as const,
    bridge: '0x8e46419298a9620ea326113baf4019a23594bb11' as const,

    // Solana
    solanaRpc: 'https://api.devnet.solana.com',
    solanaBridgeProgram: 'EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9',
    solanaBridgeAccount: '3rwf6Bm2mppj4h9kokESadWnWHFnuBC6jthyqbQFvkZH',

    // Polling
    pollIntervalMs: 5000,
};

// ============================================================================
// ABIs
// ============================================================================

const BRIDGE_VALIDATOR_ABI = [
    {
        name: 'registerMessages',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            {
                name: 'signedMessages',
                type: 'tuple[]',
                components: [
                    { name: 'innerMessageHash', type: 'bytes32' },
                    { name: 'outgoingMessagePubkey', type: 'bytes32' }
                ]
            },
            { name: 'validatorSigs', type: 'bytes' }
        ],
        outputs: []
    },
    {
        name: 'nextNonce',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'uint256' }]
    },
    {
        name: 'validMessages',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'messageHash', type: 'bytes32' }],
        outputs: [{ type: 'bool' }]
    }
] as const;

const BRIDGE_ABI = [
    {
        name: 'relayMessages',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            {
                name: 'messages',
                type: 'tuple[]',
                components: [
                    { name: 'outgoingMessagePubkey', type: 'bytes32' },
                    { name: 'nonce', type: 'uint64' },
                    { name: 'sender', type: 'bytes32' },
                    { name: 'gasLimit', type: 'uint64' },
                    { name: 'ty', type: 'uint8' },
                    { name: 'data', type: 'bytes' }
                ]
            }
        ],
        outputs: []
    },
    {
        name: 'successes',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'messageHash', type: 'bytes32' }],
        outputs: [{ type: 'bool' }]
    }
] as const;

const MessageType = {
    Call: 0,
    Transfer: 1,
    TransferAndCall: 2,
} as const;

// ============================================================================
// Helpers
// ============================================================================

function bytes32FromPubkey(pubkey: string): Hex {
    const bytes = getBase58Encoder().encode(pubkey);
    let hex = toHex(new Uint8Array(bytes));
    if (hex.length !== 66) {
        hex = padHex(hex, { size: 32 });
    }
    return hex as Hex;
}

function computeInnerHash(sender: Hex, ty: number, data: Hex): Hex {
    return keccak256(
        encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes' }],
            [sender, ty, data]
        )
    );
}

function computeOuterHash(nonce: bigint, outgoingMessagePubkey: Hex, innerHash: Hex): Hex {
    return keccak256(
        encodeAbiParameters(
            [{ type: 'uint64' }, { type: 'bytes32' }, { type: 'bytes32' }],
            [nonce, outgoingMessagePubkey, innerHash]
        )
    );
}

// ============================================================================
// Message Processing
// ============================================================================

interface ProcessedMessage {
    outgoingPubkey: string;
    solananNonce: number;
    validatorNonce: bigint;
    registeredHash: Hex;
}

const processedMessages = new Map<string, ProcessedMessage>();

async function processOutgoingMessage(
    outgoingPubkey: string,
    solRpc: ReturnType<typeof createSolanaRpc>,
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    account: ReturnType<typeof privateKeyToAccount>
): Promise<boolean> {
    // Skip if already processed
    if (processedMessages.has(outgoingPubkey)) {
        return false;
    }

    console.log(`\n📨 Processing message: ${outgoingPubkey}`);

    try {
        // Fetch message from Solana
        const outgoing = await fetchOutgoingMessage(solRpc, outgoingPubkey as SolAddress);
        const solananNonce = Number(outgoing.data.nonce);
        console.log(`   Solana nonce: ${solananNonce}`);

        // Build message data
        const senderBytes32 = bytes32FromPubkey(outgoing.data.sender);
        const outgoingPubkeyBytes32 = bytes32FromPubkey(outgoingPubkey);

        const msg = outgoing.data.message;
        let ty: number;
        let data: Hex;

        if (msg.__kind === 'Transfer') {
            const transfer = msg.fields[0];
            ty = MessageType.Transfer;

            const transferTuple = {
                localToken: `0x${toHex(new Uint8Array(transfer.remoteToken)).slice(2)}` as Hex,
                remoteToken: bytes32FromPubkey(transfer.localToken),
                to: padHex(`0x${toHex(new Uint8Array(transfer.to)).slice(2)}` as Hex, { size: 32, dir: 'right' }),
                remoteAmount: BigInt(transfer.amount),
            };

            data = encodeAbiParameters(
                [{
                    type: 'tuple',
                    components: [
                        { name: 'localToken', type: 'address' },
                        { name: 'remoteToken', type: 'bytes32' },
                        { name: 'to', type: 'bytes32' },
                        { name: 'remoteAmount', type: 'uint64' },
                    ],
                }],
                [transferTuple]
            );
        } else if (msg.__kind === 'Call') {
            ty = MessageType.Call;
            const call = msg.fields[0];
            data = encodeAbiParameters(
                [{
                    type: 'tuple',
                    components: [
                        { name: 'ty', type: 'uint8' },
                        { name: 'to', type: 'address' },
                        { name: 'value', type: 'uint128' },
                        { name: 'data', type: 'bytes' },
                    ],
                }],
                [{
                    ty: Number(call.ty),
                    to: toHex(new Uint8Array(call.to)) as Hex,
                    value: BigInt(call.value),
                    data: toHex(new Uint8Array(call.data)) as Hex,
                }]
            );
        } else {
            console.log(`   ⚠️ Unsupported message type: ${msg.__kind}`);
            return false;
        }

        // Compute inner hash
        const innerHash = computeInnerHash(senderBytes32, ty, data);
        console.log(`   Inner hash: ${innerHash.slice(0, 20)}...`);

        // Get validator nonce
        const validatorNonce = await publicClient.readContract({
            address: CONFIG.bridgeValidator,
            abi: BRIDGE_VALIDATOR_ABI,
            functionName: 'nextNonce',
        }) as bigint;
        console.log(`   Validator nonce: ${validatorNonce}`);

        // Compute outer hash using validator's nonce
        const outerHash = computeOuterHash(validatorNonce, outgoingPubkeyBytes32, innerHash);
        console.log(`   Outer hash: ${outerHash.slice(0, 20)}...`);

        // Check if already registered
        const alreadyValid = await publicClient.readContract({
            address: CONFIG.bridgeValidator,
            abi: BRIDGE_VALIDATOR_ABI,
            functionName: 'validMessages',
            args: [outerHash],
        });

        if (alreadyValid) {
            console.log(`   ✅ Already registered`);
            processedMessages.set(outgoingPubkey, {
                outgoingPubkey,
                solananNonce,
                validatorNonce,
                registeredHash: outerHash,
            });
            return true;
        }

        // Sign the message
        const signedMessages = [{
            innerMessageHash: innerHash,
            outgoingMessagePubkey: outgoingPubkeyBytes32,
        }];

        const messageHashes = [outerHash];
        const encodedHashes = encodeAbiParameters(
            [{ type: 'bytes32[]' }],
            [messageHashes]
        );

        const signature = await account.signMessage({
            message: { raw: encodedHashes }
        });
        console.log(`   Signed message`);

        // Register on validator
        console.log(`   ⏳ Registering on BridgeValidator...`);
        const registerTx = await walletClient.writeContract({
            address: CONFIG.bridgeValidator,
            abi: BRIDGE_VALIDATOR_ABI,
            functionName: 'registerMessages',
            args: [signedMessages, signature],
        });

        await publicClient.waitForTransactionReceipt({ hash: registerTx });
        console.log(`   ✅ Registered: ${registerTx.slice(0, 20)}...`);

        // Store processed
        processedMessages.set(outgoingPubkey, {
            outgoingPubkey,
            solananNonce,
            validatorNonce,
            registeredHash: outerHash,
        });
                                                                                         
        // Now relay to Bridge if nonces match
        const expectedBridgeHash = computeOuterHash(BigInt(solananNonce), outgoingPubkeyBytes32, innerHash);

        const bridgeHashValid = await publicClient.readContract({
            address: CONFIG.bridgeValidator,
            abi: BRIDGE_VALIDATOR_ABI,
            functionName: 'validMessages',
            args: [expectedBridgeHash],
        });

        if (bridgeHashValid) {
            console.log(`   ⏳ Relaying to Bridge...`);

            const evmMessage = {
                outgoingMessagePubkey: outgoingPubkeyBytes32,
                nonce: BigInt(solananNonce),
                sender: senderBytes32,
                gasLimit: 100000n,
                ty,
                data,
            };

            try {
                const relayTx = await walletClient.writeContract({
                    address: CONFIG.bridge,
                    abi: BRIDGE_ABI,
                    functionName: 'relayMessages',
                    args: [[evmMessage]],
                });

                await publicClient.waitForTransactionReceipt({ hash: relayTx });
                console.log(`   ✅ Relayed to Bridge: ${relayTx.slice(0, 20)}...`);
            } catch (err: any) {
                console.log(`   ⚠️ Relay failed (may need more registrations): ${err.message?.slice(0, 50)}`);
            }
        } else {
            console.log(`   ℹ️ Nonce mismatch - need more registrations to align`);
        }

        return true;
    } catch (err: any) {
        console.log(`   ❌ Error: ${err.message?.slice(0, 100)}`);
        return false;
    }
}

// ============================================================================
// Main Watcher Loop
// ============================================================================

async function main() {
    const privateKey = process.env.EVM_PRIVATE_KEY || process.env.PRIVATE_KEY;
    if (!privateKey) {
        console.error('❌ Set EVM_PRIVATE_KEY or PRIVATE_KEY environment variable');
        process.exit(1);
    }

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('        🔄 Automated Relayer Watcher                            ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const account = privateKeyToAccount(privateKey as Hex);
    console.log(`📍 Validator: ${account.address}`);
    console.log(`📍 Watching Solana bridge: ${CONFIG.solanaBridgeAccount}`);
    console.log(`📍 Base Bridge: ${CONFIG.bridge}`);
    console.log(`📍 Polling every ${CONFIG.pollIntervalMs / 1000}s\n`);

    const solRpc = createSolanaRpc(CONFIG.solanaRpc);

    const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http('https://sepolia.base.org'),
    });

    const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http('https://sepolia.base.org'),
    });

    // Track last seen outgoing message count
    let lastMessageCount = 0;

    console.log('🔍 Watching for outgoing messages...\n');

    while (true) {
        try {
            // Fetch bridge state to get message count
            const bridge = await fetchBridge(solRpc, CONFIG.solanaBridgeAccount as SolAddress);
            const currentMessageCount = Number(bridge.data.outgoingMsgCount);

            if (currentMessageCount > lastMessageCount) {
                console.log(`📬 New messages detected! Count: ${lastMessageCount} -> ${currentMessageCount}`);

                // In a real implementation, you'd track outgoing message PDAs
                // For now, we'll rely on users providing message pubkeys
                lastMessageCount = currentMessageCount;
            }

        } catch (err: any) {
            console.log(`⚠️ Poll error: ${err.message?.slice(0, 50)}`);
        }

        await new Promise(r => setTimeout(r, CONFIG.pollIntervalMs));
    }
}

// Export for external use
export async function relayMessage(outgoingPubkey: string) {
    const privateKey = process.env.EVM_PRIVATE_KEY || process.env.PRIVATE_KEY;
    if (!privateKey) {
        throw new Error('Set EVM_PRIVATE_KEY or PRIVATE_KEY environment variable');
    }

    const account = privateKeyToAccount(privateKey as Hex);
    const solRpc = createSolanaRpc(CONFIG.solanaRpc);

    const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http('https://sepolia.base.org'),
    });

    const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http('https://sepolia.base.org'),
    });

    return processOutgoingMessage(outgoingPubkey, solRpc, publicClient, walletClient, account);
}

// Run if called directly
if (import.meta.main) {
    main().catch(console.error);
}
