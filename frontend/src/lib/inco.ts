// Inco SDK integration per SKILL.md
import { Lightning } from "@inco/js/lite";
import { handleTypes } from "@inco/js";
import { CONFIDENTIAL_BRIDGE_ADDRESS, INCO_PEPPER, BASE_CHAIN_ID } from "./constants";

let zapInstance: Awaited<ReturnType<typeof Lightning.latest>> | null = null;

export async function getZap() {
    if (!zapInstance) {
        // Initialize with devnet pepper to match contract's Lib.sol
        zapInstance = await Lightning.latest(INCO_PEPPER, BASE_CHAIN_ID);
    }
    return zapInstance;
}

export async function encryptAmount(
    amount: bigint,
    accountAddress: string
): Promise<string> {
    const zap = await getZap();

    const encrypted = await zap.encrypt(amount, {
        accountAddress: accountAddress as `0x${string}`,
        dappAddress: CONFIDENTIAL_BRIDGE_ADDRESS,
        handleType: handleTypes.euint256,
    });

    // Return as hex string
    return typeof encrypted === "string"
        ? encrypted.startsWith("0x")
            ? encrypted
            : `0x${encrypted}`
        : `0x${Buffer.from(encrypted).toString("hex")}`;
}

export async function encryptAddress(
    address: string,
    accountAddress: string
): Promise<string> {
    const zap = await getZap();

    // Convert address to BigInt for euint160
    const addressAsBigInt = BigInt(address);

    const encrypted = await zap.encrypt(addressAsBigInt, {
        accountAddress: accountAddress as `0x${string}`,
        dappAddress: CONFIDENTIAL_BRIDGE_ADDRESS,
        handleType: handleTypes.euint160,
    });

    return typeof encrypted === "string"
        ? encrypted.startsWith("0x")
            ? encrypted
            : `0x${encrypted}`
        : `0x${Buffer.from(encrypted).toString("hex")}`;
}

export async function attestedDecrypt(
    walletClient: unknown,
    handles: string[]
): Promise<{ value: bigint; signatures: unknown }[]> {
    const zap = await getZap();

    const results = await zap.attestedDecrypt(
        walletClient as Parameters<typeof zap.attestedDecrypt>[0],
        handles as `0x${string}`[]
    );

    return results.map((r) => ({
        value: r.plaintext.value as bigint,
        signatures: r.covalidatorSignatures,
    }));
}

export { handleTypes };
