import { Connection, PublicKey } from "@solana/web3.js";

const SOLANA_RPC = "https://api.devnet.solana.com";
const conn = new Connection(SOLANA_RPC);

const sig = "4NQskmaquWqomJpy8JCpTddPXhujiVVYdyNwS4rDow18NCs7B9rfc4cXB8fwHQYeLC5EXiRRpLoSveQjsp2ifkAD";

async function main() {
    const tx = await conn.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
    });
    
    if (!tx?.meta?.logMessages) {
        console.log("No logs found");
        return;
    }
    
    console.log("=== Transaction Logs ===");
    for (let i = 0; i < tx.meta.logMessages.length; i++) {
        const log = tx.meta.logMessages[i];
        console.log(`[${i}] ${log}`);
        
        if (log.startsWith("Program data:")) {
            const base64 = log.replace("Program data: ", "");
            const data = Buffer.from(base64, "base64");
            console.log(`    Raw hex (${data.length} bytes): ${data.toString("hex")}`);
            
            if (data.length >= 8 + 32 + 32 + 20 + 16) {
                let offset = 8;
                const vault = new PublicKey(data.subarray(offset, offset + 32));
                offset += 32;
                const owner = new PublicKey(data.subarray(offset, offset + 32));
                offset += 32;
                const destEvmHex = data.subarray(offset, offset + 20).toString("hex");
                offset += 20;
                const handleHex = data.subarray(offset, offset + 16).toString("hex");
                
                console.log(`    Vault: ${vault.toBase58()}`);
                console.log(`    Owner: ${owner.toBase58()}`);
                console.log(`    DestEVM: 0x${destEvmHex}`);
                console.log(`    Handle: ${handleHex}`);
            }
        }
    }
}

main().catch(console.error);
