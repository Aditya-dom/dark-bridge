import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  createKeyPairFromBytes,
  createSignerFromKeyPair,
  type KeyPairSigner,
  type Address,
} from "@solana/kit";
import { Keypair } from "@solana/web3.js";

// Export the raw Keypair for use with @solana/web3.js transactions
let solanaWeb3KeypairCache: Keypair | null = null;
export function getSolanaWeb3Keypair(): Keypair {
  if (solanaWeb3KeypairCache) {
    return solanaWeb3KeypairCache;
  }

  if (process.env.SOLANA_PRIVATE_KEY) {
    const keypairBytes = new Uint8Array(JSON.parse(process.env.SOLANA_PRIVATE_KEY));
    solanaWeb3KeypairCache = Keypair.fromSecretKey(keypairBytes, { skipValidation: true });
    console.log(`🔑 Loaded Solana Keypair from SOLANA_PRIVATE_KEY: ${solanaWeb3KeypairCache.publicKey.toBase58()}`);
    return solanaWeb3KeypairCache;
  }

  const keypairPath = join(homedir(), ".config/solana/id.json");
  if (!existsSync(keypairPath)) {
    throw new Error(`SOLANA_PRIVATE_KEY env var not set and no keypair at: ${keypairPath}`);
  }
  
  const keypairBytes = new Uint8Array(JSON.parse(require("fs").readFileSync(keypairPath, "utf-8")));
  solanaWeb3KeypairCache = Keypair.fromSecretKey(keypairBytes);
  return solanaWeb3KeypairCache;
}

let solanaCliConfigKeypairCache: KeyPairSigner | null = null;
export async function getSolanaCliConfigKeypairSigner() {
  if (solanaCliConfigKeypairCache) {
    return solanaCliConfigKeypairCache;
  }

  // First, check for SOLANA_PRIVATE_KEY environment variable
  if (process.env.SOLANA_PRIVATE_KEY) {
    const keypairBytes = new Uint8Array(JSON.parse(process.env.SOLANA_PRIVATE_KEY));
    // Create keypair and signer - try with skipValidation first
    try {
      const keypair = await createKeyPairFromBytes(keypairBytes);
      const signer = await createSignerFromKeyPair(keypair);
      solanaCliConfigKeypairCache = signer;
      console.log(`🔑 Loaded Solana signer from SOLANA_PRIVATE_KEY env var: ${signer.address}`);
      return solanaCliConfigKeypairCache;
    } catch (e) {
      // If createKeyPairFromBytes fails validation, create a minimal signer
      const web3Keypair = Keypair.fromSecretKey(keypairBytes, { skipValidation: true });
      const address = web3Keypair.publicKey.toBase58() as Address;
      // Return a minimal object that has the address - transactions will use web3.js directly
      solanaCliConfigKeypairCache = { address } as any;
      console.log(`🔑 Loaded Solana address from SOLANA_PRIVATE_KEY env var (web3.js mode): ${address}`);
      return solanaCliConfigKeypairCache;
    }
  }

  const homeDir = homedir();
  const configPath = join(homeDir, ".config/solana/cli/config.yml");

  // Try to read the actual Solana CLI config to get the keypair path
  let keypairPath = join(homeDir, ".config/solana/id.json"); // fallback

  if (existsSync(configPath)) {
    const configContent = await Bun.file(configPath).text();
    const keypairMatch = configContent.match(/^keypair_path:\s*(.+)$/im);
    if (keypairMatch) {
      keypairPath = keypairMatch[1].trim();
    }
  }

  if (!existsSync(keypairPath)) {
    throw new Error(`Solana CLI config keypair not found at: ${keypairPath}`);
  }

  solanaCliConfigKeypairCache = await getKeypairSignerFromPath(keypairPath);
  return solanaCliConfigKeypairCache;
}

const keypairSignerCache = new Map<string, KeyPairSigner>();
export async function getKeypairSignerFromPath(keypairPath: string) {
  if (keypairSignerCache.has(keypairPath)) {
    return keypairSignerCache.get(keypairPath)!;
  }

  if (!existsSync(keypairPath)) {
    throw new Error(`Keypair not found at: ${keypairPath}`);
  }

  const keypairBytes = new Uint8Array(await Bun.file(keypairPath).json());
  const keypair = await createKeyPairFromBytes(keypairBytes);
  const signer = await createSignerFromKeyPair(keypair);
  keypairSignerCache.set(keypairPath, signer);

  return signer;
}
