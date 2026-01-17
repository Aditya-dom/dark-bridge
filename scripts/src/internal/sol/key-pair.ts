import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  createKeyPairFromBytes,
  createSignerFromKeyPair,
  type KeyPairSigner,
} from "@solana/kit";

let solanaCliConfigKeypairCache: KeyPairSigner | null = null;
export async function getSolanaCliConfigKeypairSigner() {
  if (solanaCliConfigKeypairCache) {
    return solanaCliConfigKeypairCache;
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
